import { createLogger } from '../lib/logger.js';
import { deleteExpiryById, listDueExpiries } from './moderation-store.js';

const logger = createLogger('moderation-scheduler');

function reasonLine(row) {
  return row.reason ? `Temporary ${row.kind} expired: ${row.reason}` : `Temporary ${row.kind} expired`;
}

async function resolveGuild(client, guildId) {
  return client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
}

async function expireMute(client, row) {
  const guild = await resolveGuild(client, row.guildId);

  if (!guild) return 'gone';

  const member = await guild.members.fetch(row.userId).catch(() => null);

  // The member left or the role was removed by hand: the row has done its job.
  if (!member) return 'done';

  if (row.roleId && member.roles.cache.has(row.roleId)) {
    await member.roles.remove(row.roleId, reasonLine(row));
  }

  return 'done';
}

async function expireBan(client, row) {
  const guild = await resolveGuild(client, row.guildId);

  if (!guild) return 'gone';

  try {
    await guild.bans.remove(row.userId, reasonLine(row));
  } catch (error) {
    // 10026 = unknown ban, which means someone already unbanned them.
    if (error?.code !== 10026) throw error;
  }

  return 'done';
}

/**
 * Removes temporary mutes and bans. Running every minute keeps Discord's rate
 * limits happy and is precise enough for moderation; a 40-second mute may last
 * up to a minute longer, which is noted in the command reply.
 */
export async function processDueExpiries(client) {
  const due = listDueExpiries();

  for (const row of due) {
    try {
      const result = row.kind === 'ban' ? await expireBan(client, row) : await expireMute(client, row);

      if (result === 'done' || result === 'gone') {
        deleteExpiryById(row.id);
      }
    } catch (error) {
      // Keep the row: the next tick retries. A broken permission would
      // otherwise silently leave someone muted forever.
      logger.warn(`Could not expire ${row.kind} for ${row.userId}: ${error.message}`);
    }
  }
}

export function startModerationScheduler(client, intervalMs = 60_000) {
  const tick = () => processDueExpiries(client);

  tick().catch((error) => logger.error('Moderation scheduler startup failed', error));

  const timer = setInterval(() => {
    tick().catch((error) => logger.error('Moderation scheduler tick failed', error));
  }, intervalMs);

  timer.unref();

  logger.info(`Moderation scheduler running (checks every ${Math.round(intervalMs / 1000)}s)`);
  return timer;
}
