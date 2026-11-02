import { CommandContext } from '../lib/context.js';
import { createLogger } from '../lib/logger.js';
import { runCommand } from '../lib/run-command.js';
import { EXPORT_BUTTON_PREFIX, handleExportInteraction } from '../services/report-runner.js';

const logger = createLogger('interaction');

export default {
  name: 'interactionCreate',
  async execute(interaction, client) {
    if (interaction.isButton()) {
      if (String(interaction.customId).startsWith(EXPORT_BUTTON_PREFIX)) {
        try {
          await handleExportInteraction(interaction);
        } catch (error) {
          logger.error(`Report export button failed for "${interaction.customId}"`, error);
        }
      }

      return;
    }

    if (interaction.isAutocomplete()) {
      const command = client.commands.get(interaction.commandName);

      if (!command?.autocomplete) return;

      try {
        await command.autocomplete(interaction, client);
      } catch (error) {
        logger.error(`Autocomplete for "${interaction.commandName}" failed`, error);
      }

      return;
    }

    if (interaction.isModalSubmit()) {
      const [commandName] = interaction.customId.split(':');
      const command = client.commands.get(commandName);

      if (!command?.modal) {
        logger.warn(`Received a modal nobody handles: "${interaction.customId}"`);
        return;
      }

      try {
        await command.modal(interaction, client);
      } catch (error) {
        logger.error(`Modal "${interaction.customId}" failed`, error);
      }

      return;
    }

    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);

    if (!command) {
      logger.warn(`Received unknown slash command "${interaction.commandName}"`);
      return;
    }

    const ctx = new CommandContext({ client, command, interaction });
    await runCommand(command, ctx);
  },
};
