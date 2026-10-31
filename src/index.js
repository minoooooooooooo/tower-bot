import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { config } from './config.js';
import { closeDb } from './lib/db.js';
import { loadCommands, loadEvents } from './lib/loaders.js';
import { createLogger } from './lib/logger.js';

const logger = createLogger('bot');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const { commands, aliases } = await loadCommands(config.commandsDir);
client.commands = commands;
client.aliases = aliases;

for (const event of await loadEvents(config.eventsDir)) {
  const handler = (...args) => event.execute(...args, client);

  if (event.once) client.once(event.name, handler);
  else client.on(event.name, handler);
}

client.on('error', (error) => logger.error('Client error', error));
client.on('warn', (message) => logger.warn(message));

client.on('shardError', (error) => logger.error('Gateway error', error));
client.on('shardDisconnect', (event, shardId) =>
  logger.warn(`Shard ${shardId} disconnected (code ${event?.code ?? '?'}), reconnecting`),
);
client.on('shardReconnecting', (shardId) => logger.info(`Shard ${shardId} reconnecting`));
client.on('invalidated', () =>
  logger.error('Gateway session invalidated - another process may be using the same token'),
);

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', reason instanceof Error ? reason : String(reason));
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`Received ${signal}, shutting down...`);

  try {
    await client.destroy();
  } catch {
    // Already disconnected.
  }

  try {
    closeDb();
  } catch {
    // Database already closed.
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/**
 * A gateway connection can fail in a way that produces no error at all: if the
 * host cannot reach gateway.discord.gg:443, `client.login()` simply never
 * resolves and the process sits there looking healthy. That happened on
 * 2026-10-31 (boot logged 5 commands, then silence, bot stayed offline), so
 * the connection is now bounded and loud.
 */
const WS_STATE = { 0: 'CONNECTING', 1: 'OPEN', 2: 'CLOSING', 3: 'CLOSED' };
const CONNECT_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 5;

function wsState(client) {
  return WS_STATE[client?.ws?.status] ?? `unknown(${client?.ws?.status})`;
}

async function connectOnce() {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `no gateway connection after ${CONNECT_TIMEOUT_MS / 1000}s ` +
            `(ws=${wsState(client)}, ping=${client.ws.ping}). ` +
            'The host may be blocking outbound access to gateway.discord.gg:443.',
        ),
      );
    }, CONNECT_TIMEOUT_MS);
    timer.unref?.();
  });

  try {
    await Promise.race([client.login(config.token), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function connect() {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    logger.info(
      attempt === 1
        ? 'Connecting to the Discord gateway...'
        : `Connecting to the Discord gateway (attempt ${attempt}/${MAX_ATTEMPTS})...`,
    );

    try {
      await connectOnce();
      return;
    } catch (error) {
      const message = String(error?.message ?? '');
      logger.error(`Login attempt ${attempt}/${MAX_ATTEMPTS} failed`, error);

      if (message.includes('disallowed intents')) {
        logger.error(
          'Enable the "Message Content" intent in the Discord Developer Portal -> Bot -> Privileged Gateway Intents.',
        );
        process.exit(1);
      }

      if (
        error?.name === 'TokenInvalid' ||
        error?.code === 'TokenInvalid' ||
        message.toLowerCase().includes('invalid token')
      ) {
        logger.error('DISCORD_TOKEN is missing or invalid. Fix .env on the host, then restart.');
        process.exit(1);
      }

      if (attempt === MAX_ATTEMPTS) {
        logger.error('Giving up after repeated connection failures.');
        process.exit(1);
      }

      try {
        await client.destroy();
      } catch {
        // Nothing to tear down.
      }

      const waitMs = Math.min(60_000, 5_000 * 2 ** (attempt - 1));
      logger.warn(`Retrying in ${Math.round(waitMs / 1000)}s...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

await connect();
