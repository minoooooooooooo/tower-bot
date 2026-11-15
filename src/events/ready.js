import { ActivityType } from 'discord.js';
import { config } from '../config.js';
import { registerCommands } from '../handlers/command-registry.js';
import { buildLabel } from '../lib/build-info.js';
import { createLogger } from '../lib/logger.js';
import { startBirthdayScheduler } from '../services/birthday-scheduler.js';
import { startSummaryScheduler } from '../services/summary-scheduler.js';
import { startModerationScheduler } from '../services/moderation-scheduler.js';
import { linkedPoints } from '../services/ebot-vex.js';
import { ensureCoinBackfill } from '../services/profile-store.js';
import {
  reconcileVoiceSessions,
  startActivityHeartbeat,
} from '../services/activity.js';

const logger = createLogger('ready');

export default {
  name: 'clientReady',
  once: true,
  async execute(client) {
    logger.info(`Logged in as ${client.user.tag} (${client.user.id})`);
    logger.info(`Serving ${client.guilds.cache.size} server(s)`);
    logger.info(buildLabel());

    client.user.setPresence({
      status: 'online',
      activities: [{ name: `${config.prefix}help | /help`, type: ActivityType.Watching }],
    });

    startBirthdayScheduler(client);
    startSummaryScheduler(client);
    startModerationScheduler(client);

    try {
      await reconcileVoiceSessions(client);
      startActivityHeartbeat();
    } catch (error) {
      // Stats are useful but never worth blocking startup.
      logger.error('Could not start activity tracking', error);
    }

    // Pay the levels members already earned once, before their first card view.
    for (const guild of client.guilds.cache.values()) {
      try {
        const linked = await linkedPoints(client, guild.id);
        const seeded = ensureCoinBackfill(guild.id, linked);

        if (seeded > 0) {
          logger.info(`Backfilled coins for ${seeded} profile(s) in ${guild.id}`);
        }
      } catch (error) {
        logger.warn(`Could not backfill coins for ${guild.id}: ${error.message}`);
      }
    }

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
