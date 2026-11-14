// Tower Control Center — bot agent core (Node.js ≥ 22, zero dependencies).
//
// Runs inside an existing bot process and opens ONE outbound WebSocket to the
// Tower Control Center backend. No inbound port is needed, which is what makes
// it work on hosts such as Wispbyte.
//
// It never runs unless both TCC_URL and TCC_AGENT_SECRET are set, and nothing in
// here may throw into the bot: a broken agent must never take a bot down.
//
// Security model
//   * Mutual HMAC-SHA256 authentication (challenge/response) with a per-bot secret.
//   * Every command is individually signed and carries a timestamp and a unique
//     id; stale or repeated commands are refused (replay protection).
//   * Only the commands registered below (plus the bot adapter's own) exist.
//     There is no shell, no eval and no "run arbitrary code" command.
//   * File access is jailed to the bot folder and refuses secrets (.env, keys,
//     databases, node_modules, .git).

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const AGENT_VERSION = '1.0.0';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (secret, data) => createHmac('sha256', secret).update(data).digest('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

class AgentError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export const fail = (code, message) => { throw new AgentError(code, message); };

const DENIED = [
  /(^|\/)\.env(\..*)?$/i, /(^|\/)node_modules(\/|$)/, /(^|\/)\.git(\/|$)/, /(^|\/)\.tcc(\/|$)/,
  /(^|\/)__pycache__(\/|$)/, /\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/i, /\.(pem|key|p12|pfx)$/i,
];
const MAX_FILE = 2 * 1024 * 1024;
const TEXT_EXT = /\.(js|mjs|cjs|ts|json|md|txt|py|yml|yaml|toml|ini|cfg|bat|sh|ps1|html|css|svg|example|gitignore|dockerignore)$/i;

const stateDir = (root) => path.join(root, '.tcc');
const readJson = (file, fallback) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writeJson = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
};

/** Resolves a relative POSIX path inside `root`, refusing traversal, symlink escapes and protected files. */
export function jail(root, raw, { allowRoot = false } = {}) {
  const rel = String(raw ?? '').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (rel === '' && allowRoot) return { rel: '', abs: root };
  if (!rel || rel.length > 300 || rel.includes('\\') || rel.includes('\0') || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) {
    fail('invalid_path', 'Invalid path.');
  }
  if (rel.split('/').some((s) => s === '..' || s === '.' || s === '')) fail('invalid_path', 'Invalid path.');
  if (DENIED.some((re) => re.test(rel))) fail('protected_path', 'This path is protected.');
  const abs = path.join(root, ...rel.split('/'));
  // A symlink inside the folder must not lead outside of it.
  let probe = abs;
  while (!existsSync(probe)) probe = path.dirname(probe);
  const real = realpathSync(probe);
  const realRoot = realpathSync(root);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) fail('invalid_path', 'Path escapes the bot folder.');
  return { rel, abs };
}

// ── SQLite helpers (node:sqlite, built into Node ≥ 22.5) ─────────────────────

async function sqlite() {
  try { return await import('node:sqlite'); } catch { return null; }
}

async function dbHealth(databases) {
  const lib = await sqlite();
  const out = [];
  for (const d of databases) {
    const item = { name: d.name, exists: existsSync(d.path), sizeBytes: null, ok: null, detail: null };
    if (item.exists) {
      item.sizeBytes = statSync(d.path).size;
      if (!lib) item.detail = 'node:sqlite is unavailable on this runtime';
      else if (item.sizeBytes > 256 * 1024 * 1024) item.detail = 'skipped integrity check (file larger than 256 MB)';
      else {
        try {
          const db = new lib.DatabaseSync(d.path, { readOnly: true });
          try {
            const row = db.prepare('PRAGMA quick_check').get();
            const verdict = String(Object.values(row ?? {})[0] ?? '');
            item.ok = verdict === 'ok';
            item.detail = verdict;
            item.tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
          } finally { db.close(); }
        } catch (error) { item.ok = false; item.detail = String(error.message); }
      }
    } else item.detail = 'file not created yet';
    out.push(item);
  }
  return out;
}

