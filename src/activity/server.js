import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { createLogger } from '../lib/logger.js';
import {
  activityConfigured,
  adminBackground,
  adminCharacter,
  adminReserve,
  authUser,
  buyCharacterFromActivity,
  buyFromActivity,
  equipFromActivity,
  exchangeCode,
  guildContext,
  reserveFromActivity,
  saveCustomFromActivity,
  storefront,
} from './store-api.js';

const logger = createLogger('activity');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const ART_DIR = path.join(HERE, '..', '..', 'assets', 'profile', 'backgrounds');
const DATA_ART_DIR = path.join(config.dataDir, 'backgrounds');
const CHARACTER_ART_DIR = path.join(config.dataDir, 'characters');
const COIN_FILE = path.join(HERE, '..', '..', 'assets', 'profile', 'coin.png');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const MAX_BODY_BYTES = 16 * 1024 * 1024;

function securityHeaders(res) {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https://cdn.discordapp.com https://media.discordapp.net",
      "connect-src 'self'",
      "font-src 'self'",
      "frame-ancestors https://discord.com https://*.discord.com https://discordapp.com https://*.discordapp.com",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function sendJson(res, status, payload) {
  securityHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function readJson(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;

      if (size > limit) {
        reject(Object.assign(new Error('الطلب كبير زيادة.'), { status: 413 }));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('صيغة الطلب مو صحيحة.'), { status: 400 }));
      }
    });

    req.on('error', reject);
  });
}

function bearer(req) {
  const header = String(req.headers.authorization ?? '');
  const match = /^Bearer\s+(.+)$/i.exec(header);

  return match ? match[1].trim() : '';
}

async function requireUser(req, res) {
  const user = await authUser(bearer(req));

  if (!user) {
    sendJson(res, 401, { ok: false, reason: 'auth', message: 'انتهت جلسة ديسكورد. افتح المتجر من جديد.' });
    return null;
  }

  return user;
}

/* ── API ──────────────────────────────────────────────────────────────────── */

async function handleApi(req, res, client, route, url) {
  if (route === '/api/config' && req.method === 'GET') {
    sendJson(res, 200, {
      enabled: config.activity.enabled && activityConfigured(),
      client_id: config.clientId,
      activity_url: config.activity.publicUrl,
    });
    return true;
  }

  if (route === '/api/token' && req.method === 'POST') {
    try {
      const body = await readJson(req, 64 * 1024);
      const token = await exchangeCode(body.code);
      sendJson(res, 200, {
        access_token: token.access_token,
        expires_in: token.expires_in ?? null,
      });
    } catch (error) {
      sendJson(res, error.status === 429 ? 429 : 400, {
        ok: false,
        reason: error.reason ?? 'token',
        message: 'ديسكورد ما فتح جلسة المتجر. سكّره وجرّب مرة ثانية.',
      });
    }

    return true;
  }

  if (route === '/api/store' && req.method === 'GET') {
    const user = await requireUser(req, res);
    if (!user) return true;

    const guildId = url.searchParams.get('guildId');
    const context = await guildContext(client, guildId, user.id);

    if (context.error === 'guild') {
      sendJson(res, 404, { ok: false, reason: 'guild', message: 'البوت مو موجود في هذا السيرفر.' });
      return true;
    }

    if (context.error === 'member') {
      sendJson(res, 403, { ok: false, reason: 'member', message: 'إنت مو عضو في هذا السيرفر.' });
      return true;
    }

    sendJson(res, 200, {
      ok: true,
      data: await storefront(client, context.guild, context.member, user),
    });

    return true;
  }

  if (route === '/api/buy' && req.method === 'POST') {
    const user = await requireUser(req, res);
    if (!user) return true;

    const body = await readJson(req, 2 * 1024 * 1024);
    const result = await buyFromActivity({
      client,
      guildId: body.guildId,
      user,
      key: body.key,
      quantity: body.quantity,
      name: body.name,
      color: body.color,
      image: body.image,
      imageName: body.imageName,
    });

    sendJson(res, 200, result);
    return true;
  }

  if (route === '/api/equip' && req.method === 'POST') {
    const user = await requireUser(req, res);
    if (!user) return true;

    const body = await readJson(req, 64 * 1024);
    const context = await guildContext(client, body.guildId, user.id);

    if (context.error) {
      sendJson(res, 403, {
        ok: false,
        reason: context.error,
        message: 'إنت مو عضو في هذا السيرفر.',
      });
      return true;
    }

    sendJson(res, 200, await equipFromActivity(client, context.guild.id, user.id, body.backgroundId));
    return true;
  }

  if (route === '/api/background/custom' && req.method === 'POST') {
    const user = await requireUser(req, res);
    if (!user) return true;

    const body = await readJson(req);
    sendJson(
      res,
      200,
      await saveCustomFromActivity({
        client,
        guildId: body.guildId,
        user,
        image: body.image,
        imageName: body.imageName,
      }),
    );
    return true;
  }

  if (route === '/api/admin/background' && req.method === 'POST') {
    const user = await requireUser(req, res);
    if (!user) return true;

    const body = await readJson(req);
    sendJson(
      res,
      200,
      await adminBackground({
        client,
        guildId: body.guildId,
        user,
        action: body.action,
        id: body.id,
        name: body.name,
        price: body.price,
        level: body.level,
        image: body.image,
        imageName: body.imageName,
      }),
    );
    return true;
  }

  if (route === '/api/character/buy' && req.method === 'POST') {
    const user = await requireUser(req, res);
    if (!user) return true;

    const body = await readJson(req, 64 * 1024);
    sendJson(
      res,
      200,
      await buyCharacterFromActivity({
        client,
        guildId: body.guildId,
        user,
        characterId: body.characterId,
      }),
    );
    return true;
  }

  if (route === '/api/character/reserve' && req.method === 'POST') {
    const user = await requireUser(req, res);
    if (!user) return true;

    const body = await readJson(req, 64 * 1024);
    sendJson(
      res,
      200,
      await reserveFromActivity({
        client,
        guildId: body.guildId,
        user,
        action: body.action,
        id: body.id,
        name: body.name,
      }),
    );
    return true;
  }

  if (route === '/api/admin/character' && req.method === 'POST') {
    const user = await requireUser(req, res);
    if (!user) return true;

    const body = await readJson(req);
    sendJson(
      res,
      200,
      await adminCharacter({
        client,
        guildId: body.guildId,
        user,
        action: body.action,
        id: body.id,
        name: body.name,
        price: body.price,
        image: body.image,
        imageName: body.imageName,
      }),
    );
    return true;
  }

  if (route === '/api/admin/reserve' && req.method === 'POST') {
    const user = await requireUser(req, res);
    if (!user) return true;

    const body = await readJson(req, 64 * 1024);
    sendJson(
      res,
      200,
      await adminReserve({
        client,
        guildId: body.guildId,
        user,
        enabled: body.enabled,
        price: body.price,
      }),
    );
    return true;
  }

  return false;
}

