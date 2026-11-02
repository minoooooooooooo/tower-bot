import { getDb } from '../lib/db.js';
import { normalizeForMatch } from '../lib/text.js';

export const MAX_ALIASES = 50;
export const MAX_TRIGGER_LENGTH = 32;

// Every guild message without the prefix asks for an alias, so the rows are
// cached for half a minute instead of hitting SQLite per message.
const CACHE_TTL_MS = 30_000;
const cache = new Map();

/** The stored form of a trigger: case- and diacritic-insensitive. */
export function normalizeTrigger(value) {
  return normalizeForMatch(value);
}

export function invalidateAliasCache(guildId) {
  if (guildId) cache.delete(guildId);
  else cache.clear();
}

function toAlias(row) {
  return {
    trigger: row.trigger,
    label: row.label,
    command: row.command,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** Every alias in a server, oldest first for a stable list. */
export function listAliases(guildId) {
  return getDb()
    .prepare(
      `SELECT trigger, label, command, created_by, created_at
         FROM command_aliases WHERE guild_id = ? ORDER BY created_at, trigger`,
    )
    .all(guildId)
    .map(toAlias);
}

export function getAlias(guildId, trigger) {
  const normalized = normalizeTrigger(trigger);
  if (!normalized) return null;

  const hit = cache.get(guildId);

  if (hit && hit.expires > Date.now()) return hit.byTrigger.get(normalized) ?? null;

  const byTrigger = new Map(listAliases(guildId).map((alias) => [alias.trigger, alias]));
  cache.set(guildId, { expires: Date.now() + CACHE_TTL_MS, byTrigger });

  return byTrigger.get(normalized) ?? null;
}

export function countAliases(guildId) {
  return getDb()
    .prepare('SELECT COUNT(*) AS total FROM command_aliases WHERE guild_id = ?')
    .get(guildId).total;
}

export function saveAlias({ guildId, trigger, label, command, createdBy, now = Date.now() }) {
  const normalized = normalizeTrigger(trigger);
  const display = String(label ?? trigger).trim();

  getDb()
    .prepare(
      `INSERT INTO command_aliases (guild_id, trigger, label, command, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, trigger) DO UPDATE SET
         label = excluded.label,
         command = excluded.command,
         created_by = excluded.created_by,
         created_at = excluded.created_at`,
    )
    .run(guildId, normalized, display, command, createdBy, now);

  invalidateAliasCache(guildId);
  return getAlias(guildId, normalized);
}

export function removeAlias(guildId, trigger) {
  const changes = getDb()
    .prepare('DELETE FROM command_aliases WHERE guild_id = ? AND trigger = ?')
    .run(guildId, normalizeTrigger(trigger)).changes;

  invalidateAliasCache(guildId);
  return changes;
}

export function clearAliases(guildId) {
  const changes = getDb().prepare('DELETE FROM command_aliases WHERE guild_id = ?').run(guildId)
    .changes;

  invalidateAliasCache(guildId);
  return changes;
}
