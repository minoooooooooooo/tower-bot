import { config } from '../config.js';
import { dateKey } from '../lib/dates.js';
import { getDb } from '../lib/db.js';
import { periodStart } from './activity-store.js';

const EMOJI_SOURCE = '<a?:([A-Za-z0-9_]+):([A-Za-z0-9_]+)>';

/**
 * Every custom emoji token in a message, in order. Unicode emojis are not
 * included: the feature ranks a server's custom emojis, which have a stable id
 * that survives renames.
 */
export function parseEmojis(content) {
  const text = typeof content === 'string' ? content : '';
  const pattern = new RegExp(EMOJI_SOURCE, 'g');
  const tokens = [];
  let match;

  while ((match = pattern.exec(text)) !== null) {
    tokens.push({
      id: match[2],
      name: match[1],
      animated: match[0].startsWith('<a:'),
    });
  }

  return tokens;
}

/**
 * A standalone emoji message contains nothing except custom emoji tokens and
 * whitespace. Anything else, including Unicode emoji or an attachment caption,
 * makes every custom emoji in that message an in-message use.
 */
export function isStandaloneEmojiMessage(content, tokens = parseEmojis(content)) {
  if (tokens.length === 0) return false;

  const stripped = String(content ?? '').replace(new RegExp(EMOJI_SOURCE, 'g'), '').trim();
  return stripped.length === 0;
}

/** YYYY-MM-DD in the bot's configured zone, matching activity buckets. */
export function emojiDay(at = Date.now()) {
  return dateKey(new Date(at), config.timezone);
}

/** First day included by an emoji period. `all` has no start day. */
export function emojiPeriodStart(period, now = Date.now()) {
  if (period === '1d') return emojiDay(now);
  if (period === '7d') return periodStart('7d', now);
  if (period === '30d') return periodStart('30d', now);
  return null;
}

export const EMOJI_PERIOD_LABELS = {
  '1d': 'Today',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  all: 'All time',
};

export function emojiPeriodLabel(period) {
  return EMOJI_PERIOD_LABELS[period] ?? EMOJI_PERIOD_LABELS.all;
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
    `INSERT INTO emoji_meta (guild_id, tracking_since, backfilled_since, updated_at)
     VALUES (?, ?, NULL, ?)
     ON CONFLICT (guild_id) DO UPDATE SET updated_at = excluded.updated_at`,
  ).run(guildId, at, at);
}

/**
 * Starts the live clock the first time an emoji is actually counted. Creating
 * it on login instead would be wrong after an upgrade: messages with emojis
 * from before the feature existed would look "already counted" and could never
 * be imported.
 */
export function ensureEmojiTracking(guildId, at = Date.now()) {
  transaction((db) => ensureMeta(db, guildId, at));
  return emojiTrackingSince(guildId) ?? at;
}

export function emojiTrackingSince(guildId) {
  return (
    getDb()
      .prepare('SELECT tracking_since AS trackingSince FROM emoji_meta WHERE guild_id = ?')
      .get(guildId)?.trackingSince ?? null
  );
}

export function emojiBackfilledSince(guildId) {
  return (
    getDb()
      .prepare('SELECT backfilled_since AS backfilledSince FROM emoji_meta WHERE guild_id = ?')
      .get(guildId)?.backfilledSince ?? null
  );
}

function emptyCounts(token, count) {
  return {
    emojiId: token.id,
    emojiName: token.name,
    animated: token.animated ? 1 : 0,
    inline: count,
    standalone: 0,
    lastUsedAt: 0,
  };
}

/**
 * Counts every custom emoji in one human message. The whole message is either
 * standalone or in-message, never a mixture, so the two buckets add up to the
 * number of tokens the member actually sent.
 */
export function recordEmojiMessage({ guildId, content, at = Date.now() }) {
  if (!guildId) return 0;

  const tokens = parseEmojis(content);
  if (tokens.length === 0) return 0;

  const standalone = isStandaloneEmojiMessage(content, tokens);
  const counts = new Map();

  for (const token of tokens) {
    const row = counts.get(token.id) ?? emptyCounts(token, 0);
    row.lastUsedAt = at;

    if (standalone) row.standalone += 1;
    else row.inline += 1;

    counts.set(token.id, row);
  }

  const day = emojiDay(at);

  transaction((db) => {
    ensureMeta(db, guildId, at);

    const usage = db.prepare(
      `INSERT INTO emoji_usage
         (guild_id, emoji_id, day, inline_count, standalone_count, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, emoji_id, day) DO UPDATE SET
         inline_count = inline_count + excluded.inline_count,
         standalone_count = standalone_count + excluded.standalone_count,
         last_used_at = MAX(last_used_at, excluded.last_used_at)`,
    );
    const catalog = db.prepare(
      `INSERT INTO emoji_catalog
         (guild_id, emoji_id, emoji_name, animated, first_seen_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, emoji_id) DO UPDATE SET
         emoji_name = CASE
           WHEN excluded.last_used_at >= emoji_catalog.last_used_at
             THEN excluded.emoji_name
           ELSE emoji_catalog.emoji_name
         END,
         animated = CASE
           WHEN excluded.last_used_at >= emoji_catalog.last_used_at
             THEN excluded.animated
           ELSE emoji_catalog.animated
         END,
         first_seen_at = MIN(emoji_catalog.first_seen_at, excluded.first_seen_at),
         last_used_at = MAX(emoji_catalog.last_used_at, excluded.last_used_at)`,
    );

    for (const row of counts.values()) {
      usage.run(guildId, row.emojiId, day, row.inline, row.standalone, at);
      catalog.run(
        guildId,
        row.emojiId,
        row.emojiName,
        row.animated,
        at,
        at,
      );
    }
  });

  return tokens.length;
}