// ── Boot guard ───────────────────────────────────────────────────────────────

function restoreSnapshot(root, id) {
  const dir = path.join(stateDir(root), 'deploy', id);
  const meta = readJson(path.join(dir, 'meta.json'), null);
  if (!meta?.snapshot) fail('no_snapshot', 'No snapshot exists for this deployment.');
  let restored = 0;
  for (const entry of meta.snapshot) {
    const target = path.join(root, ...entry.path.split('/'));
    if (entry.existed) {
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(dir, 'old', ...entry.path.split('/')), target);
    } else rmSync(target, { force: true });
    restored += 1;
  }
  return restored;
}

/**
 * Call synchronously at the very top of the bot's entry file, BEFORE the bot
 * opens its databases or imports its own modules.
 *   1. Swaps in database files staged by a restore.
 *   2. If the last deployment was never confirmed healthy and the process has
 *      now started more than twice, puts the previous files back.
 */
export function bootGuard({ root }) {
  const notes = [];
  try {
    const dir = stateDir(root);
    const pendingFile = path.join(dir, 'restore', 'pending.json');
    const pending = readJson(pendingFile, null);
    if (Array.isArray(pending) && pending.length > 0) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      for (const item of pending) {
        try {
          const staged = path.join(dir, 'restore', item.staged);
          if (!existsSync(staged) || sha256(readFileSync(staged)) !== item.sha256) {
            notes.push(`restore of ${item.name} skipped: staged file missing or corrupt`);
            continue;
          }
          const keep = path.join(dir, 'restore', `previous-${stamp}`);
          mkdirSync(keep, { recursive: true });
          for (const suffix of ['', '-wal', '-shm', '-journal']) {
            if (existsSync(item.path + suffix)) renameSync(item.path + suffix, path.join(keep, path.basename(item.path) + suffix));
          }
          mkdirSync(path.dirname(item.path), { recursive: true });
          renameSync(staged, item.path);
          notes.push(`restored database ${item.name}`);
        } catch (error) { notes.push(`restore of ${item.name} failed: ${error.message}`); }
      }
      rmSync(pendingFile, { force: true });
    }

    const stateFile = path.join(dir, 'deploy', 'state.json');
    const state = readJson(stateFile, null);
    if (state?.status === 'pending') {
      state.boots = (state.boots ?? 0) + 1;
      if (state.boots > 2) {
        try {
          restoreSnapshot(root, state.id);
          state.status = 'auto_rolled_back';
          notes.push(`deployment ${state.id} never became healthy: previous files restored`);
        } catch (error) {
          state.status = 'rollback_failed';
          notes.push(`automatic rollback failed: ${error.message}`);
        }
      }
      writeJson(stateFile, state);
    }
  } catch (error) {
    notes.push(`boot guard error: ${error.message}`);
  }
  for (const n of notes) console.log(`[tcc] ${n}`);
  globalThis.__tccBootNotes = notes;
  return notes;
}

// ── Agent ────────────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {string} o.botId             'ebot1' | 'tower' | 'alkabus'
 * @param {string} o.root              bot folder (file jail)
 * @param {() => {name:string,path:string}[]} o.databases
 * @param {Record<string, (args:any) => any>} [o.commands]  bot-specific commands
 * @param {() => object} [o.heartbeat] extra heartbeat fields (discordReady, pingMs, guilds, …)
 * @param {() => object} [o.info]      static description sent at connect
 * @param {() => void|Promise<void>} [o.beforeExit] flush work before a restart
 */
