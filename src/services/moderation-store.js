import { getDb } from '../lib/db.js';

// --- the Muted role ---------------------------------------------------------

export function getMuteSettings(guildId) {
  const row = getDb()
    .prepare('SELECT role_id, configured FROM mute_settings WHERE guild_id = ?')
    .get(guildId);

  return {
    roleId: row?.role_id ?? null,
    configured: Boolean(row?.configured),
  };
}

export function getMuteRoleId(guildId) {
  return getMuteSettings(guildId).roleId;
}

/** `configured` stays false until the channel overwrites have been written. */
export function setMuteRoleId(guildId, roleId, { configured = true } = {}) {
  getDb()
    .prepare(
      `INSERT INTO mute_settings (guild_id, role_id, configured, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET
         role_id = excluded.role_id,
         configured = excluded.configured,
         updated_at = excluded.updated_at`,
    )
    .run(guildId, roleId ?? null, configured ? 1 : 0, Date.now());

  return roleId ?? null;
}

export function clearMuteRoleId(guildId) {
  return getDb().prepare('DELETE FROM mute_settings WHERE guild_id = ?').run(guildId).changes;
}

// --- temporary mutes and bans ----------------------------------------------

export const EXPIRY_KINDS = ['mute', 'ban'];

/**
 * One row per member and kind: muting again replaces the old expiry instead of
 * stacking a second timer that would fire early.
 */
export function setExpiry({ guildId, userId, kind, roleId = null, expiresAt, createdBy, reason = null }) {
  const now = Date.now();

  getDb()
    .prepare(
      `INSERT INTO moderation_expiries
         (guild_id, user_id, kind, role_id, reason, created_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, user_id, kind) DO UPDATE SET
         role_id = excluded.role_id,
         reason = excluded.reason,
         created_by = excluded.created_by,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at`,
    )
    .run(guildId, userId, kind, roleId, reason, createdBy, now, expiresAt);

  return getExpiry(guildId, userId, kind);
}

export function getExpiry(guildId, userId, kind) {
  const row = getDb()
    .prepare(
      `SELECT id, guild_id, user_id, kind, role_id, reason, created_by, created_at, expires_at
         FROM moderation_expiries
        WHERE guild_id = ? AND user_id = ? AND kind = ?`,
    )
    .get(guildId, userId, kind);

  return row ? toExpiry(row) : null;
}

export function listExpiries(guildId, kind = null) {
  const rows = kind
    ? getDb()
        .prepare(
          `SELECT id, guild_id, user_id, kind, role_id, reason, created_by, created_at, expires_at
             FROM moderation_expiries
            WHERE guild_id = ? AND kind = ?
            ORDER BY expires_at ASC`,
        )
        .all(guildId, kind)
    : getDb()
        .prepare(
          `SELECT id, guild_id, user_id, kind, role_id, reason, created_by, created_at, expires_at
             FROM moderation_expiries
            WHERE guild_id = ?
            ORDER BY expires_at ASC`,
        )
        .all(guildId);

  return rows.map(toExpiry);
}

/** Rows whose timer has passed. The scheduler processes these every minute. */
export function listDueExpiries(now = Date.now()) {
  return getDb()
    .prepare(
      `SELECT id, guild_id, user_id, kind, role_id, reason, created_by, created_at, expires_at
         FROM moderation_expiries
        WHERE expires_at <= ?
        ORDER BY expires_at ASC`,
    )
    .all(now)
    .map(toExpiry);
}

export function deleteExpiry(guildId, userId, kind) {
  return getDb()
    .prepare('DELETE FROM moderation_expiries WHERE guild_id = ? AND user_id = ? AND kind = ?')
    .run(guildId, userId, kind).changes;
}

export function deleteExpiryById(id) {
  return getDb().prepare('DELETE FROM moderation_expiries WHERE id = ?').run(id).changes;
}

export function countExpiries(guildId, kind = null) {
  const row = kind
    ? getDb()
        .prepare(
          'SELECT COUNT(*) AS total FROM moderation_expiries WHERE guild_id = ? AND kind = ?',
        )
        .get(guildId, kind)
    : getDb()
        .prepare('SELECT COUNT(*) AS total FROM moderation_expiries WHERE guild_id = ?')
        .get(guildId);

  return row?.total ?? 0;
}

function toExpiry(row) {
  return {
    id: row.id,
    guildId: row.guild_id,
    userId: row.user_id,
    kind: row.kind,
    roleId: row.role_id,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}
