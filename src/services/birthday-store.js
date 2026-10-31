import { getDb } from '../lib/db.js';

function mapBirthday(row) {
  if (!row) return null;
  return {
    guildId: row.guild_id,
    userId: row.user_id,
    month: row.month,
    day: row.day,
    year: row.year ?? null,
    timezone: row.timezone ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAssignment(row) {
  if (!row) return null;
  return {
    guildId: row.guild_id,
    userId: row.user_id,
    roleId: row.role_id,
    dateKey: row.date_key,
  };
}

export function setBirthday(guildId, userId, { month, day, year = null }) {
  const now = Date.now();

  getDb()
    .prepare(
      `INSERT INTO birthdays (guild_id, user_id, month, day, year, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET
         month = excluded.month,
         day = excluded.day,
         year = excluded.year,
         updated_at = excluded.updated_at`,
    )
    .run(guildId, userId, month, day, year, now, now);
}

export function removeBirthday(guildId, userId) {
  const result = getDb()
    .prepare('DELETE FROM birthdays WHERE guild_id = ? AND user_id = ?')
    .run(guildId, userId);

  return result.changes > 0;
}

/**
 * Stores a per-member time zone override. Returns false when the member has not
 * registered a birthday yet, since the row does not exist.
 */
export function setBirthdayTimezone(guildId, userId, timezone) {
  const result = getDb()
    .prepare(
      'UPDATE birthdays SET timezone = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
    )
    .run(timezone, Date.now(), guildId, userId);

  return result.changes > 0;
}

export function getBirthday(guildId, userId) {
  return mapBirthday(
    getDb()
      .prepare('SELECT * FROM birthdays WHERE guild_id = ? AND user_id = ?')
      .get(guildId, userId),
  );
}

export function listBirthdays(guildId) {
  return getDb()
    .prepare('SELECT * FROM birthdays WHERE guild_id = ?')
    .all(guildId)
    .map(mapBirthday);
}

export function listBirthdaysInMonth(guildId, month) {
  return getDb()
    .prepare('SELECT * FROM birthdays WHERE guild_id = ? AND month = ?')
    .all(guildId, month)
    .map(mapBirthday);
}

export function countBirthdays(guildId) {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS total FROM birthdays WHERE guild_id = ?')
    .get(guildId);

  return Number(row?.total ?? 0);
}

export function getGuildSettings(guildId) {
  const row = getDb()
    .prepare(
      `SELECT birthday_role_id, timezone, birthday_channel_id, birthday_message, birthday_gif_url
       FROM guild_settings WHERE guild_id = ?`,
    )
    .get(guildId);

  return {
    birthdayRoleId: row?.birthday_role_id ?? null,
    timezone: row?.timezone ?? null,
    birthdayChannelId: row?.birthday_channel_id ?? null,
    birthdayMessage: row?.birthday_message ?? null,
    birthdayGifUrl: row?.birthday_gif_url ?? null,
  };
}

export function setGuildRole(guildId, roleId) {
  getDb()
    .prepare(
      `INSERT INTO guild_settings (guild_id, birthday_role_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET
         birthday_role_id = excluded.birthday_role_id,
         updated_at = excluded.updated_at`,
    )
    .run(guildId, roleId, Date.now());
}

export function setGuildTimezone(guildId, timezone) {
  getDb()
    .prepare(
      `INSERT INTO guild_settings (guild_id, timezone, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET
         timezone = excluded.timezone,
         updated_at = excluded.updated_at`,
    )
    .run(guildId, timezone, Date.now());
}

export function setGuildChannel(guildId, channelId) {
  getDb()
    .prepare(
      `INSERT INTO guild_settings (guild_id, birthday_channel_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET
         birthday_channel_id = excluded.birthday_channel_id,
         updated_at = excluded.updated_at`,
    )
    .run(guildId, channelId, Date.now());
}

export function setGuildMessage(guildId, message) {
  getDb()
    .prepare(
      `INSERT INTO guild_settings (guild_id, birthday_message, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET
         birthday_message = excluded.birthday_message,
         updated_at = excluded.updated_at`,
    )
    .run(guildId, message, Date.now());
}

export function setGuildGif(guildId, gifUrl) {
  getDb()
    .prepare(
      `INSERT INTO guild_settings (guild_id, birthday_gif_url, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET
         birthday_gif_url = excluded.birthday_gif_url,
         updated_at = excluded.updated_at`,
    )
    .run(guildId, gifUrl, Date.now());
}

export function getAssignment(guildId, userId) {
  return mapAssignment(
    getDb()
      .prepare('SELECT * FROM birthday_assignments WHERE guild_id = ? AND user_id = ?')
      .get(guildId, userId),
  );
}

export function upsertAssignment(guildId, userId, roleId, dateKey) {
  getDb()
    .prepare(
      `INSERT INTO birthday_assignments (guild_id, user_id, role_id, date_key)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET
         role_id = excluded.role_id,
         date_key = excluded.date_key`,
    )
    .run(guildId, userId, roleId, dateKey);
}

export function deleteAssignment(guildId, userId) {
  getDb()
    .prepare('DELETE FROM birthday_assignments WHERE guild_id = ? AND user_id = ?')
    .run(guildId, userId);
}

export function listAssignments(guildId) {
  return getDb()
    .prepare('SELECT * FROM birthday_assignments WHERE guild_id = ?')
    .all(guildId)
    .map(mapAssignment);
}

export function listStaleAssignments(guildId, currentDateKey) {
  return getDb()
    .prepare('SELECT * FROM birthday_assignments WHERE guild_id = ? AND date_key <> ?')
    .all(guildId, currentDateKey)
    .map(mapAssignment);
}

export function deleteAssignmentsForRole(guildId, roleId) {
  getDb()
    .prepare('DELETE FROM birthday_assignments WHERE guild_id = ? AND role_id = ?')
    .run(guildId, roleId);
}

export function hasGreeting(guildId, userId, dateKey) {
  const row = getDb()
    .prepare(
      'SELECT 1 AS sent FROM birthday_greetings WHERE guild_id = ? AND user_id = ? AND date_key = ?',
    )
    .get(guildId, userId, dateKey);

  return Boolean(row);
}

/**
 * Atomically reserves today's greeting for a member. Returns false when another
 * pass already claimed it, which prevents two concurrent reconciles (startup +
 * a live /birthday set) from posting twice.
 */
export function claimGreeting(guildId, userId, dateKey, channelId) {
  const result = getDb()
    .prepare(
      `INSERT INTO birthday_greetings (guild_id, user_id, date_key, channel_id, sent_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, user_id, date_key) DO NOTHING`,
    )
    .run(guildId, userId, dateKey, channelId, Date.now());

  return result.changes > 0;
}

/**
 * Gives the claim back when the message could not be sent, so the next pass
 * retries instead of silently skipping the member.
 */
export function releaseGreeting(guildId, userId, dateKey) {
  getDb()
    .prepare(
      'DELETE FROM birthday_greetings WHERE guild_id = ? AND user_id = ? AND date_key = ?',
    )
    .run(guildId, userId, dateKey);
}
