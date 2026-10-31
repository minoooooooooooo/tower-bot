import { createLogger } from '../lib/logger.js';

const logger = createLogger('birthday-role');

/**
 * Adds the birthday role. Returns a result object instead of throwing so the
 * caller can distinguish "member left" from "bot lacks permissions".
 */
export async function addBirthdayRole(guild, userId, roleId) {
  const member = await guild.members.fetch(userId).catch(() => null);

  if (!member) return { ok: false, reason: 'member-left' };
  if (member.roles.cache.has(roleId)) return { ok: true, already: true };

  try {
    await member.roles.add(roleId, 'Birthday role');
    return { ok: true, already: false };
  } catch (error) {
    logger.warn(`[${guild.name}] Could not add birthday role to ${userId}: ${error.message}`);
    return { ok: false, reason: 'error', error };
  }
}

export async function removeBirthdayRole(guild, userId, roleId) {
  const member = await guild.members.fetch(userId).catch(() => null);

  if (!member) return { ok: false, reason: 'member-left' };
  if (!member.roles.cache.has(roleId)) return { ok: true, already: true };

  try {
    await member.roles.remove(roleId, 'Birthday over');
    return { ok: true, already: false };
  } catch (error) {
    logger.warn(`[${guild.name}] Could not remove birthday role from ${userId}: ${error.message}`);
    return { ok: false, reason: 'error', error };
  }
}
