import { getDb } from '../lib/db.js';

export const MODES = ['random', 'rotate', 'single'];
export const DEFAULT_MODE = 'random';

function parseEnabled(raw) {
  if (!raw) return null;

  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((key) => typeof key === 'string') : null;
  } catch {
    return null;
  }
}

function mapSettings(guildId, row) {
  return {
    guildId,
    channelId: row?.channel_id ?? null,
    rulesChannelId: row?.rules_channel_id ?? null,
    generalChannelId: row?.general_channel_id ?? null,
    mode: MODES.includes(row?.mode) ? row.mode : DEFAULT_MODE,
    forcedStyle: row?.forced_style ?? null,
    enabled: parseEnabled(row?.enabled),
    lastStyle: row?.last_style ?? null,
    gifUrl: row?.gif_url ?? null,
  };
}

export function getWelcomeSettings(guildId) {
  return mapSettings(
    guildId,
    getDb().prepare('SELECT * FROM welcome_settings WHERE guild_id = ?').get(guildId),
  );
}

/**
 * Patches one guild's welcome settings. Every column is rewritten from the
 * merged result, so callers can pass only what changed.
 */
export function updateWelcomeSettings(guildId, patch = {}) {
  const next = { ...getWelcomeSettings(guildId), ...patch };

  getDb()
    .prepare(
      `INSERT INTO welcome_settings
         (guild_id, channel_id, rules_channel_id, general_channel_id,
          mode, forced_style, enabled, last_style, gif_url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET
         channel_id = excluded.channel_id,
         rules_channel_id = excluded.rules_channel_id,
         general_channel_id = excluded.general_channel_id,
         mode = excluded.mode,
         forced_style = excluded.forced_style,
         enabled = excluded.enabled,
         last_style = excluded.last_style,
         gif_url = excluded.gif_url,
         updated_at = excluded.updated_at`,
    )
    .run(
      guildId,
      next.channelId,
      next.rulesChannelId,
      next.generalChannelId,
      next.mode,
      next.forcedStyle,
      next.enabled ? JSON.stringify(next.enabled) : null,
      next.lastStyle,
      next.gifUrl,
      Date.now(),
    );

  return next;
}

/** Remembers the last posted style so `random` never repeats it. */
export function setLastStyle(guildId, styleKey) {
  updateWelcomeSettings(guildId, { lastStyle: styleKey });
}

export function getWelcomeTexts(guildId) {
  const texts = {};

  for (const row of getDb()
    .prepare('SELECT style, piece, value FROM welcome_texts WHERE guild_id = ?')
    .all(guildId)) {
    texts[row.style] ??= {};
    texts[row.style][row.piece] = row.value;
  }

  return texts;
}

/** Stores one edited piece; an empty value deletes the override. */
export function setWelcomePiece(guildId, style, piece, value) {
  if (!value) {
    clearWelcomePiece(guildId, style, piece);
    return null;
  }

  getDb()
    .prepare(
      `INSERT INTO welcome_texts (guild_id, style, piece, value)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (guild_id, style, piece) DO UPDATE SET value = excluded.value`,
    )
    .run(guildId, style, piece, value);

  return value;
}

export function clearWelcomePiece(guildId, style, piece) {
  getDb()
    .prepare('DELETE FROM welcome_texts WHERE guild_id = ? AND style = ? AND piece = ?')
    .run(guildId, style, piece);
}

export function clearWelcomeTexts(guildId, style = null) {
  const db = getDb();

  if (style) {
    db.prepare('DELETE FROM welcome_texts WHERE guild_id = ? AND style = ?').run(guildId, style);
    return;
  }

  db.prepare('DELETE FROM welcome_texts WHERE guild_id = ?').run(guildId);
}
