import { getDb } from '../lib/db.js';
import { normalizeForMatch } from '../lib/text.js';

export const MAX_WATCH_TERMS = 50;
export const MIN_TERM_LENGTH = 2;
export const MAX_TERM_LENGTH = 60;

/** Every watched word in the guild, shared by all moderators. */
export function listWatchTerms(guildId) {
  return getDb()
    .prepare(
      'SELECT term, created_by, created_at FROM watch_terms WHERE guild_id = ? ORDER BY term COLLATE NOCASE',
    )
    .all(guildId)
    .map((row) => ({
      term: row.term,
      createdBy: row.created_by,
      createdAt: row.created_at,
    }));
}

export function countTerms(guildId) {
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS total FROM watch_terms WHERE guild_id = ?')
      .get(guildId)?.total ?? 0
  );
}

/**
 * Duplicates are detected after normalization, so `مُحَمّد` cannot be added
 * next to `محمد` and silently match everything twice.
 */
export function findTerm(guildId, term) {
  const wanted = normalizeForMatch(term);

  return (
    listWatchTerms(guildId).find((row) => normalizeForMatch(row.term) === wanted) ?? null
  );
}

/** Returns false when the term already existed or the guild hit the cap. */
export function addWatchTerm(guildId, userId, term) {
  const existing = findTerm(guildId, term);

  if (existing) return { added: false, reason: 'duplicate', term: existing.term };

  if (countTerms(guildId) >= MAX_WATCH_TERMS) return { added: false, reason: 'limit' };

  getDb()
    .prepare(
      'INSERT INTO watch_terms (guild_id, term, created_by, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(guildId, term, userId, Date.now());

  return { added: true, reason: null, term };
}

export function removeWatchTerm(guildId, term) {
  const existing = findTerm(guildId, term);

  if (!existing) return 0;

  return getDb()
    .prepare('DELETE FROM watch_terms WHERE guild_id = ? AND term = ?')
    .run(guildId, existing.term).changes;
}

export function clearWatchTerms(guildId) {
  return getDb().prepare('DELETE FROM watch_terms WHERE guild_id = ?').run(guildId).changes;
}

/** The channel that receives keyword alerts, or null when none is set. */
export function getWatchChannelId(guildId) {
  const row = getDb()
    .prepare('SELECT channel_id FROM watch_settings WHERE guild_id = ?')
    .get(guildId);

  return row?.channel_id ?? null;
}

export function setWatchChannelId(guildId, channelId) {
  getDb()
    .prepare(
      `INSERT INTO watch_settings (guild_id, channel_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET
         channel_id = excluded.channel_id,
         updated_at = excluded.updated_at`,
    )
    .run(guildId, channelId ?? null, Date.now());

  return channelId ?? null;
}

// --- ignored channels -------------------------------------------------------

/** Channels and categories whose messages never trigger an alert. */
export function listIgnoredChannels(guildId) {
  return getDb()
    .prepare(
      'SELECT channel_id, created_by, created_at FROM watch_ignored_channels WHERE guild_id = ? ORDER BY created_at ASC',
    )
    .all(guildId)
    .map((row) => ({
      channelId: row.channel_id,
      createdBy: row.created_by,
      createdAt: row.created_at,
    }));
}

export function isIgnoredChannel(guildId, channelId) {
  return Boolean(
    getDb()
      .prepare(
        'SELECT 1 AS ok FROM watch_ignored_channels WHERE guild_id = ? AND channel_id = ?',
      )
      .get(guildId, channelId),
  );
}

/** Returns false when the channel was already ignored. */
export function addIgnoredChannel(guildId, channelId, userId) {
  return (
    getDb()
      .prepare(
        `INSERT INTO watch_ignored_channels (guild_id, channel_id, created_by, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(guildId, channelId, userId, Date.now()).changes > 0
  );
}

export function removeIgnoredChannel(guildId, channelId) {
  return getDb()
    .prepare('DELETE FROM watch_ignored_channels WHERE guild_id = ? AND channel_id = ?')
    .run(guildId, channelId).changes;
}

export function clearIgnoredChannels(guildId) {
  return getDb()
    .prepare('DELETE FROM watch_ignored_channels WHERE guild_id = ?')
    .run(guildId).changes;
}
