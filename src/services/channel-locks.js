import { PermissionFlagsBits } from 'discord.js';
import { getDb } from '../lib/db.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('channel-locks');

/**
 * /lock closes a channel by denying a short, predictable set of permissions to
 * @everyone. Every other permission is left alone, so staff roles that are
 * explicitly allowed to talk keep working — an explicit role allow beats the
 * @everyone deny.
 *
 * The previous @everyone bits are saved in `channel_locks` before the first
 * edit. /unlock replays those bits, so a channel that was already read-only (or
 * that had a custom allow) comes back exactly as it was instead of being opened
 * to everyone.
 */

export const TEXT_LOCK_PERMISSIONS = Object.freeze([
  'SendMessages',
  'SendMessagesInThreads',
  'AddReactions',
  'CreatePublicThreads',
  'CreatePrivateThreads',
]);

export const VOICE_LOCK_PERMISSIONS = Object.freeze(['Connect', 'Speak', 'Stream']);

/** The permissions /lock denies in this channel, or null if it cannot be locked. */
export function lockPermissionsFor(channel) {
  // Threads have no overwrite manager of their own; the lock belongs on the
  // parent, which the thread inherits.
  if (channel?.isThread?.()) return null;
  if (channel?.isVoiceBased?.()) return VOICE_LOCK_PERMISSIONS;
  if (channel?.isTextBased?.()) return TEXT_LOCK_PERMISSIONS;
  return null;
}

/** Why a channel cannot be locked, for a specific reply. */
export function unsupportedReason(channel) {
  return channel?.isThread?.() ? 'thread' : 'unsupported';
}

/* ── Stored locks ─────────────────────────────────────────────────────────── */

export function lockRecord(guildId, channelId) {
  const row = getDb()
    .prepare(
      `SELECT guild_id, channel_id, allow, deny, locked_by, locked_at
         FROM channel_locks
        WHERE guild_id = ? AND channel_id = ?`,
    )
    .get(guildId, channelId);

  if (!row) return null;

  return {
    guildId: row.guild_id,
    channelId: row.channel_id,
    allow: String(row.allow ?? '0'),
    deny: String(row.deny ?? '0'),
    lockedBy: row.locked_by ?? null,
    lockedAt: Number(row.locked_at) || 0,
  };
}

