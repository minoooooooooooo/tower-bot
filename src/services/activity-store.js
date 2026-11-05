import { config } from '../config.js';
import { dateKey } from '../lib/dates.js';
import { getDb } from '../lib/db.js';

const DAY_MS = 86_400_000;

/** YYYY-MM-DD in the bot's configured zone, used for every daily bucket. */
export function activityDay(at = Date.now()) {
  return dateKey(new Date(at), config.timezone);
}

/**
 * First day included by a period. `all` has no start day and is answered from
 * the all-time totals instead of the daily buckets.
 */
export function periodStart(period, now = Date.now()) {
  if (period === '7d') return activityDay(now - 6 * DAY_MS);
  if (period === '30d') return activityDay(now - 29 * DAY_MS);
  return null;
}

function transaction(fn) {
  const db = getDb();
  db.exec('BEGIN');

  try {
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function ensureMeta(db, guildId, at) {
  db.prepare(
    `INSERT INTO activity_meta (guild_id, tracking_since, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT (guild_id) DO UPDATE SET updated_at = excluded.updated_at`,
  ).run(guildId, at, at);
}

/**
 * Counts one human message. Thread messages land on their parent channel so a
 * busy help thread does not hide the channel that spawned it.
 */
export function recordMessage({ guildId, userId, channelId, at = Date.now() }) {
  if (!guildId || !userId || !channelId) return;

  const day = activityDay(at);

  transaction((db) => {
    ensureMeta(db, guildId, at);

    db.prepare(
      `INSERT INTO activity_members
         (guild_id, user_id, messages, voice_seconds, first_message_at, last_message_at, last_active_at)
       VALUES (?, ?, 1, 0, ?, ?, ?)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET
         messages = messages + 1,
         first_message_at = COALESCE(first_message_at, excluded.first_message_at),
         last_message_at = excluded.last_message_at,
         last_active_at = excluded.last_active_at`,
    ).run(guildId, userId, at, at, at);

    db.prepare(
      `INSERT INTO activity_member_days (guild_id, user_id, day, messages, voice_seconds)
       VALUES (?, ?, ?, 1, 0)
       ON CONFLICT (guild_id, user_id, day) DO UPDATE SET messages = messages + 1`,
    ).run(guildId, userId, day);

    db.prepare(
      `INSERT INTO activity_channels (guild_id, channel_id, messages, voice_seconds, last_message_at)
       VALUES (?, ?, 1, 0, ?)
       ON CONFLICT (guild_id, channel_id) DO UPDATE SET
         messages = messages + 1,
         last_message_at = excluded.last_message_at`,
    ).run(guildId, channelId, at);

    db.prepare(
      `INSERT INTO activity_channel_days (guild_id, channel_id, day, messages, voice_seconds)
       VALUES (?, ?, ?, 1, 0)
       ON CONFLICT (guild_id, channel_id, day) DO UPDATE SET messages = messages + 1`,
    ).run(guildId, channelId, day);
  });
}

/**
 * Opens (or replaces) a voice session. The caller closes the old session first
 * when a member moves between channels, so replacements only happen after a
 * restart left a stale row behind.
 */
export function startVoiceSession({ guildId, userId, channelId, at = Date.now() }) {
  if (!guildId || !userId || !channelId) return;

  transaction((db) => {
    ensureMeta(db, guildId, at);

    db.prepare(
      `INSERT INTO activity_voice_sessions (guild_id, user_id, channel_id, joined_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET
         channel_id = excluded.channel_id,
         joined_at = excluded.joined_at,
         last_seen_at = excluded.last_seen_at`,
    ).run(guildId, userId, channelId, at, at);
  });
}

/**
 * Marks every open session as alive. The heartbeat bounds what a hard crash can
 * overcount: on restart a session is closed at its last heartbeat, not at the
 * time the process happened to die.
 */
export function touchVoiceSessions(at = Date.now()) {
  getDb()
    .prepare('UPDATE activity_voice_sessions SET last_seen_at = ? WHERE last_seen_at < ?')
    .run(at, at);
}

export function listVoiceSessions() {
  return getDb()
    .prepare(
      `SELECT guild_id AS guildId, user_id AS userId, channel_id AS channelId,
              joined_at AS joinedAt, last_seen_at AS lastSeenAt
       FROM activity_voice_sessions`,
    )
    .all();
}

function closeSession(db, row, at) {
  const seconds = Math.max(0, Math.round((at - row.joinedAt) / 1000));
  const day = activityDay(at);

  if (seconds > 0) {
    db.prepare(
      `INSERT INTO activity_members
         (guild_id, user_id, messages, voice_seconds, first_message_at, last_message_at, last_active_at)
       VALUES (?, ?, 0, ?, NULL, NULL, ?)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET
         voice_seconds = voice_seconds + excluded.voice_seconds,
         last_active_at = MAX(COALESCE(last_active_at, 0), excluded.last_active_at)`,
    ).run(row.guildId, row.userId, seconds, at);

    db.prepare(
      `INSERT INTO activity_member_days (guild_id, user_id, day, messages, voice_seconds)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT (guild_id, user_id, day) DO UPDATE SET
         voice_seconds = voice_seconds + excluded.voice_seconds`,
    ).run(row.guildId, row.userId, day, seconds);

    db.prepare(
      `INSERT INTO activity_channels (guild_id, channel_id, messages, voice_seconds, last_message_at)
       VALUES (?, ?, 0, ?, NULL)
       ON CONFLICT (guild_id, channel_id) DO UPDATE SET
         voice_seconds = voice_seconds + excluded.voice_seconds`,
    ).run(row.guildId, row.channelId, seconds);

    db.prepare(
      `INSERT INTO activity_channel_days (guild_id, channel_id, day, messages, voice_seconds)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT (guild_id, channel_id, day) DO UPDATE SET
         voice_seconds = voice_seconds + excluded.voice_seconds`,
    ).run(row.guildId, row.channelId, day, seconds);
  }

  db.prepare('DELETE FROM activity_voice_sessions WHERE guild_id = ? AND user_id = ?').run(
    row.guildId,
    row.userId,
  );

  return seconds;
}

/**
 * Closes one session and folds the elapsed time into the totals. Ending at
 * `lastSeenAt` after a crash avoids counting the bot's downtime.
 */
export function finishVoiceSession(guildId, userId, at = Date.now()) {
  const row = getDb()
    .prepare(
      `SELECT guild_id AS guildId, user_id AS userId, channel_id AS channelId,
              joined_at AS joinedAt, last_seen_at AS lastSeenAt
       FROM activity_voice_sessions
       WHERE guild_id = ? AND user_id = ?`,
    )
    .get(guildId, userId);

  if (!row) return 0;

  return transaction((db) => closeSession(db, row, at));
}

/** Closes every open session (shutdown) or just one server's. */
export function finishAllVoiceSessions(at = Date.now(), guildId = null) {
  const db = getDb();
  const rows = guildId
    ? db
        .prepare(
          `SELECT guild_id AS guildId, user_id AS userId, channel_id AS channelId,
                  joined_at AS joinedAt, last_seen_at AS lastSeenAt
           FROM activity_voice_sessions WHERE guild_id = ?`,
        )
        .all(guildId)
    : db
        .prepare(
          `SELECT guild_id AS guildId, user_id AS userId, channel_id AS channelId,
                  joined_at AS joinedAt, last_seen_at AS lastSeenAt
           FROM activity_voice_sessions`,
        )
        .all();

  if (rows.length === 0) return 0;

  return transaction((db) => {
    let total = 0;

    for (const row of rows) {
      ensureMeta(db, row.guildId, at);
      total += closeSession(db, row, at);
    }

    return total;
  });
}

/** All-time ranking, or the sum of the daily buckets for a period. */
export function topMembers(guildId, { metric = 'messages', since = null, limit = 10 } = {}) {
  const db = getDb();
  const column = metric === 'voice' ? 'voice_seconds' : 'messages';
  const capped = Math.max(1, Math.min(25, Number(limit) || 10));

  if (!since) {
    return db
      .prepare(
        `SELECT user_id AS userId, messages, voice_seconds AS voiceSeconds
         FROM activity_members
         WHERE guild_id = ? AND ${column} > 0
         ORDER BY ${column} DESC, user_id ASC
         LIMIT ?`,
      )
      .all(guildId, capped);
  }

  return db
    .prepare(
      `SELECT user_id AS userId,
              SUM(messages) AS messages,
              SUM(voice_seconds) AS voiceSeconds
       FROM activity_member_days
       WHERE guild_id = ? AND day >= ?
       GROUP BY user_id
       HAVING SUM(${column}) > 0
       ORDER BY SUM(${column}) DESC, user_id ASC
       LIMIT ?`,
    )
    .all(guildId, since, capped);
}

export function topChannels(guildId, { since = null, limit = 10 } = {}) {
  const db = getDb();
  const capped = Math.max(1, Math.min(25, Number(limit) || 10));

  if (!since) {
    return db
      .prepare(
        `SELECT channel_id AS channelId, messages, voice_seconds AS voiceSeconds
         FROM activity_channels
         WHERE guild_id = ? AND messages > 0
         ORDER BY messages DESC, channel_id ASC
         LIMIT ?`,
      )
      .all(guildId, capped);
  }

  return db
    .prepare(
      `SELECT channel_id AS channelId,
              SUM(messages) AS messages,
              SUM(voice_seconds) AS voiceSeconds
       FROM activity_channel_days
       WHERE guild_id = ? AND day >= ?
       GROUP BY channel_id
       HAVING SUM(messages) > 0
       ORDER BY SUM(messages) DESC, channel_id ASC
       LIMIT ?`,
    )
    .all(guildId, since, capped);
}

function rowOrZero(row) {
  return {
    messages: row?.messages ?? 0,
    voiceSeconds: row?.voiceSeconds ?? 0,
    firstMessageAt: row?.firstMessageAt ?? null,
    lastMessageAt: row?.lastMessageAt ?? null,
    lastActiveAt: row?.lastActiveAt ?? null,
  };
}

/**
 * One member's totals, plus the requested period when `since` is given.
 * First/last timestamps always come from the all-time row.
 */
export function memberStats(guildId, userId, since = null) {
  const db = getDb();

  const total = db
    .prepare(
      `SELECT messages, voice_seconds AS voiceSeconds,
              first_message_at AS firstMessageAt,
              last_message_at AS lastMessageAt,
              last_active_at AS lastActiveAt
       FROM activity_members
       WHERE guild_id = ? AND user_id = ?`,
    )
    .get(guildId, userId);

  const period = since
    ? db
        .prepare(
          `SELECT COALESCE(SUM(messages), 0) AS messages,
                  COALESCE(SUM(voice_seconds), 0) AS voiceSeconds
           FROM activity_member_days
           WHERE guild_id = ? AND user_id = ? AND day >= ?`,
        )
        .get(guildId, userId, since)
    : null;

  return {
    ...rowOrZero(total),
    period: period
      ? { messages: period.messages ?? 0, voiceSeconds: period.voiceSeconds ?? 0 }
      : null,
  };
}

export function trackingSince(guildId) {
  return (
    getDb()
      .prepare('SELECT tracking_since AS trackingSince FROM activity_meta WHERE guild_id = ?')
      .get(guildId)?.trackingSince ?? null
  );
}

/** Totals for one channel, including voice time that the message leaderboard ignores. */
export function channelStats(guildId, channelId) {
  const row = getDb()
    .prepare(
      `SELECT messages, voice_seconds AS voiceSeconds, last_message_at AS lastMessageAt
       FROM activity_channels
       WHERE guild_id = ? AND channel_id = ?`,
    )
    .get(guildId, channelId);

  return {
    messages: row?.messages ?? 0,
    voiceSeconds: row?.voiceSeconds ?? 0,
    lastMessageAt: row?.lastMessageAt ?? null,
  };
}

/** Totals for the leaderboard header and `/serverstats`. */
export function serverTotals(guildId, since = null) {
  const db = getDb();

  const members = since
    ? db
        .prepare(
          `SELECT COUNT(DISTINCT user_id) AS members,
                  COALESCE(SUM(messages), 0) AS messages,
                  COALESCE(SUM(voice_seconds), 0) AS voiceSeconds
           FROM activity_member_days
           WHERE guild_id = ? AND day >= ? AND (messages > 0 OR voice_seconds > 0)`,
        )
        .get(guildId, since)
    : db
        .prepare(
          `SELECT COUNT(*) AS members,
                  COALESCE(SUM(messages), 0) AS messages,
                  COALESCE(SUM(voice_seconds), 0) AS voiceSeconds
           FROM activity_members
           WHERE guild_id = ? AND (messages > 0 OR voice_seconds > 0)`,
        )
        .get(guildId);

  const channels = since
    ? db
        .prepare(
          `SELECT COUNT(DISTINCT channel_id) AS channels
           FROM activity_channel_days
           WHERE guild_id = ? AND day >= ? AND messages > 0`,
        )
        .get(guildId, since)
    : db
        .prepare(
          `SELECT COUNT(*) AS channels
           FROM activity_channels
           WHERE guild_id = ? AND messages > 0`,
        )
        .get(guildId);

  return {
    members: members?.members ?? 0,
    messages: members?.messages ?? 0,
    voiceSeconds: members?.voiceSeconds ?? 0,
    channels: channels?.channels ?? 0,
  };
}