/**
 * Folds one fetched page of older messages into the same daily buckets as live
 * tracking. The counts, cursor and `backfilled_since` change together, so a
 * crash either keeps the whole page or repeats none of it.
 *
 * `messages` is `{ content, at }` for human, non-system messages older than the
 * live emoji boundary.
 */
export function recordEmojiBackfillPage({
  guildId,
  channelId,
  cursorId = null,
  done = false,
  messages = [],
  at = Date.now(),
}) {
  if (!guildId || !channelId) {
    return { messages: 0, emojiUses: 0, oldestAt: null };
  }

  const usageRows = new Map();
  const catalogRows = new Map();
  let oldestAt = null;
  let emojiUses = 0;

  for (const message of messages) {
    if (!message?.at) continue;

    if (oldestAt === null || message.at < oldestAt) oldestAt = message.at;

    const tokens = parseEmojis(message.content);
    if (tokens.length === 0) continue;

    const standalone = isStandaloneEmojiMessage(message.content, tokens);
    const day = emojiDay(message.at);

    for (const token of tokens) {
      const key = `${token.id}\u0000${day}`;
      const row = usageRows.get(key) ?? {
        emojiId: token.id,
        day,
        inline: 0,
        standalone: 0,
        lastUsedAt: 0,
      };

      if (standalone) row.standalone += 1;
      else row.inline += 1;
      if (message.at > row.lastUsedAt) row.lastUsedAt = message.at;
      usageRows.set(key, row);

      const known = catalogRows.get(token.id);
      const isNewer = !known || message.at >= known.lastUsedAt;

      catalogRows.set(token.id, {
        emojiId: token.id,
        emojiName: isNewer ? token.name : known.emojiName,
        animated: isNewer ? (token.animated ? 1 : 0) : known.animated,
        firstSeenAt: known ? Math.min(known.firstSeenAt, message.at) : message.at,
        lastUsedAt: known ? Math.max(known.lastUsedAt, message.at) : message.at,
      });

      emojiUses += 1;
    }
  }

  transaction((db) => {
    ensureMeta(db, guildId, at);

    const usage = db.prepare(
      `INSERT INTO emoji_usage
         (guild_id, emoji_id, day, inline_count, standalone_count, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, emoji_id, day) DO UPDATE SET
         inline_count = inline_count + excluded.inline_count,
         standalone_count = standalone_count + excluded.standalone_count,
         last_used_at = MAX(last_used_at, excluded.last_used_at)`,
    );
    const catalog = db.prepare(
      `INSERT INTO emoji_catalog
         (guild_id, emoji_id, emoji_name, animated, first_seen_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, emoji_id) DO UPDATE SET
         emoji_name = CASE
           WHEN excluded.last_used_at >= emoji_catalog.last_used_at
             THEN excluded.emoji_name
           ELSE emoji_catalog.emoji_name
         END,
         animated = CASE
           WHEN excluded.last_used_at >= emoji_catalog.last_used_at
             THEN excluded.animated
           ELSE emoji_catalog.animated
         END,
         first_seen_at = MIN(emoji_catalog.first_seen_at, excluded.first_seen_at),
         last_used_at = MAX(emoji_catalog.last_used_at, excluded.last_used_at)`,
    );

    for (const row of usageRows.values()) {
      usage.run(guildId, row.emojiId, row.day, row.inline, row.standalone, row.lastUsedAt);
    }

    for (const row of catalogRows.values()) {
      catalog.run(
        guildId,
        row.emojiId,
        row.emojiName,
        row.animated,
        row.firstSeenAt,
        row.lastUsedAt,
      );
    }

    if (oldestAt !== null) {
      db.prepare(
        `UPDATE emoji_meta
         SET backfilled_since = MIN(COALESCE(backfilled_since, ?), ?)
         WHERE guild_id = ?`,
      ).run(oldestAt, oldestAt, guildId);
    }

    db.prepare(
      `INSERT INTO emoji_backfill
         (guild_id, channel_id, cursor_id, oldest_at, done, fetched, emoji_uses, error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT (guild_id, channel_id) DO UPDATE SET
         cursor_id = COALESCE(excluded.cursor_id, emoji_backfill.cursor_id),
         oldest_at = CASE
           WHEN excluded.oldest_at IS NULL THEN emoji_backfill.oldest_at
           WHEN emoji_backfill.oldest_at IS NULL THEN excluded.oldest_at
           ELSE MIN(emoji_backfill.oldest_at, excluded.oldest_at)
         END,
         done = excluded.done,
         fetched = emoji_backfill.fetched + excluded.fetched,
         emoji_uses = emoji_backfill.emoji_uses + excluded.emoji_uses,
         error = NULL,
         updated_at = excluded.updated_at`,
    ).run(
      guildId,
      channelId,
      cursorId,
      oldestAt,
      done ? 1 : 0,
      messages.length,
      emojiUses,
      at,
    );
  });

  return { messages: messages.length, emojiUses, oldestAt };
}