function saveRecord({ guildId, channelId, allow, deny, lockedBy }) {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO channel_locks
         (guild_id, channel_id, allow, deny, locked_by, locked_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(guildId, channelId, String(allow), String(deny), lockedBy ?? null, Date.now());
}

function dropRecord(guildId, channelId) {
  getDb()
    .prepare('DELETE FROM channel_locks WHERE guild_id = ? AND channel_id = ?')
    .run(guildId, channelId);
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function everyoneBits(channel, everyoneId) {
  const overwrite = channel.permissionOverwrites?.cache?.get(everyoneId);
  const allow = overwrite ? BigInt(overwrite.allow.bitfield ?? 0) : 0n;
  const deny = overwrite ? BigInt(overwrite.deny.bitfield ?? 0) : 0n;

  return { allow, deny };
}

function deniedNames(permissions, { deny }) {
  return permissions.filter((name) => (deny & PermissionFlagsBits[name]) !== 0n);
}

/** Patch that sets each permission back to what the saved bits describe. */
function restorePatch(permissions, { allow, deny }) {
  const patch = {};

  for (const name of permissions) {
    const bit = PermissionFlagsBits[name];
    patch[name] = (allow & bit) !== 0n ? true : (deny & bit) !== 0n ? false : null;
  }

  return patch;
}

function denyPatch(permissions) {
  const patch = {};

  for (const name of permissions) patch[name] = false;

  return patch;
}

async function botCanManage(guild, channel) {
  const me = guild.members?.me ?? (await guild.members?.fetchMe?.().catch(() => null));

  if (!me) return false;

  try {
    return channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageChannels) ?? false;
  } catch {
    return false;
  }
}

function auditReason(actor, verb) {
  const name = actor?.name ? `${actor.name} (${actor.id})` : String(actor?.id ?? 'unknown');

  return `${verb} بواسطة ${name}`.slice(0, 512);
}

/* ── Public API ───────────────────────────────────────────────────────────── */

/**
 * Denies the channel's talk permissions to @everyone and saves the old state.
 * Locking an already-locked channel is a no-op: re-saving the deny bits would
 * make /unlock restore the lock.
 */
export async function lockChannel({ guild, channel, actor = {} }) {
  const permissions = lockPermissionsFor(channel);

  if (!permissions) {
    return { ok: false, reason: unsupportedReason(channel) };
  }

  if (lockRecord(guild.id, channel.id)) {
    return { ok: true, already: true, permissions };
  }

  const bits = everyoneBits(channel, guild.roles.everyone.id);

  // Locked by hand before the bot ever saw it: report it as locked and leave the
  // snapshot alone, so /unlock can still open the channel afterwards.
  if (deniedNames(permissions, bits).length === permissions.length) {
    return { ok: true, already: true, external: true, permissions };
  }

  if (!(await botCanManage(guild, channel))) {
    return { ok: false, reason: 'bot-permissions' };
  }

  saveRecord({
    guildId: guild.id,
    channelId: channel.id,
    allow: bits.allow,
    deny: bits.deny,
    lockedBy: actor.id ?? null,
  });

  try {
    await channel.permissionOverwrites.edit(guild.roles.everyone, denyPatch(permissions), {
      reason: auditReason(actor, 'قفل قناة'),
    });
  } catch (error) {
    // The edit failed, so there is nothing to restore later.
    dropRecord(guild.id, channel.id);
    logger.warn(`Could not lock #${channel.name ?? channel.id}: ${error.message}`);
    return { ok: false, reason: 'discord', message: error.message };
  }

  logger.info(`Locked #${channel.name ?? channel.id} in ${guild.id} (${permissions.join(', ')})`);

  return { ok: true, already: false, permissions };
}

/**
 * Restores the @everyone bits saved by lockChannel(). A channel the bot has no
 * record for still gets opened: the lock permissions are cleared, and the reply
 * says the earlier state was not known.
 */
export async function unlockChannel({ guild, channel, actor = {} }) {
  const permissions = lockPermissionsFor(channel);

  if (!permissions) {
    return { ok: false, reason: unsupportedReason(channel) };
  }

  const record = lockRecord(guild.id, channel.id);
  const bits = everyoneBits(channel, guild.roles.everyone.id);

  if (!record && deniedNames(permissions, bits).length === 0) {
    return { ok: true, already: true, permissions };
  }

  if (!(await botCanManage(guild, channel))) {
    return { ok: false, reason: 'bot-permissions' };
  }

  const everyone = guild.roles.everyone;

  try {
    if (record && !(BigInt(record.allow) || BigInt(record.deny))) {
      // There was no @everyone overwrite before the lock, so removing it is the
      // exact restore. Keep an empty overwrite from littering the channel.
      await channel.permissionOverwrites.delete(everyone, auditReason(actor, 'فتح قناة'));
    } else {
      const patch = record
        ? restorePatch(permissions, { allow: BigInt(record.allow), deny: BigInt(record.deny) })
        : restorePatch(permissions, { allow: 0n, deny: 0n });

      await channel.permissionOverwrites.edit(everyone, patch, {
        reason: auditReason(actor, 'فتح قناة'),
      });
    }
  } catch (error) {
    // A missing overwrite (already deleted by hand) is a successful unlock.
    if (error?.code !== 10064) {
      logger.warn(`Could not unlock #${channel.name ?? channel.id}: ${error.message}`);
      return { ok: false, reason: 'discord', message: error.message };
    }
  }

  if (record) dropRecord(guild.id, channel.id);

  logger.info(`Unlocked #${channel.name ?? channel.id} in ${guild.id}`);

  return { ok: true, already: false, restored: Boolean(record), permissions };
}
