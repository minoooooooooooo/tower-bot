import { getDb } from '../lib/db.js';

export const TICKET_KINDS = ['standard', 'complaint'];
export const CLOSE_ACTIONS = ['delete', 'archive'];
export const MAX_OPEN_LIMIT = 10;

/** The panel is usable immediately after setup; only the category is required. */
export const DEFAULT_TICKET_TYPES = [
  {
    key: 'general',
    label: 'Open a ticket',
    description:
      'Need help or want to speak with the staff privately? Open a ticket and someone will answer as soon as possible.',
    emoji: '🎫',
    kind: 'standard',
    nameTemplate: 'ticket-{number}',
    welcomeMessage:
      'Thanks for opening a ticket, {mention}. Describe your issue below and a staff member will help you soon.',
    color: 0x5865f2,
    maxOpen: 1,
    closeAction: 'delete',
    position: 0,
  },
  {
    key: 'complaint-submod',
    label: 'Complaint against sub-mod',
    description:
      'Report how a sub-moderator treated you. This opens a private complaint ticket for the administration team.',
    emoji: '🛡️',
    kind: 'complaint',
    nameTemplate: 'complaint-submod-{number}',
    welcomeMessage:
      'This is a private complaint about a sub-moderator, {mention}. Explain what happened, with any evidence you have. The administration team will review it.',
    color: 0xfee75c,
    maxOpen: 1,
    closeAction: 'delete',
    position: 1,
  },
  {
    key: 'complaint-mod',
    label: 'Complaint against mod',
    description:
      'Report how a moderator treated you. This opens a private complaint ticket for the administration team.',
    emoji: '⚠️',
    kind: 'complaint',
    nameTemplate: 'complaint-mod-{number}',
    welcomeMessage:
      'This is a private complaint about a moderator, {mention}. Explain what happened, with any evidence you have. The administration team will review it.',
    color: 0xfee75c,
    maxOpen: 1,
    closeAction: 'delete',
    position: 2,
  },
  {
    key: 'complaint-owner',
    label: 'Complaint against owner',
    description:
      'Report how the server owner treated you. This opens a private complaint ticket for the administration team.',
    emoji: '👑',
    kind: 'complaint',
    nameTemplate: 'complaint-owner-{number}',
    welcomeMessage:
      'This is a private complaint about the server owner, {mention}. Explain what happened, with any evidence you have. The administration team will review it.',
    color: 0xed4245,
    maxOpen: 1,
    closeAction: 'delete',
    position: 3,
  },
];

export const COMPLAINT_TYPE_KEYS = DEFAULT_TICKET_TYPES.filter(
  (type) => type.kind === 'complaint',
).map((type) => type.key);

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
    description: row.description ?? '',
    emoji: row.emoji ?? '',
    kind: TICKET_KINDS.includes(row.kind) ? row.kind : 'standard',
    categoryId: row.category_id ?? null,
    supportRoleIds: parseIds(row.support_role_ids),
    pingRoleIds: parseIds(row.ping_role_ids),
    logChannelId: row.log_channel_id ?? null,
    panelChannelId: row.panel_channel_id ?? null,
    panelMessageId: row.panel_message_id ?? null,
    welcomeMessage: row.welcome_message ?? '',
    nameTemplate: row.name_template ?? 'ticket-{number}',
    maxOpen: Number(row.max_open) || 1,
    color: row.color === null || row.color === undefined ? null : Number(row.color),
    closeAction: CLOSE_ACTIONS.includes(row.close_action) ? row.close_action : 'delete',
    position: Number(row.position) || 0,
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

function defaultFor(key) {
  return DEFAULT_TICKET_TYPES.find((type) => type.key === key) ?? DEFAULT_TICKET_TYPES[0];
}

function isDefaultType(key) {
  return DEFAULT_TICKET_TYPES.some((type) => type.key === key);
}

/** Appends a custom type after every existing one instead of at position 0. */
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
 * Creates the four shipped types once per guild. A deleted default stays
 * deleted: the seed flag is set after the first run, so `/ticket reset` is real.
 */
