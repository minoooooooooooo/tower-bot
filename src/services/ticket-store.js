import { getDb } from '../lib/db.js';

export const CLOSE_ACTIONS = ['delete', 'archive'];
export const BUTTON_STYLES = ['primary', 'secondary', 'success', 'danger'];
export const MAX_OPEN_LIMIT = 10;

/** Rows created by the previous built-in-type version, removed once on upgrade. */
const LEGACY_TYPE_KEYS = ['general', 'complaint-submod', 'complaint-mod', 'complaint-owner'];

function parseIds(raw) {
  if (!raw) return [];

  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function encodeIds(ids) {
  const list = [...new Set((ids ?? []).filter((id) => typeof id === 'string' && id))];
  return list.length ? JSON.stringify(list) : null;
}

function mapType(row) {
  if (!row) return null;

  return {
    guildId: row.guild_id,
    key: row.key,
    label: row.label,
    emoji: row.emoji ?? '',
    categoryId: row.category_id ?? null,
    supportRoleIds: parseIds(row.support_role_ids),
    pingRoleIds: parseIds(row.ping_role_ids),
    logChannelId: row.log_channel_id ?? null,
    welcomeMessage: row.welcome_message ?? '',
    nameTemplate: row.name_template ?? 'ticket-{number}',
    maxOpen: Number(row.max_open) || 1,
    color: row.color === null || row.color === undefined ? null : Number(row.color),
    closeAction: CLOSE_ACTIONS.includes(row.close_action) ? row.close_action : 'delete',
    position: Number(row.position) || 0,
    buttonLabel: row.button_label ?? null,
    buttonStyle: BUTTON_STYLES.includes(row.button_style) ? row.button_style : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTicket(row) {
  if (!row) return null;

  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id ?? null,
    number: Number(row.number) || 0,
    typeKey: row.type_key,
    openerId: row.opener_id,
    openerTag: row.opener_tag ?? '',
    status: row.status ?? 'open',
    claimedBy: row.claimed_by ?? null,
    createdAt: row.created_at,
    closedBy: row.closed_by ?? null,
    closedAt: row.closed_at ?? null,
    closeReason: row.close_reason ?? null,
    transcriptMessageId: row.transcript_message_id ?? null,
  };
}

/** Lower-case, dash-separated key used in custom ids and the database. */
export function normalizeTypeKey(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function nextTypePosition(guildId) {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(position), -1) AS value FROM ticket_types WHERE guild_id = ?')
    .get(guildId);

  return Number(row?.value ?? -1) + 1;
}

function humanizeKey(key) {
  return String(key ?? '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .slice(0, 80);
}

function getTicketSettingsRow(guildId) {
  return getDb().prepare('SELECT * FROM ticket_settings WHERE guild_id = ?').get(guildId);
}

/**
 * The first release shipped four built-in types. They are removed once so an
 * upgraded server starts with an empty, fully custom panel.
 */
function cleanupLegacyTypes(guildId) {
  const row = getTicketSettingsRow(guildId);

  if (!row || row.legacy_cleared) return;

  const placeholders = LEGACY_TYPE_KEYS.map(() => '?').join(', ');

  getDb()
    .prepare(`DELETE FROM ticket_types WHERE guild_id = ? AND key IN (${placeholders})`)
    .run(guildId, ...LEGACY_TYPE_KEYS);
  getDb()
    .prepare('UPDATE ticket_settings SET legacy_cleared = 1 WHERE guild_id = ?')
    .run(guildId);
}

/** Every button on the panel, in display order. */
export function listTicketTypes(guildId) {
  cleanupLegacyTypes(guildId);

  return getDb()
    .prepare('SELECT * FROM ticket_types WHERE guild_id = ? ORDER BY position, key')
    .all(guildId)
    .map(mapType);
}

export function getTicketType(guildId, key) {
  const normalized = normalizeTypeKey(key);
  if (!normalized) return null;

  cleanupLegacyTypes(guildId);

  return mapType(
    getDb()
      .prepare('SELECT * FROM ticket_types WHERE guild_id = ? AND key = ?')
      .get(guildId, normalized),
  );
}

/**
 * Creates or patches one button. Every column is rewritten from the merged row,
 * so callers can pass only the fields they changed.
 */
export function upsertTicketType(guildId, key, patch = {}) {
  const normalized = normalizeTypeKey(key);
  if (!normalized) throw new Error('A ticket button needs a key');

  const base = getTicketType(guildId, normalized);
  const next = {
    label: base?.label ?? humanizeKey(normalized),
    emoji: base?.emoji ?? '',
    categoryId: base?.categoryId ?? null,
    supportRoleIds: base?.supportRoleIds ?? [],
    pingRoleIds: base?.pingRoleIds ?? [],
    logChannelId: base?.logChannelId ?? null,
    welcomeMessage: base?.welcomeMessage ?? '',
    nameTemplate: base?.nameTemplate ?? 'ticket-{number}',
    maxOpen: base?.maxOpen ?? 1,
    color: base?.color ?? null,
    closeAction: base?.closeAction ?? 'delete',
    position: base?.position ?? nextTypePosition(guildId),
    buttonLabel: base?.buttonLabel ?? null,
    buttonStyle: base?.buttonStyle ?? null,
    ...patch,
  };

  if (!CLOSE_ACTIONS.includes(next.closeAction)) {
    next.closeAction = base?.closeAction ?? 'delete';
  }

  next.maxOpen = Math.max(1, Math.min(MAX_OPEN_LIMIT, Number(next.maxOpen) || 1));
  next.position = Math.max(0, Math.min(99, Math.trunc(Number(next.position) || 0)));
  next.label = String(next.label ?? normalized).trim().slice(0, 80) || normalized;
  next.emoji = String(next.emoji ?? '').trim().slice(0, 64);
  next.welcomeMessage = String(next.welcomeMessage ?? '').trim().slice(0, 1500);
  next.nameTemplate = String(next.nameTemplate ?? 'ticket-{number}').trim().slice(0, 80);

  const optionalText = (value, max) => {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text ? text.slice(0, max) : null;
  };

  next.buttonLabel = optionalText(next.buttonLabel, 80);

  const color = Number(next.color);
  next.color = Number.isFinite(color) ? Math.max(0, Math.min(0xffffff, color)) : base?.color ?? null;

  if (next.buttonStyle !== null && next.buttonStyle !== undefined) {
    const style = String(next.buttonStyle).toLowerCase();

    next.buttonStyle = BUTTON_STYLES.includes(style) ? style : base?.buttonStyle ?? null;
  }

  getDb()
    .prepare(
      `INSERT INTO ticket_types
         (guild_id, key, label, emoji, category_id, support_role_ids, ping_role_ids,
          log_channel_id, welcome_message, name_template, max_open, color,
          close_action, position, button_label, button_style, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, key) DO UPDATE SET
         label = excluded.label,
         emoji = excluded.emoji,
         category_id = excluded.category_id,
         support_role_ids = excluded.support_role_ids,
         ping_role_ids = excluded.ping_role_ids,
         log_channel_id = excluded.log_channel_id,
         welcome_message = excluded.welcome_message,
         name_template = excluded.name_template,
         max_open = excluded.max_open,
         color = excluded.color,
         close_action = excluded.close_action,
         position = excluded.position,
         button_label = excluded.button_label,
         button_style = excluded.button_style,
         updated_at = excluded.updated_at`,
    )
    .run(
      guildId,
      normalized,
      next.label,
      next.emoji || null,
      next.categoryId || null,
      encodeIds(next.supportRoleIds),
      encodeIds(next.pingRoleIds),
      next.logChannelId || null,
      next.welcomeMessage || null,
      next.nameTemplate,
      next.maxOpen,
      next.color ?? null,
      next.closeAction,
      next.position,
      next.buttonLabel,
      next.buttonStyle,
      base?.createdAt ?? Date.now(),
      Date.now(),
    );

  return getTicketType(guildId, normalized);
}

export function deleteTicketType(guildId, key) {
  const normalized = normalizeTypeKey(key);
  const type = getTicketType(guildId, normalized);

  if (!type) return null;

  getDb()
    .prepare('DELETE FROM ticket_types WHERE guild_id = ? AND key = ?')
    .run(guildId, normalized);

  return type;
}

function mapSettings(row) {
  return {
    guildId: row?.guild_id ?? null,
    logChannelId: row?.log_channel_id ?? null,
    panelChannelId: row?.panel_channel_id ?? null,
    panelMessageId: row?.panel_message_id ?? null,
    panelTitle: row?.panel_title ?? '',
    panelDescription: row?.panel_description ?? '',
    panelColor:
      row?.panel_color === null || row?.panel_color === undefined ? null : Number(row.panel_color),
    panelFooter: row?.panel_footer ?? '',
    panelImage: row?.panel_image ?? '',
    panelThumbnail: row?.panel_thumbnail ?? '',
    legacyCleared: row ? Boolean(row.legacy_cleared) : true,
    updatedAt: row?.updated_at ?? null,
  };
}

export function getTicketSettings(guildId) {
  cleanupLegacyTypes(guildId);
  return mapSettings(getTicketSettingsRow(guildId));
}

export function updateTicketSettings(guildId, patch = {}) {
  const next = { ...getTicketSettings(guildId), ...patch };

  getDb()
    .prepare(
      `INSERT INTO ticket_settings
         (guild_id, log_channel_id, panel_channel_id, panel_message_id,
          panel_title, panel_description, panel_color, panel_footer,
          panel_image, panel_thumbnail, legacy_cleared, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET
         log_channel_id = excluded.log_channel_id,
         panel_channel_id = excluded.panel_channel_id,
         panel_message_id = excluded.panel_message_id,
         panel_title = excluded.panel_title,
         panel_description = excluded.panel_description,
         panel_color = excluded.panel_color,
         panel_footer = excluded.panel_footer,
         panel_image = excluded.panel_image,
         panel_thumbnail = excluded.panel_thumbnail,
         legacy_cleared = excluded.legacy_cleared,
         updated_at = excluded.updated_at`,
    )
    .run(
      guildId,
      next.logChannelId || null,
      next.panelChannelId || null,
      next.panelMessageId || null,
      next.panelTitle || null,
      next.panelDescription || null,
      next.panelColor ?? null,
      next.panelFooter || null,
      next.panelImage || null,
      next.panelThumbnail || null,
      next.legacyCleared ? 1 : 0,
      Date.now(),
    );

  return next;
}

export function nextTicketNumber(guildId) {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(number), 0) AS value FROM tickets WHERE guild_id = ?')
    .get(guildId);

  return Number(row?.value ?? 0) + 1;
}

export function createTicket({
  guildId,
  channelId,
  number,
  typeKey,
  openerId,
  openerTag = '',
  at = Date.now(),
}) {
  const info = getDb()
    .prepare(
      `INSERT INTO tickets
         (guild_id, channel_id, number, type_key, opener_id, opener_tag,
          status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    )
    .run(guildId, channelId, number, normalizeTypeKey(typeKey), openerId, openerTag, at);

  return getTicketById(Number(info.lastInsertRowid));
}

export function getTicketById(id) {
  return mapTicket(getDb().prepare('SELECT * FROM tickets WHERE id = ?').get(id));
}

export function getTicketByChannel(guildId, channelId) {
  return mapTicket(
    getDb()
      .prepare(
        `SELECT * FROM tickets
         WHERE guild_id = ? AND channel_id = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(guildId, channelId),
  );
}

export function openTicketsFor(guildId, openerId, typeKey = null) {
  const db = getDb();

  if (openerId && typeKey) {
    return db
      .prepare(
        `SELECT * FROM tickets
         WHERE guild_id = ? AND opener_id = ? AND type_key = ? AND status = 'open'
         ORDER BY created_at ASC`,
      )
      .all(guildId, openerId, normalizeTypeKey(typeKey))
      .map(mapTicket);
  }

  if (openerId) {
    return db
      .prepare(
        `SELECT * FROM tickets
         WHERE guild_id = ? AND opener_id = ? AND status = 'open'
         ORDER BY created_at ASC`,
      )
      .all(guildId, openerId)
      .map(mapTicket);
  }

  if (typeKey) {
    return db
      .prepare(
        `SELECT * FROM tickets
         WHERE guild_id = ? AND type_key = ? AND status = 'open'
         ORDER BY created_at ASC`,
      )
      .all(guildId, normalizeTypeKey(typeKey))
      .map(mapTicket);
  }

  return db
    .prepare(
      `SELECT * FROM tickets
       WHERE guild_id = ? AND status = 'open'
       ORDER BY created_at ASC`,
    )
    .all(guildId)
    .map(mapTicket);
}

export function openTicketCount(guildId) {
  return (
    getDb()
      .prepare(
        "SELECT COUNT(*) AS value FROM tickets WHERE guild_id = ? AND status = 'open'",
      )
      .get(guildId)?.value ?? 0
  );
}

export function ticketCounts(guildId) {
  const rows = getDb()
    .prepare('SELECT status, COUNT(*) AS value FROM tickets WHERE guild_id = ? GROUP BY status')
    .all(guildId);

  const counts = { open: 0, closed: 0, deleted: 0 };

  for (const row of rows) counts[row.status] = Number(row.value) || 0;

  return counts;
}

export function claimTicket(id, userId, at = Date.now()) {
  getDb()
    .prepare('UPDATE tickets SET claimed_by = ? WHERE id = ?')
    .run(userId || null, id);

  return getTicketById(id);
}

export function closeTicketRecord(id, { closedBy, reason = null, at = Date.now() }) {
  getDb()
    .prepare(
      `UPDATE tickets
       SET status = 'closed', closed_by = ?, closed_at = ?, close_reason = ?
       WHERE id = ?`,
    )
    .run(closedBy, at, reason || null, id);

  return getTicketById(id);
}

export function reopenTicketRecord(id) {
  getDb()
    .prepare(
      `UPDATE tickets
       SET status = 'open', closed_by = NULL, closed_at = NULL, close_reason = NULL
       WHERE id = ?`,
    )
    .run(id);

  return getTicketById(id);
}

export function markTicketDeleted(id) {
  getDb().prepare("UPDATE tickets SET status = 'deleted' WHERE id = ?").run(id);
  return getTicketById(id);
}

/** A manually deleted channel must not leave an "open" ticket behind. */
export function markTicketDeletedByChannel(guildId, channelId) {
  const ticket = getTicketByChannel(guildId, channelId);

  if (!ticket || ticket.status === 'deleted') return null;

  if (ticket.status === 'open') markTicketDeleted(ticket.id);

  return ticket;
}

export function setTicketTranscript(id, messageId) {
  getDb()
    .prepare('UPDATE tickets SET transcript_message_id = ? WHERE id = ?')
    .run(messageId, id);

  return getTicketById(id);
}

/** Rows shown by `/ticket list`; recent first, capped so the embed stays small. */
export function recentTickets(guildId, limit = 10) {
  return getDb()
    .prepare(
      `SELECT * FROM tickets WHERE guild_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(guildId, Math.max(1, Math.min(25, limit)))
    .map(mapTicket);
}
