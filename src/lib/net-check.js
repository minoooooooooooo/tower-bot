import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';

/**
 * Why this exists: on 2026-10-31 the host could reach GitHub and the npm
 * registry but never opened a gateway socket to Discord. discord.js reported
 * nothing useful (`ws=CLOSED`, no shard error), so the failure had to be found
 * by probing each layer separately from inside the container.
 *
 * The report is deliberately plain text: it gets pasted into a support ticket.
 */
const TIMEOUT_MS = 5_000;
const GATEWAY_HOST = 'gateway.discord.gg';
const REST_URL = 'https://discord.com/api/v10/gateway';

function probeDns(host) {
  return dns.lookup(host, { all: true }).then(
    (rows) => `ok (${rows.map((row) => `${row.family}:${row.address}`).join(', ')})`,
    (error) => `FAILED (${error.code ?? error.message})`,
  );
}

function probeTcp(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;

    const finish = (message) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(message);
    };

    socket.setTimeout(TIMEOUT_MS, () => finish(`timeout after ${TIMEOUT_MS / 1000}s`));
    socket.once('connect', () => finish('ok'));
    socket.once('error', (error) => finish(`FAILED (${error.code ?? error.message})`));
  });
}

function probeTls(host, port) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host });
    let settled = false;

    const finish = (message) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(message);
    };

    socket.setTimeout(TIMEOUT_MS, () => finish(`timeout after ${TIMEOUT_MS / 1000}s`));
    socket.once('secureConnect', () =>
      finish(
        `ok (${socket.getProtocol()}, cert ${socket.authorized ? 'trusted' : 'UNTRUSTED'})`,
      ),
    );
    socket.once('error', (error) => finish(`FAILED (${error.code ?? error.message})`));
  });
}

async function probeHttps(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return `HTTP ${response.status}`;
  } catch (error) {
    return `FAILED (${error.cause?.code ?? error.name ?? error.message})`;
  }
}

/**
 * Probes every layer between the container and Discord's gateway and logs one
 * line per layer. Each probe is independent and time-limited, so one broken
 * layer does not hide the state of the others.
 */
export async function reportDiscordReachability(log) {
  const probes = [
    [`dns  ${GATEWAY_HOST}`, probeDns(GATEWAY_HOST)],
    [`tcp  ${GATEWAY_HOST}:443`, probeTcp(GATEWAY_HOST, 443)],
    [`tls  ${GATEWAY_HOST}:443`, probeTls(GATEWAY_HOST, 443)],
    [`http ${REST_URL}`, probeHttps(REST_URL)],
  ];

  log('diagnosing outbound access to Discord (5s limit per probe)');

  const results = await Promise.all(probes.map(([, probe]) => probe));
  probes.forEach(([label], index) => {
    log(`${label} -> ${results[index]}`);
  });
}
