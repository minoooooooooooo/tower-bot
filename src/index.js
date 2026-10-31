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

try {
  await client.login(config.token);
} catch (error) {
  logger.error('Login failed', error);

  if (String(error?.message ?? '').includes('disallowed intents')) {
    logger.error(
      'Enable the "Message Content" intent in the Discord Developer Portal -> Bot -> Privileged Gateway Intents.',
    );
  }

  process.exit(1);
}