/* ── Static files ─────────────────────────────────────────────────────────── */

async function serveFile(req, res, file, { immutable = false } = {}) {
  let info;

  try {
    info = await stat(file);
  } catch {
    return false;
  }

  if (!info.isFile()) return false;

  const extension = path.extname(file).toLowerCase();

  securityHeaders(res);
  res.writeHead(200, {
    'Content-Type': MIME[extension] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }

  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);

  return true;
}

function safeJoin(root, relative) {
  const resolved = path.resolve(root, `.${path.posix.normalize(`/${relative}`)}`);

  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;

  return resolved;
}

async function handleStatic(req, res, route) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  if (route === '/assets/coin.png') {
    if (existsSync(COIN_FILE)) return serveFile(req, res, COIN_FILE);
    return false;
  }

  if (route.startsWith('/assets/backgrounds/')) {
    const name = path.basename(route);
    const dataFile = safeJoin(DATA_ART_DIR, name);

    if (dataFile && existsSync(dataFile)) return serveFile(req, res, dataFile);

    const file = safeJoin(ART_DIR, name);

    if (file && existsSync(file)) return serveFile(req, res, file);
    return false;
  }

  if (route.startsWith('/assets/characters/')) {
    const file = safeJoin(CHARACTER_ART_DIR, path.basename(route));

    if (file && existsSync(file)) return serveFile(req, res, file);
    return false;
  }

  const relative = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
  const file = safeJoin(PUBLIC_DIR, relative);

  if (!file) return false;

  if (await serveFile(req, res, file, { immutable: relative.startsWith('vendor/') })) return true;

  // Unknown extension-less paths fall back to the app shell.
  if (!path.extname(relative)) {
    return serveFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
  }

  return false;
}

/* ── Server ───────────────────────────────────────────────────────────────── */

async function handle(req, res, client) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let route = url.pathname;

  // Discord's activity proxy can prefix requests with /.proxy.
  if (route === '/.proxy' || route.startsWith('/.proxy/')) {
    route = route.slice('/.proxy'.length) || '/';
  }

  if (route === '/healthz') {
    sendJson(res, 200, { ok: true, activity: config.activity.enabled });
    return;
  }

  if (route.startsWith('/api/')) {
    try {
      const handled = await handleApi(req, res, client, route, url);

      if (!handled) sendJson(res, 404, { ok: false, reason: 'not_found' });
    } catch (error) {
      logger.error(`Activity API ${route} failed`, error);

      if (!res.headersSent) sendJson(res, 500, { ok: false, reason: 'server' });
      else res.destroy();
    }

    return;
  }

  if (await handleStatic(req, res, route)) return;

  sendJson(res, 404, { ok: false, reason: 'not_found' });
}

/**
 * Starts the storefront HTTP server. Returns null when the feature is off or
 * not configured, so the bot keeps running exactly as before.
 */
export function startActivityServer(client) {
  if (!config.activity.enabled) return null;

  if (!activityConfigured()) {
    logger.warn(
      'ACTIVITY_ENABLED is set but CLIENT_ID or DISCORD_CLIENT_SECRET is missing; the store activity stays off.',
    );
    return null;
  }

  if (!existsSync(path.join(PUBLIC_DIR, 'index.html'))) {
    logger.warn('Activity client files are missing; the store activity stays off.');
    return null;
  }

  const server = createServer((req, res) => {
    handle(req, res, client).catch((error) => {
      logger.error('Activity request failed', error);

      if (!res.headersSent) sendJson(res, 500, { ok: false, reason: 'server' });
      else res.destroy();
    });
  });

  server.on('error', (error) => {
    logger.error(`Activity server could not start on port ${config.activity.port}`, error);
  });

  server.listen(config.activity.port, config.activity.host, () => {
    const where = config.activity.publicUrl ?? `http://${config.activity.host}:${config.activity.port}`;
    logger.info(`Store activity listening on ${where}`);
  });

  return server;
}
