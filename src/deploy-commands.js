import { REST, Routes } from 'discord.js';
import { config, requireClientId } from './config.js';
import { commandPayloads } from './handlers/command-registry.js';
import { loadCommands } from './lib/loaders.js';
import { createLogger } from './lib/logger.js';

const logger = createLogger('deploy');
const clientId = requireClientId();
const { commands } = await loadCommands(config.commandsDir);
const body = commandPayloads(commands);
const rest = new REST({ version: '10' }).setToken(config.token);

try {
  if (config.guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, config.guildId), { body });
    logger.info(`Registered ${body.length} slash command(s) in guild ${config.guildId} (instant)`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body });
    logger.info(
      `Registered ${body.length} global slash command(s). Discord may take up to 1 hour to show them.`,
    );
  }
} catch (error) {
  logger.error('Failed to register slash commands', error);
  process.exit(1);
}
