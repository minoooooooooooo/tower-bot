import { spawn } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('tunnel');

/**
 * Cloudflare's quick tunnel gives the bot a public HTTPS address without an
 * account, a domain or a card - it only needs an outbound connection, which is
 * what a panel host has. The address changes whenever the process restarts, so
 * it is logged and written to `data/tunnel-url.txt` for the portal's URL
 * mapping. Everything here is optional: TUNNEL_ENABLED unset means no process,
 * no download and no change to how the bot runs today.
 */

const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
const PUBLIC_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const MIN_BINARY_BYTES = 5 * 1024 * 1024;
const URL_TIMEOUT_MS = 60_000;

let child = null;
let publicUrl = null;
let stopping = false;
let onUrl = null;

function assetName() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';

  if (process.platform === 'linux') return `cloudflared-linux-${arch}`;
  if (process.platform === 'win32') return `cloudflared-windows-${arch}.exe`;

  return null;
}

function binaryPath() {
  const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';

  return path.resolve(config.dataDir, 'tunnel', name);
}

async function ensureBinary(file) {
  try {
    if (statSync(file).size >= MIN_BINARY_BYTES) return file;
  } catch {
    // Not downloaded yet.
  }

  const asset = assetName();

  if (!asset) {
    throw new Error(`cloudflared has no build for ${process.platform}/${process.arch}`);
  }

  const response = await fetch(`${RELEASE_BASE}/${asset}`, { redirect: 'follow' });

  if (!response.ok || !response.body) {
    throw new Error(`Download failed (HTTP ${response.status})`);
  }

  mkdirSync(path.dirname(file), { recursive: true });

  const partial = `${file}.part`;

  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));

    if (statSync(partial).size < MIN_BINARY_BYTES) {
      throw new Error('Downloaded file is too small');
    }

    chmodSync(partial, 0o755);
    renameSync(partial, file);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }

  logger.info(`Downloaded the tunnel client to ${file}`);

  return file;
}

function rememberUrl(url) {
  if (publicUrl === url) return;

  publicUrl = url;
  logger.info(`Store activity public URL: ${url}`);
  logger.info('Paste that into the Developer Portal URL mapping whenever it changes.');

  try {
    mkdirSync(path.resolve(config.dataDir), { recursive: true });
    writeFileSync(path.resolve(config.dataDir, 'tunnel-url.txt'), `${url}\n`, 'utf8');
  } catch (error) {
    logger.warn(`Could not save the tunnel URL to data/tunnel-url.txt: ${error.message}`);
  }

  // Optional listener (see ACTIVITY_URL_CHANNEL_ID). Never let a failure there
  // affect the tunnel itself.
  if (onUrl) {
    Promise.resolve()
      .then(() => onUrl(url))
      .catch((error) => logger.warn(`Could not report the new address: ${error.message}`));
  }
}

function watch(stream) {
  let buffer = '';

  stream.setEncoding('utf8');

  stream.on('data', (chunk) => {
    buffer += chunk;

    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const match = PUBLIC_URL.exec(line);

      if (match) rememberUrl(match[0]);
    }
  });
}

/**
 * Starts the tunnel in front of the activity server. Returns the child process,
 * or null when it is off, unsupported or failed - never throws at the caller.
 *
 * `onUrl` is called once with the public address as soon as cloudflared prints
 * it; the bot uses it to post the address to a channel.
 */
export async function startActivityTunnel(port, { onUrl: listener } = {}) {
  if (!config.tunnel.enabled) return null;

  stopping = false;
  onUrl = typeof listener === 'function' ? listener : null;

  if (!Number.isFinite(port) || port <= 0) {
    logger.warn('The activity port is not valid; the tunnel stays off.');
    return null;
  }

  if (!assetName()) {
    logger.warn(`The tunnel has no cloudflared build for ${process.platform}/${process.arch}; it stays off.`);
    return null;
  }

  const file = binaryPath();

  try {
    if (!existsSync(file)) logger.info('Downloading the tunnel client (about 35 MB, once)...');
    await ensureBinary(file);
  } catch (error) {
    logger.warn(`The tunnel client could not be prepared (${error.message}); the bot continues without it.`);
    return null;
  }

  try {
    child = spawn(
      file,
      [
        'tunnel',
        '--url',
        `http://127.0.0.1:${port}`,
        '--no-autoupdate',
        // Panels usually block UDP, which is cloudflared's default transport.
        '--protocol',
        'http2',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
  } catch (error) {
    logger.warn(`The tunnel could not start (${error.message}); the bot continues without it.`);
    return null;
  }

  watch(child.stdout);
  watch(child.stderr);

  child.on('error', (error) => {
    logger.warn(`The tunnel reported an error: ${error.message}`);
  });

  child.on('exit', (code) => {
    if (stopping) return;
    if (code === 0) logger.info('The tunnel stopped.');
    else logger.warn(`The tunnel exited with code ${code}. Restart the bot to get a new address.`);

    child = null;
  });

  const timer = setTimeout(() => {
    if (!publicUrl) {
      logger.warn('The tunnel is still starting; watch for "Store activity public URL" in this log.');
    }
  }, URL_TIMEOUT_MS);

  timer.unref?.();

  return child;
}

export function stopActivityTunnel() {
  const running = child;

  child = null;
  stopping = true;

  if (!running) return;

  try {
    running.kill('SIGTERM');
  } catch {
    // Process already gone.
  }
}

export function activityTunnelUrl() {
  return publicUrl;
}