export function startAgent(o) {
  const env = o.env ?? process.env;
  const url = env.TCC_URL?.trim();
  const secretFile = path.join(stateDir(o.root), 'agent.json');
  let secret = readJson(secretFile, {}).secret || env.TCC_AGENT_SECRET?.trim();
  if (!url || !secret) return null; // integration not configured: the bot runs exactly as before
  if (!/^wss:\/\//.test(url) && !/^ws:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) {
    console.warn('[tcc] TCC_URL must be wss:// (ws:// is accepted for localhost only). Agent disabled.');
    return null;
  }

  const startedAt = Date.now();
  const databases = () => { try { return o.databases?.() ?? []; } catch { return []; } };
  const logs = [];
  const outbox = [];
  const seen = new Map();
  const transfers = new Map();
  let ws = null;
  let authed = false;
  let attempt = 0;
  let stopped = false;
  let lastCpu = process.cpuUsage();
  let lastCpuAt = Date.now();
  let commandCount = 0;

  // Capture console output without changing what the bot prints.
  const scrub = (text) => String(text)
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/[MNO][A-Za-z\d_-]{23,25}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}/g, '[redacted-token]')
    .replace(/(token|secret|password|api[_-]?key)(["'\s:=]+)[^\s"',}]{6,}/gi, '$1$2[redacted]')
    .slice(0, 4000);
  const format = (args) => args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
  let logBudget = 40;
  setInterval(() => { logBudget = 40; }, 2000).unref();
  for (const [method, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      try {
        const message = scrub(format(args));
        if (!message || message.startsWith('[tcc]')) return;
        const lvl = /\bERROR\b/.test(message.slice(0, 40)) ? 'error' : /\bWARN\b/.test(message.slice(0, 40)) ? 'warn' : level;
        const entry = { ts: Date.now(), level: lvl, message };
        logs.push(entry);
        if (logs.length > 500) logs.shift();
        if (logBudget-- > 0) push({ t: 'log', ...entry });
      } catch { /* logging must never break the bot */ }
    };
  }

  function push(frame) {
    if (ws && authed && ws.readyState === 1) {
      try { ws.send(JSON.stringify(frame)); return; } catch { /* fall through to the queue */ }
    }
    if (frame.t !== 'hb') { outbox.push(frame); if (outbox.length > 300) outbox.shift(); }
  }

  function heartbeat() {
    const now = Date.now();
    const cpu = process.cpuUsage(lastCpu);
    const elapsed = Math.max(1, now - lastCpuAt);
    lastCpu = process.cpuUsage();
    lastCpuAt = now;
    let extra = {};
    try { extra = o.heartbeat?.() ?? {}; } catch { /* keep the base heartbeat */ }
    push({
      t: 'hb',
      data: {
        uptimeSec: Math.round((now - startedAt) / 1000),
        // Measured for this bot process only (not the whole container).
        rssMb: Math.round((process.memoryUsage.rss() / 1048576) * 10) / 10,
        cpuPct: Math.round(((cpu.user + cpu.system) / 1000 / elapsed) * 1000) / 10,
        commands: commandCount,
        agentVersion: AGENT_VERSION,
        ...extra,
      },
    });
  }

  // ── Built-in commands ──────────────────────────────────────────────────────

  const core = {
    'agent.ping': () => ({ pong: Date.now() }),

    'agent.rotateSecret': ({ secret: next }) => {
      if (typeof next !== 'string' || next.length < 32) fail('invalid_secret', 'Secret too short.');
      writeJson(secretFile, { secret: next, rotatedAt: new Date().toISOString() });
      secret = next;
      return { persisted: true };
    },

    'logs.tail': ({ limit = 200 }) => logs.slice(-Math.min(500, Math.max(1, Number(limit) || 200))),

    'db.health': () => dbHealth(databases()),

    // Consistent snapshot: VACUUM INTO writes a transactionally complete copy, WAL included.
    'db.backup.begin': async () => {
      const lib = await sqlite();
      if (!lib) fail('unsupported', 'node:sqlite is unavailable on this runtime.');
      const id = randomBytes(8).toString('hex');
      const snapshot = (dir) => {
        mkdirSync(dir, { recursive: true });
        const list = [];
        for (const d of databases()) {
          if (!existsSync(d.path)) continue;
          const out = path.join(dir, `${d.name}.sqlite`);
          const db = new lib.DatabaseSync(d.path);
          try { db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`); } finally { db.close(); }
          const buf = readFileSync(out);
          list.push({ name: d.name, size: buf.length, sha256: sha256(buf) });
        }
        return list;
      };
      // Next to the bot by default (same disk). If that folder cannot be written, fall back to the OS temp folder.
      let dir = path.join(stateDir(o.root), 'backup', id);
      let files;
      try {
        files = snapshot(dir);
      } catch {
        rmSync(dir, { recursive: true, force: true });
        dir = path.join(tmpdir(), `tcc-backup-${id}`);
        files = snapshot(dir);
      }
      transfers.set(id, { dir, at: Date.now() });
      return { id, files };
    },
    'db.backup.chunk': ({ id, name, offset, length }) => {
      const t = transfers.get(id);
      if (!t || !databases().some((d) => d.name === name)) fail('unknown_transfer', 'Unknown transfer.');
      const buf = readFileSync(path.join(t.dir, `${name}.sqlite`));
      return { data: buf.subarray(Number(offset), Number(offset) + Math.min(Number(length) || 0, 512 * 1024)).toString('base64') };
    },
    'db.backup.end': ({ id }) => {
      const t = transfers.get(id);
      if (t) { rmSync(t.dir, { recursive: true, force: true }); transfers.delete(id); }
      return { done: true };
    },

    'db.restore.begin': ({ name, size, sha256: digest }) => {
      const target = databases().find((d) => d.name === name);
      if (!target) fail('unknown_database', `This bot has no database named "${name}".`);
      if (!(Number(size) > 0) || Number(size) > 512 * 1024 * 1024) fail('invalid_size', 'Invalid size.');
      const id = randomBytes(8).toString('hex');
      const staged = `${id}-${name}.staged`;
      mkdirSync(path.join(stateDir(o.root), 'restore'), { recursive: true });
      writeFileSync(path.join(stateDir(o.root), 'restore', staged), Buffer.alloc(0));
      transfers.set(id, { restore: true, name, path: target.path, size: Number(size), sha256: String(digest), staged, at: Date.now() });
      return { id };
    },
    'db.restore.chunk': ({ id, offset, data }) => {
      const t = transfers.get(id);
      if (!t?.restore) fail('unknown_transfer', 'Unknown transfer.');
      const file = path.join(stateDir(o.root), 'restore', t.staged);
      if (statSync(file).size !== Number(offset)) fail('bad_offset', 'Chunks must arrive in order.');
      writeFileSync(file, Buffer.from(String(data), 'base64'), { flag: 'a' });
      return { received: statSync(file).size };
    },
    'db.restore.commit': ({ id }) => {
      const t = transfers.get(id);
      if (!t?.restore) fail('unknown_transfer', 'Unknown transfer.');
      const file = path.join(stateDir(o.root), 'restore', t.staged);
      const buf = readFileSync(file);
      if (buf.length !== t.size || sha256(buf) !== t.sha256) { rmSync(file, { force: true }); fail('checksum_mismatch', 'The uploaded database is corrupt.'); }
      if (buf.subarray(0, 15).toString('latin1') !== 'SQLite format 3') { rmSync(file, { force: true }); fail('not_sqlite', 'Not a SQLite database.'); }
      const pendingFile = path.join(stateDir(o.root), 'restore', 'pending.json');
      const pending = readJson(pendingFile, []).filter((p) => p.name !== t.name);
      pending.push({ name: t.name, path: t.path, staged: t.staged, sha256: t.sha256 });
      writeJson(pendingFile, pending);
      transfers.delete(id);
      return { staged: true, appliesOn: 'next start' };
    },

    'fs.list': ({ path: p }) => {
      const { abs, rel } = jail(o.root, p, { allowRoot: true });
      if (!existsSync(abs) || !statSync(abs).isDirectory()) fail('not_found', 'Folder not found.');
      const entries = readdirSync(abs, { withFileTypes: true })
        .filter((e) => !DENIED.some((re) => re.test(rel ? `${rel}/${e.name}` : e.name)) && !e.name.includes('\\'))
        .map((e) => {
          const st = statSync(path.join(abs, e.name), { throwIfNoEntry: false });
          return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: e.isDirectory() ? null : st?.size ?? null, modifiedAt: st?.mtimeMs ?? null };
        })
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      return { entries: entries.slice(0, 2000) };
    },
    'fs.read': ({ path: p, maxBytes = MAX_FILE }) => {
      const { abs } = jail(o.root, p);
      const st = statSync(abs, { throwIfNoEntry: false });
      if (!st?.isFile()) fail('not_found', 'File not found.');
      if (st.size > Math.min(Number(maxBytes) || MAX_FILE, MAX_FILE)) fail('file_too_large', 'File is larger than 2 MB.');
      const buf = readFileSync(abs);
      return { size: buf.length, sha256: sha256(buf), binary: !TEXT_EXT.test(abs) && buf.includes(0), content: buf.toString('base64') };
    },
    'fs.write': ({ path: p, content, sha256: digest, expectedSha256 }) => {
      const { abs, rel } = jail(o.root, p);
      const buf = Buffer.from(String(content), 'base64');
      if (buf.length > MAX_FILE) fail('file_too_large', 'File is larger than 2 MB.');
      if (sha256(buf) !== digest) fail('checksum_mismatch', 'Upload was corrupted in transit.');
      let trashed = null;
      if (existsSync(abs)) {
        if (!statSync(abs).isFile()) fail('not_a_file', 'Target is a folder.');
        const current = readFileSync(abs);
        if (expectedSha256 && sha256(current) !== expectedSha256) fail('conflict', 'The file changed on the host since you opened it.');
        trashed = trash(rel, abs);
      }
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, buf);
      return { size: buf.length, sha256: digest, previousCopy: trashed };
    },
    'fs.mkdir': ({ path: p }) => { mkdirSync(jail(o.root, p).abs, { recursive: true }); return { created: true }; },
    'fs.delete': ({ path: p }) => {
      const { abs, rel } = jail(o.root, p);
      const st = statSync(abs, { throwIfNoEntry: false });
      if (!st) fail('not_found', 'Not found.');
      if (st.isDirectory()) {
        if (readdirSync(abs).length > 0) fail('not_empty', 'Only empty folders can be deleted.');
        rmSync(abs, { recursive: true });
        return { trashed: null };
      }
      const trashed = trash(rel, abs);
      rmSync(abs);
      return { trashed };
    },

    'deploy.begin': ({ id, files }) => {
      if (!/^[0-9a-f-]{36}$/.test(String(id)) || !Array.isArray(files) || files.length === 0 || files.length > 60) fail('invalid_input', 'Invalid deployment.');
      const dir = path.join(stateDir(o.root), 'deploy', id);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(path.join(dir, 'new'), { recursive: true });
      const list = files.map((f) => ({ path: jail(o.root, f.path).rel, sha256: f.sha256 ?? null, delete: Boolean(f.delete) }));
      writeJson(path.join(dir, 'meta.json'), { id, files: list, createdAt: new Date().toISOString() });
      return { ready: true };
    },
    'deploy.file': ({ id, path: p, content, sha256: digest }) => {
      const dir = path.join(stateDir(o.root), 'deploy', String(id));
      const meta = readJson(path.join(dir, 'meta.json'), null);
      const { rel } = jail(o.root, p);
      const entry = meta?.files.find((f) => f.path === rel && !f.delete);
      if (!entry) fail('unexpected_file', 'This file is not part of the deployment.');
      const buf = Buffer.from(String(content), 'base64');
      if (buf.length > MAX_FILE || sha256(buf) !== digest || digest !== entry.sha256) fail('checksum_mismatch', `Integrity check failed for ${rel}.`);
      const target = path.join(dir, 'new', ...rel.split('/'));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, buf);
      return { stored: true };
    },
    'deploy.commit': ({ id }) => {
      const dir = path.join(stateDir(o.root), 'deploy', String(id));
      const meta = readJson(path.join(dir, 'meta.json'), null);
      if (!meta) fail('unknown_deployment', 'Unknown deployment.');
      // 1. integrity of everything that was uploaded
      for (const f of meta.files.filter((x) => !x.delete)) {
        const staged = path.join(dir, 'new', ...f.path.split('/'));
        if (!existsSync(staged) || sha256(readFileSync(staged)) !== f.sha256) fail('checksum_mismatch', `Missing or corrupt upload: ${f.path}`);
      }
      // 2. static checks, before anything live is touched
      let checked = 0;
      for (const f of meta.files.filter((x) => !x.delete)) {
        const staged = path.join(dir, 'new', ...f.path.split('/'));
        const problem = (o.checkFile ?? checkFile)(staged, f.path);
        if (problem) fail('check_failed', `${f.path}: ${problem}`);
        if (problem === null) checked += 1;
      }
      // 3. snapshot the current versions
      meta.snapshot = meta.files.map((f) => {
        const live = path.join(o.root, ...f.path.split('/'));
        const existed = existsSync(live) && statSync(live).isFile();
        if (existed) {
          const keep = path.join(dir, 'old', ...f.path.split('/'));
          mkdirSync(path.dirname(keep), { recursive: true });
          copyFileSync(live, keep);
        }
        return { path: f.path, existed };
      });
      writeJson(path.join(dir, 'meta.json'), meta);
      // 4. swap in. Any failure here restores the snapshot immediately.
      try {
        for (const f of meta.files) {
          const live = path.join(o.root, ...f.path.split('/'));
          if (f.delete) { rmSync(live, { force: true }); continue; }
          mkdirSync(path.dirname(live), { recursive: true });
          copyFileSync(path.join(dir, 'new', ...f.path.split('/')), live);
        }
      } catch (error) {
        restoreSnapshot(o.root, String(id));
        fail('apply_failed', `Could not write files (${error.message}); previous versions restored.`);
      }
      writeJson(path.join(stateDir(o.root), 'deploy', 'state.json'), { id, status: 'pending', boots: 0, at: new Date().toISOString() });
      return { snapshotted: meta.snapshot.filter((s) => s.existed).length, checked, applied: meta.files.length };
    },
    'deploy.confirm': ({ id }) => {
      const file = path.join(stateDir(o.root), 'deploy', 'state.json');
      const state = readJson(file, null);
      if (state?.id === id) writeJson(file, { ...state, status: 'confirmed' });
      return { confirmed: true };
    },
    'deploy.rollback': ({ id }) => {
      const restored = restoreSnapshot(o.root, String(id));
      const file = path.join(stateDir(o.root), 'deploy', 'state.json');
      const state = readJson(file, null);
      if (state?.id === id) writeJson(file, { ...state, status: 'rolled_back' });
      return { restored };
    },
    'deploy.state': () => readJson(path.join(stateDir(o.root), 'deploy', 'state.json'), null),

    'process.restart': () => {
      // The host panel restarts a process that exits unexpectedly. A non-zero code is what marks it as such.
      const code = Number(env.TCC_RESTART_EXIT_CODE ?? 1);
      setTimeout(async () => {
        try { await o.beforeExit?.(); } catch { /* exit regardless */ }
        process.exit(Number.isInteger(code) ? code : 1);
      }, 400).unref();
      return { exiting: true };
    },
  };

  function trash(rel, abs) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const keep = path.join(stateDir(o.root), 'trash', stamp, ...rel.split('/'));
    mkdirSync(path.dirname(keep), { recursive: true });
    copyFileSync(abs, keep);
    return `.tcc/trash/${stamp}/${rel}`;
  }

  const commands = { ...core, ...(o.commands ?? {}) };

  async function onCommand(msg) {
    const reply = (ok, payload) => push({ t: 'res', id: msg.id, ok, ...payload });
    try {
      const { id, name, ts, body, sig } = msg;
      if (typeof id !== 'string' || typeof name !== 'string' || typeof body !== 'string') return;
      if (!safeEqual(hmac(secret, `cmd.${id}.${name}.${ts}.${sha256(body)}`), sig)) return reply(false, { code: 'bad_signature', error: 'Signature check failed.' });
      if (Math.abs(Date.now() - Number(ts)) > 90_000) return reply(false, { code: 'stale', error: 'Command timestamp is out of range.' });
      if (seen.has(id)) return reply(false, { code: 'replay', error: 'Command id was already used.' });
      seen.set(id, Date.now());
      if (seen.size > 2000) for (const [k, at] of seen) { if (Date.now() - at > 180_000) seen.delete(k); }

      const handler = Object.hasOwn(commands, name) ? commands[name] : null;
      if (!handler) return reply(false, { code: 'unknown_command', error: `This bot does not support "${name}".` });
      const data = await handler(JSON.parse(body));
      reply(true, { data: data ?? null });
    } catch (error) {
      reply(false, { code: error?.code && typeof error.code === 'string' ? error.code : 'command_failed', error: String(error?.message ?? error).slice(0, 500) });
    }
  }

  function connect() {
    if (stopped) return;
    attempt += 1;
    authed = false;
    let socket;
    try { socket = new WebSocket(url); } catch (error) { return retry(); }
    ws = socket;
    let nonce = '';
    socket.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      if (msg.t === 'challenge' && !authed) {
        const ts = Date.now();
        nonce = randomBytes(12).toString('hex');
        let info = {};
        try { info = o.info?.() ?? {}; } catch { /* optional */ }
        socket.send(JSON.stringify({
          t: 'auth', botId: o.botId, ts, nonce,
          sig: hmac(secret, `auth.${o.botId}.${msg.challenge}.${ts}`),
          info: { agentVersion: AGENT_VERSION, runtime: `node ${process.versions.node}`, platform: process.platform, commands: Object.keys(commands), bootNotes: globalThis.__tccBootNotes ?? [], ...info },
        }));
      } else if (msg.t === 'ready' && !authed) {
        // The backend must prove it knows the secret too.
        if (!safeEqual(hmac(secret, `ready.${o.botId}.${nonce}.${msg.ts}`), msg.sig)) return socket.close();
        authed = true;
        attempt = 0;
        for (const frame of outbox.splice(0)) push(frame);
        heartbeat();
      } else if (msg.t === 'cmd' && authed) {
        void onCommand(msg);
      }
    });
    socket.addEventListener('close', () => { if (ws === socket) { ws = null; authed = false; retry(); } });
    socket.addEventListener('error', () => { /* the close event schedules the retry */ });
  }

  function retry() {
    if (stopped) return;
    const wait = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6)) * (0.75 + Math.random() * 0.5);
    setTimeout(connect, wait).unref();
  }

  const beat = setInterval(heartbeat, 15_000);
  beat.unref();
  setInterval(() => {
    for (const [id, t] of transfers) if (Date.now() - t.at > 30 * 60_000) { if (t.dir) rmSync(t.dir, { recursive: true, force: true }); transfers.delete(id); }
  }, 60_000).unref();
  connect();

  return {
    emit: (kind, data) => push({ t: 'event', kind, data }),
    countCommand: () => { commandCount += 1; },
    /** Sends a heartbeat right now (the regular one goes out every 15 seconds). */
    beat: heartbeat,
    isConnected: () => authed,
    /** Marks the pending deployment healthy once the bot has stayed connected to Discord. */
    confirmHealthy: () => { try { const f = path.join(stateDir(o.root), 'deploy', 'state.json'); const s = readJson(f, null); if (s?.status === 'pending') writeJson(f, { ...s, status: 'confirmed', by: 'agent' }); } catch { /* optional */ } },
    stop: () => { stopped = true; clearInterval(beat); try { ws?.close(); } catch { /* closing */ } },
  };
}

/** Returns null when the file passed a check, undefined when no check exists for its type, or an error string. */
export function checkFile(file, rel) {
  if (/\.json$/i.test(rel)) {
    try { JSON.parse(readFileSync(file, 'utf8')); return null; } catch (error) { return `invalid JSON (${error.message})`; }
  }
  if (/\.(js|mjs|cjs)$/i.test(rel)) {
    // Fixed argv, no shell: `node --check <file>` only parses the file.
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    if (r.status === 0) return null;
    return `syntax error: ${String(r.stderr || r.error?.message || 'unknown').split('\n').filter(Boolean).slice(0, 4).join(' | ').slice(0, 400)}`;
  }
  return undefined;
}
