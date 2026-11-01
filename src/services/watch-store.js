import { getDb } from '../lib/db.js';

export const MAX_TERMS_PER_USER = 25;
export const MIN_TERM_LENGTH = 2;
export const MAX_TERM_LENGTH = 60;

export function listWatchTerms(guildId) {
  return getDb()
    .prepare('SELECT id, user_id, term, broken FROM watch_terms WHERE guild_id = ? ORDER BY user_id, term')
    .all(guildId)
    .map((row) => ({ id: row.id, userId: row.user_id, term: row.term, broken: Boolean(row.broken) }));
}

export function listUserTerms(guildId, userId) {
  return getDb()
    .prepare('SELECT id, term, broken FROM watch_terms WHERE guild_id = ? AND user_id = ? ORDER BY term')
    .all(guildId, userId)
    .map((row) => ({ id: row.id, term: row.term, broken: Boolean(row.broken) }));
}

export function countTerms(guildId, userId) {
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS total FROM watch_terms WHERE guild_id = ? AND user_id = ?')
      .get(guildId, userId)?.total ?? 0
  );
}

export function hasTerm(guildId, userId, term) {
  return Boolean(
    getDb()
      .prepare('SELECT 1 AS hit FROM watch_terms WHERE guild_id = ? AND user_id = ? AND term = ? COLLATE NOCASE')
      .get(guildId, userId, term),
  );
}

/** Returns false when the term already existed or the member hit the cap. */
export function addWatchTerm(guildId, userId, term) {
  if (countTerms(guildId, userId) >= MAX_TERMS_PER_USER) return { added: false, reason: 'limit' };
  if (hasTerm(guildId, userId, term)) return { added: false, reason: 'duplicate' };

  getDb()
    .prepare(
      'INSERT INTO watch_terms (guild_id, user_id, term, broken, created_at) VALUES (?, ?, ?, 0, ?)',
    )
    .run(guildId, userId, term, Date.now());

  return { added: true, reason: null };
}

export function removeWatchTerm(guildId, userId, term) {
  return getDb()
    .prepare('DELETE FROM watch_terms WHERE guild_id = ? AND user_id = ? AND term = ? COLLATE NOCASE')
    .run(guildId, userId, term).changes;
}

export function clearWatchTerms(guildId, userId) {
  return getDb()
    .prepare('DELETE FROM watch_terms WHERE guild_id = ? AND user_id = ?')
    .run(guildId, userId).changes;
}

/** Marks a subscriber whose DMs bounce, so `/watch list` can explain it. */
export function markWatchBroken(guildId, userId, broken) {
  getDb()
    .prepare('UPDATE watch_terms SET broken = ? WHERE guild_id = ? AND user_id = ?')
    .run(broken ? 1 : 0, guildId, userId);
}