export function ensureDefaultTicketTypes(guildId) {
  const settings = getTicketSettingsRow(guildId);

  if (settings?.defaults_seeded) return;

  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO ticket_types
       (guild_id, key, label, description, emoji, kind, category_id,
        support_role_ids, ping_role_ids, log_channel_id, panel_channel_id,
        panel_message_id, welcome_message, name_template, max_open, color,
        close_action, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (guild_id, key) DO NOTHING`,
  );
  const now = Date.now();

  for (const type of DEFAULT_TICKET_TYPES) {
    insert.run(
      guildId,
      type.key,
      type.label,
      type.description,
      type.emoji,
      type.kind,
      type.welcomeMessage,
      type.nameTemplate,
      type.maxOpen,
      type.color,
      type.closeAction,
      type.position,
      now,
      now,
    );
  }

  updateTicketSettings(guildId, { defaultsSeeded: true });
}

export function listTicketTypes(guildId) {
  ensureDefaultTicketTypes(guildId);

  return getDb()
    .prepare('SELECT * FROM ticket_types WHERE guild_id = ? ORDER BY position, key')
    .all(guildId)
    .map(mapType);
}

export function getTicketType(guildId, key) {
  const normalized = normalizeTypeKey(key);
  if (!normalized) return null;

  ensureDefaultTicketTypes(guildId);

  return mapType(
    getDb()
      .prepare('SELECT * FROM ticket_types WHERE guild_id = ? AND key = ?')
      .get(guildId, normalized),
  );
}

/**
 * Creates or patches one type. Every column is rewritten from the merged row,
 * so callers can pass only the fields they changed.
 */
export function upsertTicketType(guildId, key, patch = {}) {
  const normalized = normalizeTypeKey(key);
  if (!normalized) throw new Error('A ticket type needs a key');

  ensureDefaultTicketTypes(guildId);

  const base = getTicketType(guildId, normalized);
  const fallback = defaultFor(normalized);
  const builtIn = isDefaultType(normalized);
  const next = {
    label: base?.label ?? (builtIn ? fallback.label : humanizeKey(normalized)),
    description: base?.description ?? (builtIn ? fallback.description : ''),
    emoji: base?.emoji ?? fallback.emoji,
    kind: base?.kind ?? fallback.kind,
    categoryId: base?.categoryId ?? null,
    supportRoleIds: base?.supportRoleIds ?? [],
    pingRoleIds: base?.pingRoleIds ?? [],
    logChannelId: base?.logChannelId ?? null,
    panelChannelId: base?.panelChannelId ?? null,
    panelMessageId: base?.panelMessageId ?? null,
    welcomeMessage: base?.welcomeMessage ?? fallback.welcomeMessage,
    nameTemplate: base?.nameTemplate ?? fallback.nameTemplate,
    maxOpen: base?.maxOpen ?? fallback.maxOpen,
    color: base?.color ?? fallback.color,
    closeAction: base?.closeAction ?? fallback.closeAction,
    position: base?.position ?? (builtIn ? fallback.position : nextTypePosition(guildId)),
    ...patch,
  };

  if (!TICKET_KINDS.includes(next.kind)) next.kind = base?.kind ?? 'standard';
  if (!CLOSE_ACTIONS.includes(next.closeAction)) {
    next.closeAction = base?.closeAction ?? 'delete';
  }

  next.maxOpen = Math.max(1, Math.min(MAX_OPEN_LIMIT, Number(next.maxOpen) || 1));
  next.label = String(next.label ?? normalized).trim().slice(0, 80) || normalized;
  next.description = String(next.description ?? '').trim().slice(0, 1500);
  next.emoji = String(next.emoji ?? '').trim().slice(0, 64);
  next.welcomeMessage = String(next.welcomeMessage ?? '').trim().slice(0, 1500);
  next.nameTemplate = String(next.nameTemplate ?? 'ticket-{number}').trim().slice(0, 80);

  getDb()
    .prepare(
      `INSERT INTO ticket_types
         (guild_id, key, label, description, emoji, kind, category_id,
          support_role_ids, ping_role_ids, log_channel_id, panel_channel_id,
          panel_message_id, welcome_message, name_template, max_open, color,
          close_action, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, key) DO UPDATE SET
         label = excluded.label,
         description = excluded.description,
         emoji = excluded.emoji,
         kind = excluded.kind,
         category_id = excluded.category_id,
         support_role_ids = excluded.support_role_ids,
         ping_role_ids = excluded.ping_role_ids,
         log_channel_id = excluded.log_channel_id,
         panel_channel_id = excluded.panel_channel_id,
         panel_message_id = excluded.panel_message_id,
         welcome_message = excluded.welcome_message,
         name_template = excluded.name_template,
         max_open = excluded.max_open,
         color = excluded.color,
         close_action = excluded.close_action,
         position = excluded.position,
         updated_at = excluded.updated_at`,
    )
    .run(
      guildId,
      normalized,
      next.label,
      next.description || null,
      next.emoji || null,
      next.kind,
      next.categoryId || null,
      encodeIds(next.supportRoleIds),
      encodeIds(next.pingRoleIds),
      next.logChannelId || null,
      next.panelChannelId || null,
      next.panelMessageId || null,
      next.welcomeMessage || null,
      next.nameTemplate,
      next.maxOpen,
      next.color ?? null,
      next.closeAction,
      next.position,
      base?.createdAt ?? Date.now(),
      Date.now(),
    );

  return getTicketType(guildId, normalized);
}

export function saveTicketPanel(guildId, key, { channelId, messageId }) {
  return upsertTicketType(guildId, key, {
    panelChannelId: channelId ?? null,
    panelMessageId: messageId ?? null,
  });
}

export function clearTicketPanel(guildId, key) {
  return upsertTicketType(guildId, key, {
    panelChannelId: null,
    panelMessageId: null,
  });
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
    complaintChannelId: row?.complaint_channel_id ?? null,
    complaintMessageId: row?.complaint_message_id ?? null,
    complaintTitle: row?.complaint_title ?? '',
    complaintDescription: row?.complaint_description ?? '',
    complaintColor:
      row?.complaint_color === null || row?.complaint_color === undefined
        ? null
        : Number(row.complaint_color),
    defaultsSeeded: Boolean(row?.defaults_seeded),
    updatedAt: row?.updated_at ?? null,
  };
}

export function getTicketSettings(guildId) {
  return mapSettings(getTicketSettingsRow(guildId));
}

export function updateTicketSettings(guildId, patch = {}) {
  const next = { ...getTicketSettings(guildId), ...patch };

  getDb()
    .prepare(
      `INSERT INTO ticket_settings
         (guild_id, log_channel_id, complaint_channel_id, complaint_message_id,
          complaint_title, complaint_description, complaint_color,
          defaults_seeded, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET
         log_channel_id = excluded.log_channel_id,
         complaint_channel_id = excluded.complaint_channel_id,
         complaint_message_id = excluded.complaint_message_id,
         complaint_title = excluded.complaint_title,
         complaint_description = excluded.complaint_description,
         complaint_color = excluded.complaint_color,
         defaults_seeded = excluded.defaults_seeded,
         updated_at = excluded.updated_at`,
    )
    .run(
      guildId,
      next.logChannelId || null,
      next.complaintChannelId || null,
      next.complaintMessageId || null,
      next.complaintTitle || null,
      next.complaintDescription || null,
      next.complaintColor ?? null,
      next.defaultsSeeded ? 1 : 0,
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
