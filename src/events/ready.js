import { ActivityType } from 'discord.js';
import { config } from '../config.js';
import { registerCommands } from '../handlers/command-registry.js';
import { createLogger } from '../lib/logger.js';
import { startBirthdayScheduler } from '../services/birthday-scheduler.js';
import { startSummaryScheduler } from '../services/summary-scheduler.js';
import { startModerationScheduler } from '../services/moderation-scheduler.js';

const logger = createLogger('ready');

export default {
  name: 'clientReady',
  once: true,
  async execute(client) {
    logger.info(`Logged in as ${client.user.tag} (${client.user.id})`);
    logger.info(`Serving ${client.guilds.cache.size} server(s)`);

    client.user.setPresence({
      status: 'online',
      activities: [{ name: `${config.prefix}help | /help`, type: ActivityType.Watching }],
    });

    startBirthdayScheduler(client);
    startSummaryScheduler(client);
    startModerationScheduler(client);

    if (!config.clientId) {
      logger.warn('CLIENT_ID is not set - skipping slash command registration');
      return;
    }

    try {
      await registerCommands(client, client.commands, config.guildId);
    } catch (error) {
      logger.error('Failed to register slash commands', error);
    }
  },
};
