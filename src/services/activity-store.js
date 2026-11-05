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
    `INSERT INTO activity_meta (guild_id, tracking_since, messages_since, voice_since, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (guild_id) DO UPDATE SET updated_at = excluded.updated_at`,
  ).run(guildId, at, at, at, at);
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

function coverageDate(guildId, column) {
  return (
    getDb()
      .prepare(
        `SELECT COALESCE(${column}, tracking_since) AS value
         FROM activity_meta WHERE guild_id = ?`,
      )
      .get(guildId)?.value ?? null
  );
}

/** Earliest counted message, including imported history. */
export function messagesSince(guildId) {
  return coverageDate(guildId, 'messages_since');
}

/** Voice tracking cannot be replayed, so this stays at the live start. */
export function voiceSince(guildId) {
  return coverageDate(guildId, 'voice_since');
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

/**
 * Folds one fetched page of older messages into the same totals, day buckets and
 * channel rows the live tracker writes. Everything happens in one transaction
 * together with the cursor advance, so a crash either keeps the page and the
 * cursor together or repeats neither.
 *
 * `messages` is a plain array of `{ userId, at }`, already filtered to human,
 * non-system messages older than the live tracking start.
 */
export function recordBackfillPage({
  guildId,
  channelId,
  cursorId = null,
  done = false,
  messages = [],
  at = Date.now(),
}) {
  if (!guildId || !channelId) return { messages: 0, oldestAt: null };

  const byUser = new Map();
  const byMemberDay = new Map();
  const byChannelDay = new Map();
  let channelMessages = 0;
  let channelLast = 0;
  let oldestAt = null;

  for (const message of messages) {
    if (!message?.userId || !message?.at) continue;

    const time = message.at;
    const day = activityDay(time);
    const user = byUser.get(message.userId) ?? {
      count: 0,
      first: time,
      last: time,
    };

    user.count += 1;
    if (time < user.first) user.first = time;
    if (time > user.last) user.last = time;
    byUser.set(message.userId, user);

    const memberDayKey = `${message.userId}\u0000${day}`;
    byMemberDay.set(memberDayKey, (byMemberDay.get(memberDayKey) ?? 0) + 1);
    byChannelDay.set(day, (byChannelDay.get(day) ?? 0) + 1);

    channelMessages += 1;
    if (time > channelLast) channelLast = time;
    if (oldestAt === null || time < oldestAt) oldestAt = time;
  }

  transaction((db) => {
    ensureMeta(db, guildId, at);

    const memberStatement = db.prepare(
      `INSERT INTO activity_members
         (guild_id, user_id, messages, voice_seconds, first_message_at, last_message_at, last_active_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET
         messages = messages + excluded.messages,
         first_message_at = MIN(COALESCE(first_message_at, excluded.first_message_at), excluded.first_message_at),
         last_message_at = MAX(COALESCE(last_message_at, 0), excluded.last_message_at),
         last_active_at = MAX(COALESCE(last_active_at, 0), excluded.last_active_at)`,
    );

    for (const [userId, user] of byUser) {
      memberStatement.run(guildId, userId, user.count, user.first, user.last, user.last);
    }

    const memberDayStatement = db.prepare(
      `INSERT INTO activity_member_days (guild_id, user_id, day, messages, voice_seconds)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT (guild_id, user_id, day) DO UPDATE SET
         messages = messages + excluded.messages`,
    );

    for (const [key, count] of byMemberDay) {
      const [userId, day] = key.split('\u0000');
      memberDayStatement.run(guildId, userId, day, count);
    }

    if (channelMessages > 0) {
      db.prepare(
        `INSERT INTO activity_channels
           (guild_id, channel_id, messages, voice_seconds, last_message_at)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT (guild_id, channel_id) DO UPDATE SET
           messages = messages + excluded.messages,
           last_message_at = MAX(COALESCE(last_message_at, 0), excluded.last_message_at)`,
      ).run(guildId, channelId, channelMessages, channelLast);

      const channelDayStatement = db.prepare(
        `INSERT INTO activity_channel_days (guild_id, channel_id, day, messages, voice_seconds)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT (guild_id, channel_id, day) DO UPDATE SET
           messages = messages + excluded.messages`,
      );

      for (const [day, count] of byChannelDay) {
        channelDayStatement.run(guildId, channelId, day, count);
      }

      // The import reaches further back than the live window, so the reported
      // message coverage has to move with it.
      db.prepare(
        `UPDATE activity_meta
         SET messages_since = MIN(COALESCE(messages_since, ?), ?)
         WHERE guild_id = ?`,
      ).run(oldestAt, oldestAt, guildId);
    }

    db.prepare(
      `INSERT INTO activity_backfill
         (guild_id, channel_id, cursor_id, oldest_at, done, fetched, error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT (guild_id, channel_id) DO UPDATE SET
         cursor_id = COALESCE(excluded.cursor_id, activity_backfill.cursor_id),
         oldest_at = CASE
           WHEN excluded.oldest_at IS NULL THEN activity_backfill.oldest_at
           WHEN activity_backfill.oldest_at IS NULL THEN excluded.oldest_at
           ELSE MIN(activity_backfill.oldest_at, excluded.oldest_at)
         END,
         done = excluded.done,
         fetched = activity_backfill.fetched + excluded.fetched,
         error = NULL,
         updated_at = excluded.updated_at`,
    ).run(
      guildId,
      channelId,
      cursorId,
      oldestAt,
      done ? 1 : 0,
      channelMessages,
      at,
    );
  });

  return { messages: channelMessages, oldestAt };
}

export function backfillChannel(guildId, channelId) {
  return (
    getDb()
      .prepare(
        `SELECT cursor_id AS cursorId, oldest_at AS oldestAt, done, fetched, error
         FROM activity_backfill
         WHERE guild_id = ? AND channel_id = ?`,
      )
      .get(guildId, channelId) ?? null
  );
}

export function markBackfillDone(guildId, channelId, at = Date.now()) {
  getDb()
    .prepare(
      `INSERT INTO activity_backfill (guild_id, channel_id, done, fetched, updated_at)
       VALUES (?, ?, 1, 0, ?)
       ON CONFLICT (guild_id, channel_id) DO UPDATE SET
         done = 1,
         error = NULL,
         updated_at = excluded.updated_at`,
    )
    .run(guildId, channelId, at);
}

export function markBackfillError(guildId, channelId, message, at = Date.now()) {
  getDb()
    .prepare(
      `INSERT INTO activity_backfill (guild_id, channel_id, done, fetched, error, updated_at)
       VALUES (?, ?, 0, 0, ?, ?)
       ON CONFLICT (guild_id, channel_id) DO UPDATE SET
         done = 0,
         error = excluded.error,
         updated_at = excluded.updated_at`,
    )
    .run(guildId, channelId, String(message ?? 'unknown error').slice(0, 500), at);
}

/** Progress for `/backfill status`; survives restarts because it is in SQLite. */
export function backfillStats(guildId) {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS channels,
              COALESCE(SUM(CASE WHEN done = 1 THEN 1 ELSE 0 END), 0) AS done,
              COALESCE(SUM(fetched), 0) AS fetched,
              COALESCE(SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END), 0) AS errors,
              MIN(oldest_at) AS oldestAt,
              MAX(updated_at) AS updatedAt
       FROM activity_backfill
       WHERE guild_id = ?`,
    )
    .get(guildId);

  return {
    channels: row?.channels ?? 0,
    done: row?.done ?? 0,
    fetched: row?.fetched ?? 0,
    errors: row?.errors ?? 0,
    oldestAt: row?.oldestAt ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}
