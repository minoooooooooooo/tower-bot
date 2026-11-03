import { getDb } from '../lib/db.js';

/** Main exile plus ten severity levels. Stored as text so 'main' sorts first. */
export const EXILE_LEVELS = ['main', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

export const MAX_REASON_LENGTH = 200;

/**
 * Accepts the forms a moderator can type: nothing/`main`/`0` mean the main
 * role; `1`–`10` are severity levels. Anything else returns null.
 */
export function normalizeLevel(input) {
  if (input === null || input === undefined) return 'main';

  const raw = String(input).trim().toLowerCase();

  if (!raw || raw === 'main' || raw === 'm' || raw === '0' || raw === 'none') return 'main';

  const parsed = Number.parseInt(raw, 10);

  if (!/^\d+$/.test(raw) || !Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    return null;
  }

  return String(parsed);
}

export function levelLabel(level) {
  return level === 'main' ? 'Main' : `Level ${level}`;
}

/** Unknown levels are refused rather than silently coerced to main. */
export function isLevel(level) {
  return EXILE_LEVELS.includes(level);
}

// --- settings ---------------------------------------------------------------

export function getExileLogChannelId(guildId) {
  const row = getDb()
    .prepare('SELECT log_channel_id FROM exile_settings WHERE guild_id = ?')
    .get(guildId);

  return row?.log_channel_id ?? null;
}

export function setExileLogChannelId(guildId, channelId) {
  getDb()
    .prepare(
      `INSERT INTO exile_settings (guild_id, log_channel_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET
         log_channel_id = excluded.log_channel_id,
         updated_at = excluded.updated_at`,
    )
    .run(guildId, channelId ?? null, Date.now());

  return channelId ?? null;
}

// --- setup markers ----------------------------------------------------------

export function markRoleSetUp(guildId, roleId) {
  getDb()
    .prepare(
      `INSERT INTO exile_setups (guild_id, role_id, configured_at) VALUES (?, ?, ?)
       ON CONFLICT (guild_id, role_id) DO UPDATE SET configured_at = excluded.configured_at`,
    )
    .run(guildId, roleId, Date.now());
}

export function isRoleSetUp(guildId, roleId) {
  return Boolean(
    getDb()
      .prepare('SELECT 1 AS ok FROM exile_setups WHERE guild_id = ? AND role_id = ?')
      .get(guildId, roleId),
  );
}

/** Every role whose channel rules have been applied, newest first. */
export function listSetUpRoles(guildId) {
  return getDb()
    .prepare(
      'SELECT role_id, configured_at FROM exile_setups WHERE guild_id = ? ORDER BY configured_at DESC',
    )
    .all(guildId)
    .map((row) => ({ roleId: row.role_id, configuredAt: row.configured_at }));
}

export function clearRoleSetup(guildId, roleId) {
  const db = getDb();

  db.exec('BEGIN');

  try {
    db.prepare('DELETE FROM exile_channels WHERE guild_id = ? AND role_id = ?').run(
      guildId,
      roleId,
    );
    const removed = db
      .prepare('DELETE FROM exile_setups WHERE guild_id = ? AND role_id = ?')
      .run(guildId, roleId).changes;
    db.exec('COMMIT');
    return removed;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// --- level -> role mapping --------------------------------------------------

export function listRoleMappings(guildId) {
  return getDb()
    .prepare('SELECT level, role_id, updated_at FROM exile_roles WHERE guild_id = ?')
    .all(guildId)
    .map((row) => ({ level: row.level, roleId: row.role_id, updatedAt: row.updated_at }));
}

export function getRoleForLevel(guildId, level) {
  const row = getDb()
    .prepare('SELECT role_id FROM exile_roles WHERE guild_id = ? AND level = ?')
    .get(guildId, level);

  return row?.role_id ?? null;
}

export function getLevelForRole(guildId, roleId) {
  const row = getDb()
    .prepare('SELECT level FROM exile_roles WHERE guild_id = ? AND role_id = ?')
    .get(guildId, roleId);

  return row?.level ?? null;
}

/**
 * One role can only answer to one level. Mapping it again removes the other
 * level that used it, and the level's previous role is replaced. Returns the
 * previous mapping so the command can report what changed.
 */
export function setRoleMapping(guildId, level, roleId) {
  const db = getDb();
  const previous = getRoleForLevel(guildId, level);
  const previousLevel = getLevelForRole(guildId, roleId);

  db.exec('BEGIN');

  try {
    db.prepare('DELETE FROM exile_roles WHERE guild_id = ? AND (level = ? OR role_id = ?)').run(
      guildId,
      level,
      roleId,
    );
    db.prepare(
      'INSERT INTO exile_roles (guild_id, level, role_id, updated_at) VALUES (?, ?, ?, ?)',
    ).run(guildId, level, roleId, Date.now());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { previous, previousLevel };
}

export function clearRoleMapping(guildId, level) {
  return getDb()
    .prepare('DELETE FROM exile_roles WHERE guild_id = ? AND level = ?')
    .run(guildId, level).changes;
}

/**
 * Every role the bot treats as an exile role: mapped levels plus roles that
 * were set up but not mapped (or were unmapped later). Used when releasing so
 * a stale role cannot be left behind.
 */
export function allExileRoleIds(guildId) {
  return getDb()
    .prepare(
      `SELECT role_id FROM exile_roles WHERE guild_id = ?
       UNION
       SELECT role_id FROM exile_setups WHERE guild_id = ?`,
    )
    .all(guildId, guildId)
    .map((row) => row.role_id);
}

// --- per-role exceptions ----------------------------------------------------

export function listExceptionIds(guildId, roleId) {
  return getDb()
    .prepare(
      'SELECT channel_id FROM exile_channels WHERE guild_id = ? AND role_id = ? ORDER BY channel_id',
    )
    .all(guildId, roleId)
    .map((row) => row.channel_id);
}

/** Replaces the whole list, because setup is the source of truth. */
export function replaceExceptions(guildId, roleId, channelIds) {
  const db = getDb();
  const unique = [...new Set(channelIds.filter(Boolean))];

  db.exec('BEGIN');

  try {
    db.prepare('DELETE FROM exile_channels WHERE guild_id = ? AND role_id = ?').run(
      guildId,
      roleId,
    );

    const insert = db.prepare(
      'INSERT INTO exile_channels (guild_id, role_id, channel_id) VALUES (?, ?, ?)',
    );

    for (const channelId of unique) insert.run(guildId, roleId, channelId);

    db.exec('COMMIT');
    return unique;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function addException(guildId, roleId, channelId) {
  return getDb()
    .prepare(
      `INSERT INTO exile_channels (guild_id, role_id, channel_id) VALUES (?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(guildId, roleId, channelId).changes;
}

export function removeException(guildId, roleId, channelId) {
  return getDb()
    .prepare(
      'DELETE FROM exile_channels WHERE guild_id = ? AND role_id = ? AND channel_id = ?',
    )
    .run(guildId, roleId, channelId).changes;
}

/** A deleted channel must not linger in any role's exception list. */
export function removeChannelFromExceptions(guildId, channelId) {
  return getDb()
    .prepare('DELETE FROM exile_channels WHERE guild_id = ? AND channel_id = ?')
    .run(guildId, channelId).changes;
}

// --- active exiles ----------------------------------------------------------

function mapExile(row) {
  if (!row) return null;

  return {
    id: row.id,
    guildId: row.guild_id,
    userId: row.user_id,
    level: row.level,
    roleId: row.role_id,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    releasedBy: row.released_by,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
  };
}

export function getActiveExile(guildId, userId) {
  return mapExile(
    getDb()
      .prepare(
        'SELECT * FROM exiles WHERE guild_id = ? AND user_id = ? AND released_at IS NULL',
      )
      .get(guildId, userId),
  );
}

export function listActiveExiles(guildId) {
  return getDb()
    .prepare(
      'SELECT * FROM exiles WHERE guild_id = ? AND released_at IS NULL ORDER BY created_at DESC',
    )
    .all(guildId)
    .map(mapExile);
}

export function countActiveExiles(guildId) {
  return (
    getDb()
      .prepare(
        'SELECT COUNT(*) AS total FROM exiles WHERE guild_id = ? AND released_at IS NULL',
      )
      .get(guildId)?.total ?? 0
  );
}

export function createExile({ guildId, userId, level, roleId, reason, createdBy }) {
  const info = getDb()
    .prepare(
      `INSERT INTO exiles (guild_id, user_id, level, role_id, reason, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(guildId, userId, level, roleId, reason ?? null, createdBy, Date.now());

  return mapExile(
    getDb().prepare('SELECT * FROM exiles WHERE id = ?').get(Number(info.lastInsertRowid)),
  );
}

/** Changing a level keeps one active row instead of stacking exiles. */
export function updateActiveExile({ guildId, userId, level, roleId, reason, createdBy }) {
  getDb()
    .prepare(
      `UPDATE exiles SET level = ?, role_id = ?, reason = ?, created_by = ?
       WHERE guild_id = ? AND user_id = ? AND released_at IS NULL`,
    )
    .run(level, roleId, reason ?? null, createdBy, guildId, userId);

  return getActiveExile(guildId, userId);
}

/**
 * Marks the active exile released. Returns the row as it was, so the caller can
 * report the level and reason without a second lookup.
 */
export function releaseActiveExile({ guildId, userId, releasedBy, reason }) {
  const db = getDb();
  const active = getActiveExile(guildId, userId);

  if (!active) return null;

  db.prepare(
    `UPDATE exiles SET released_by = ?, released_at = ?, release_reason = ?
     WHERE id = ? AND released_at IS NULL`,
  ).run(releasedBy, Date.now(), reason ?? null, active.id);

  return active;
}
