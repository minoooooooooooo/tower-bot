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
    channelMode: row.channel_mode ?? null,
    channels: [],
  };
}

/** Every alias in a server, oldest first for a stable list. */
export function listAliases(guildId) {
  const db = getDb();
  const byTrigger = new Map(
    db
      .prepare(
        `SELECT trigger, label, command, created_by, created_at, channel_mode
           FROM command_aliases WHERE guild_id = ? ORDER BY created_at, trigger`,
      )
      .all(guildId)
      .map((row) => [row.trigger, toAlias(row)]),
  );

  const rules = db
    .prepare(
      `SELECT trigger, channel_id AS channelId
         FROM command_alias_channels WHERE guild_id = ? ORDER BY channel_id`,
    )
    .all(guildId);

  for (const rule of rules) {
    byTrigger.get(rule.trigger)?.channels.push(rule.channelId);
  }

  return [...byTrigger.values()];
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
  const normalized = normalizeTrigger(trigger);
  const db = getDb();
  let changes = 0;

  db.exec('BEGIN');

  try {
    db.prepare('DELETE FROM command_alias_channels WHERE guild_id = ? AND trigger = ?').run(
      guildId,
      normalized,
    );
    changes = db
      .prepare('DELETE FROM command_aliases WHERE guild_id = ? AND trigger = ?')
      .run(guildId, normalized).changes;
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  invalidateAliasCache(guildId);
  return changes;
}

export function clearAliases(guildId) {
  const db = getDb();
  let changes = 0;

  db.exec('BEGIN');

  try {
    db.prepare('DELETE FROM command_alias_channels WHERE guild_id = ?').run(guildId);
    changes = db.prepare('DELETE FROM command_aliases WHERE guild_id = ?').run(guildId).changes;
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  invalidateAliasCache(guildId);
  return changes;
}

/**
 * Adds a channel rule. Switching from allow to deny (or back) clears the old
 * list: mixing both would make "works here" and "does not work here" ambiguous.
 */
export function addAliasChannel({ guildId, trigger, channelId, mode }) {
  const normalized = normalizeTrigger(trigger);
  const nextMode = mode === 'allow' ? 'allow' : mode === 'deny' ? 'deny' : null;

  if (!nextMode || !channelId) return null;

  const db = getDb();

  db.exec('BEGIN');

  try {
    const current = db
      .prepare('SELECT channel_mode AS mode FROM command_aliases WHERE guild_id = ? AND trigger = ?')
      .get(guildId, normalized);

    if (!current) {
      db.exec('ROLLBACK');
      return null;
    }

    if (current.mode && current.mode !== nextMode) {
      db.prepare('DELETE FROM command_alias_channels WHERE guild_id = ? AND trigger = ?').run(
        guildId,
        normalized,
      );
    }

    db.prepare('UPDATE command_aliases SET channel_mode = ? WHERE guild_id = ? AND trigger = ?').run(
      nextMode,
      guildId,
      normalized,
    );
    db.prepare(
      `INSERT INTO command_alias_channels (guild_id, trigger, channel_id)
       VALUES (?, ?, ?) ON CONFLICT (guild_id, trigger, channel_id) DO NOTHING`,
    ).run(guildId, normalized, channelId);

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  invalidateAliasCache(guildId);
  return getAlias(guildId, normalized);
}

/** Removes one channel; removing the last one returns the alias to everywhere. */
export function removeAliasChannel({ guildId, trigger, channelId }) {
  const normalized = normalizeTrigger(trigger);
  const db = getDb();

  db.exec('BEGIN');

  try {
    const current = db
      .prepare('SELECT channel_mode AS mode FROM command_aliases WHERE guild_id = ? AND trigger = ?')
      .get(guildId, normalized);

    if (!current) {
      db.exec('ROLLBACK');
      return null;
    }

    db.prepare(
      'DELETE FROM command_alias_channels WHERE guild_id = ? AND trigger = ? AND channel_id = ?',
    ).run(guildId, normalized, channelId);

    const remaining = db
      .prepare(
        'SELECT COUNT(*) AS total FROM command_alias_channels WHERE guild_id = ? AND trigger = ?',
      )
      .get(guildId, normalized).total;

    if (remaining === 0) {
      db.prepare('UPDATE command_aliases SET channel_mode = NULL WHERE guild_id = ? AND trigger = ?').run(
        guildId,
        normalized,
      );
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  invalidateAliasCache(guildId);
  return getAlias(guildId, normalized);
}

/** Drops every rule, so the alias works in every channel again. */
export function clearAliasChannels(guildId, trigger) {
  const normalized = normalizeTrigger(trigger);
  const db = getDb();

  db.exec('BEGIN');

  try {
    db.prepare('DELETE FROM command_alias_channels WHERE guild_id = ? AND trigger = ?').run(
      guildId,
      normalized,
    );
    db.prepare('UPDATE command_aliases SET channel_mode = NULL WHERE guild_id = ? AND trigger = ?').run(
      guildId,
      normalized,
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  invalidateAliasCache(guildId);
  return getAlias(guildId, normalized);
}

/**
 * A thread inherits its parent channel's rule, and a channel inherits its
 * category's rule. The candidate set covers all three levels, so an admin can
 * restrict a category, a channel, or a single thread.
 */
export function aliasAllowsChannel(alias, channel) {
  if (!alias?.channelMode || !alias.channels?.length) return true;

  const ids = new Set();
  const add = (value) => {
    if (value) ids.add(String(value));
  };

  add(channel?.id);
  add(channel?.parentId);
  add(channel?.parent?.id);
  add(channel?.parent?.parentId);
  add(channel?.guild?.channels?.cache?.get?.(channel.parentId)?.parentId);

  const hit = alias.channels.some((id) => ids.has(String(id)));
  return alias.channelMode === 'allow' ? hit : !hit;
}