export function emojiBackfillChannel(guildId, channelId) {
  return (
    getDb()
      .prepare(
        `SELECT cursor_id AS cursorId, oldest_at AS oldestAt, done, fetched, emoji_uses AS emojiUses, error
         FROM emoji_backfill
         WHERE guild_id = ? AND channel_id = ?`,
      )
      .get(guildId, channelId) ?? null
  );
}

export function markEmojiBackfillDone(guildId, channelId, at = Date.now()) {
  getDb()
    .prepare(
      `INSERT INTO emoji_backfill (guild_id, channel_id, done, fetched, emoji_uses, updated_at)
       VALUES (?, ?, 1, 0, 0, ?)
       ON CONFLICT (guild_id, channel_id) DO UPDATE SET
         done = 1,
         error = NULL,
         updated_at = excluded.updated_at`,
    )
    .run(guildId, channelId, at);
}

export function markEmojiBackfillError(guildId, channelId, message, at = Date.now()) {
  getDb()
    .prepare(
      `INSERT INTO emoji_backfill (guild_id, channel_id, done, fetched, emoji_uses, error, updated_at)
       VALUES (?, ?, 0, 0, 0, ?, ?)
       ON CONFLICT (guild_id, channel_id) DO UPDATE SET
         done = 0,
         error = excluded.error,
         updated_at = excluded.updated_at`,
    )
    .run(guildId, channelId, String(message ?? 'unknown error').slice(0, 500), at);
}

export function emojiBackfillStats(guildId) {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS channels,
              COALESCE(SUM(CASE WHEN done = 1 THEN 1 ELSE 0 END), 0) AS done,
              COALESCE(SUM(fetched), 0) AS fetched,
              COALESCE(SUM(emoji_uses), 0) AS emojiUses,
              COALESCE(SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END), 0) AS errors,
              MIN(oldest_at) AS oldestAt,
              MAX(updated_at) AS updatedAt
       FROM emoji_backfill
       WHERE guild_id = ?`,
    )
    .get(guildId);

  return {
    channels: row?.channels ?? 0,
    done: row?.done ?? 0,
    fetched: row?.fetched ?? 0,
    emojiUses: row?.emojiUses ?? 0,
    errors: row?.errors ?? 0,
    oldestAt: row?.oldestAt ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

/**
 * All-time or windowed totals per emoji. The command merges the current guild
 * emoji list in so the least-used view can show emojis with no uses at all.
 */
export function rankedEmojiUsage(guildId, { since = null } = {}) {
  const db = getDb();
  const base = `SELECT u.emoji_id AS emojiId,
                       COALESCE(c.emoji_name, u.emoji_id) AS emojiName,
                       COALESCE(c.animated, 0) AS animated,
                       COALESCE(SUM(u.inline_count), 0) AS inlineCount,
                       COALESCE(SUM(u.standalone_count), 0) AS standaloneCount,
                       COALESCE(SUM(u.inline_count + u.standalone_count), 0) AS total,
                       MAX(u.last_used_at) AS lastUsedAt
                FROM emoji_usage u
                LEFT JOIN emoji_catalog c
                  ON c.guild_id = u.guild_id AND c.emoji_id = u.emoji_id
                WHERE u.guild_id = ?`;

  const rows = since
    ? db
        .prepare(`${base} AND u.day >= ? GROUP BY u.emoji_id`)
        .all(guildId, since)
    : db.prepare(`${base} GROUP BY u.emoji_id`).all(guildId);

  return rows.map((row) => ({
    emojiId: row.emojiId,
    emojiName: row.emojiName,
    animated: Number(row.animated) || 0,
    inlineCount: Number(row.inlineCount) || 0,
    standaloneCount: Number(row.standaloneCount) || 0,
    total: Number(row.total) || 0,
    lastUsedAt: row.lastUsedAt ?? null,
  }));
}

/** Milliseconds of history the import covers, for the command footer. */
export function emojiCoverageSince(guildId) {
  const backfilled = emojiBackfilledSince(guildId);
  const live = emojiTrackingSince(guildId);

  if (backfilled === null) return live;
  if (live === null) return backfilled;
  return Math.min(backfilled, live);
}
