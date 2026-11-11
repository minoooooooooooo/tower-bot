import { getDb } from '../lib/db.js';

export const CLOSE_ACTIONS = ['delete', 'archive'];
export const BUTTON_STYLES = ['primary', 'secondary', 'success', 'danger'];
export const MAX_OPEN_LIMIT = 10;
export const DEFAULT_PANEL_KEY = 'main';
export const MAX_PANELS = 10;

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

function optionalText(value, max) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function clampColor(value, fallback = null) {
  const color = Number(value);
  return Number.isFinite(color) ? Math.max(0, Math.min(0xffffff, color)) : fallback;
}

function mapType(row) {
  if (!row) return null;

  return {
    guildId: row.guild_id,
    key: row.key,
    label: row.label,
    emoji: row.emoji ?? '',
    panelKey: row.panel_key || DEFAULT_PANEL_KEY,
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

/** Panel keys share the button-key rules, so custom ids and lists stay clean. */
export function normalizePanelKey(raw) {
  return normalizeTypeKey(raw);
}

function nextTypePosition(guildId, panelKey = DEFAULT_PANEL_KEY) {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(MAX(position), -1) AS value FROM ticket_types
       WHERE guild_id = ? AND panel_key = ?`,
    )
    .get(guildId, normalizePanelKey(panelKey) || DEFAULT_PANEL_KEY);

  return Number(row?.value ?? -1) + 1;
}

function nextPanelPosition(guildId) {
  const row = getDb()
    .prepare('SELECT COALESCE(MAX(position), -1) AS value FROM ticket_panels WHERE guild_id = ?')
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

function mapPanel(row) {
  if (!row) return null;

  return {
    guildId: row.guild_id,
    key: row.key,
    label: row.label,
    channelId: row.channel_id ?? null,
    messageId: row.message_id ?? null,
    title: row.title ?? '',
    description: row.description ?? '',
    color: row.color === null || row.color === undefined ? null : Number(row.color),
    footer: row.footer ?? '',
    image: row.image ?? '',
    thumbnail: row.thumbnail ?? '',
    position: Number(row.position) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Upgrades a guild from the single-panel release. The old panel columns lived in
 * `ticket_settings`; they are copied once into a `main` panel, and every button
 * without a panel key is attached to it. `panels_migrated` makes this idempotent.
 */
function migrateTicketPanels(guildId) {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO ticket_settings
         (guild_id, legacy_cleared, panels_migrated, updated_at)
       VALUES (?, 0, 0, ?)`,
    )
    .run(guildId, Date.now());

  cleanupLegacyTypes(guildId);

  const row = getTicketSettingsRow(guildId);

  if (!row || row.panels_migrated) return;

  const panelCount = Number(
    getDb()
      .prepare('SELECT COUNT(*) AS value FROM ticket_panels WHERE guild_id = ?')
      .get(guildId)?.value ?? 0,
  );
  const buttonCount = Number(
    getDb()
      .prepare('SELECT COUNT(*) AS value FROM ticket_types WHERE guild_id = ?')
      .get(guildId)?.value ?? 0,
  );
  const hasLegacyPanel = Boolean(
    row.panel_channel_id ||
      row.panel_message_id ||
      row.panel_title ||
      row.panel_description ||
      row.panel_footer ||
      row.panel_image ||
      row.panel_thumbnail ||
      row.panel_color !== null,
  );

  if (!panelCount && (hasLegacyPanel || buttonCount > 0)) {
    const now = Date.now();

    getDb()
      .prepare(
        `INSERT INTO ticket_panels
           (guild_id, key, label, channel_id, message_id, title, description,
            color, footer, image, thumbnail, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        guildId,
        DEFAULT_PANEL_KEY,
        'Main',
        row.panel_channel_id || null,
        row.panel_message_id || null,
        row.panel_title || null,
        row.panel_description || null,
        row.panel_color ?? null,
        row.panel_footer || null,
        row.panel_image || null,
        row.panel_thumbnail || null,
        0,
        now,
        now,
      );
  }

  getDb()
    .prepare(
      `UPDATE ticket_types SET panel_key = ?
       WHERE guild_id = ? AND (panel_key IS NULL OR TRIM(panel_key) = '')`,
    )
    .run(DEFAULT_PANEL_KEY, guildId);

  getDb()
    .prepare('UPDATE ticket_settings SET panels_migrated = 1 WHERE guild_id = ?')
    .run(guildId);
}

/** Every panel for this guild, in display order. */
export function listTicketPanels(guildId) {
  migrateTicketPanels(guildId);

  return getDb()
    .prepare('SELECT * FROM ticket_panels WHERE guild_id = ? ORDER BY position, key')
    .all(guildId)
    .map(mapPanel);
}

export function getTicketPanel(guildId, key) {
  migrateTicketPanels(guildId);

  const normalized = normalizePanelKey(key) || DEFAULT_PANEL_KEY;

  return mapPanel(
    getDb()
      .prepare('SELECT * FROM ticket_panels WHERE guild_id = ? AND key = ?')
      .get(guildId, normalized),
  );
}

/** Returns the panel, creating it with defaults when it does not exist yet. */
export function ensureTicketPanel(guildId, key, patch = {}) {
  const normalized = normalizePanelKey(key) || DEFAULT_PANEL_KEY;
  const existing = getTicketPanel(guildId, normalized);

  if (existing) return existing;

  return upsertTicketPanel(guildId, normalized, patch);
}

/**
 * Creates or patches one panel. Callers may pass only the fields they changed;
 * undefined values are ignored so `publishPanel` cannot wipe a saved value.
 */
export function upsertTicketPanel(guildId, key, patch = {}) {
  const normalized = normalizePanelKey(key);

  if (!normalized) throw new Error('A ticket panel needs a key');

  const base = getTicketPanel(guildId, normalized);
  const clean = Object.fromEntries(
    Object.entries(patch ?? {}).filter(([, value]) => value !== undefined),
  );
  const next = {
    label: base?.label ?? humanizeKey(normalized),
    channelId: base?.channelId ?? null,
    messageId: base?.messageId ?? null,
    title: base?.title ?? '',
    description: base?.description ?? '',
    color: base?.color ?? null,
    footer: base?.footer ?? '',
    image: base?.image ?? '',
    thumbnail: base?.thumbnail ?? '',
    position: base?.position ?? nextPanelPosition(guildId),
    ...clean,
  };

  if (!base) {
    const panelCount = Number(
      getDb()
        .prepare('SELECT COUNT(*) AS value FROM ticket_panels WHERE guild_id = ?')
        .get(guildId)?.value ?? 0,
    );

    if (panelCount >= MAX_PANELS) {
      throw new Error(`A server can have at most ${MAX_PANELS} panels.`);
    }
  }

  next.label = String(next.label ?? '').trim().slice(0, 80) || humanizeKey(normalized);
  next.title = optionalText(next.title, 256);
  next.description = optionalText(next.description, 4096);
  next.footer = optionalText(next.footer, 2048);
  next.image = optionalText(next.image, 512);
  next.thumbnail = optionalText(next.thumbnail, 512);
  next.color = clampColor(next.color, base?.color ?? null);
  next.position = Math.max(0, Math.min(99, Math.trunc(Number(next.position) || 0)));
  next.channelId = next.channelId || null;
  next.messageId = next.messageId || null;

  const now = Date.now();

  getDb()
    .prepare(
      `INSERT INTO ticket_panels
         (guild_id, key, label, channel_id, message_id, title, description,
          color, footer, image, thumbnail, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, key) DO UPDATE SET
         label = excluded.label,
         channel_id = excluded.channel_id,
         message_id = excluded.message_id,
         title = excluded.title,
         description = excluded.description,
         color = excluded.color,
         footer = excluded.footer,
         image = excluded.image,
         thumbnail = excluded.thumbnail,
         position = excluded.position,
         updated_at = excluded.updated_at`,
    )
    .run(
      guildId,
      normalized,
      next.label,
      next.channelId,
      next.messageId,
      next.title,
      next.description,
      next.color,
      next.footer,
      next.image,
      next.thumbnail,
      next.position,
      base?.createdAt ?? now,
      now,
    );

  return getTicketPanel(guildId, normalized);
}

export function deleteTicketPanel(guildId, key) {
  const normalized = normalizePanelKey(key);
  const panel = getTicketPanel(guildId, normalized);

  if (!panel) return null;

  getDb()
    .prepare('DELETE FROM ticket_panels WHERE guild_id = ? AND key = ?')
    .run(guildId, normalized);

  return panel;
}

export function setTicketPanelMessage(guildId, key, { channelId = null, messageId = null } = {}) {
  return upsertTicketPanel(guildId, key, { channelId, messageId });
}

function positionInPanel(guildId, panelKey) {
  return Number(
    getDb()
      .prepare(
        `SELECT COUNT(*) AS value FROM ticket_types
         WHERE guild_id = ? AND panel_key = ?`,
      )
      .get(guildId, normalizePanelKey(panelKey) || DEFAULT_PANEL_KEY)?.value ?? 0,
  );
}

/**
 * Every button, in display order. Passing a panel key returns only that panel's
 * buttons; omitting it returns the whole guild.
 */
export function listTicketTypes(guildId, panelKey = null) {
  migrateTicketPanels(guildId);

  if (panelKey !== null && panelKey !== undefined) {
    const normalized = normalizePanelKey(panelKey);

    if (!normalized) return [];

    return getDb()
      .prepare(
        `SELECT * FROM ticket_types
         WHERE guild_id = ? AND panel_key = ?
         ORDER BY position, key`,
      )
      .all(guildId, normalized)
      .map(mapType);
  }

  return getDb()
    .prepare('SELECT * FROM ticket_types WHERE guild_id = ? ORDER BY position, key')
    .all(guildId)
    .map(mapType);
}

export function countPanelButtons(guildId, panelKey) {
  return positionInPanel(guildId, panelKey);
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
  const requestedPanel = normalizePanelKey(
    patch.panelKey ?? base?.panelKey ?? DEFAULT_PANEL_KEY,
  ) || DEFAULT_PANEL_KEY;
  const movedPanel = Boolean(base && requestedPanel !== base.panelKey);
  const next = {
    label: base?.label ?? humanizeKey(normalized),
    emoji: base?.emoji ?? '',
    panelKey: requestedPanel,
    categoryId: base?.categoryId ?? null,
    supportRoleIds: base?.supportRoleIds ?? [],
    pingRoleIds: base?.pingRoleIds ?? [],
    logChannelId: base?.logChannelId ?? null,
    welcomeMessage: base?.welcomeMessage ?? '',
    nameTemplate: base?.nameTemplate ?? 'ticket-{number}',
    maxOpen: base?.maxOpen ?? 1,
    color: base?.color ?? null,
    closeAction: base?.closeAction ?? 'delete',
    position: base && !movedPanel ? base.position : nextTypePosition(guildId, requestedPanel),
    buttonLabel: base?.buttonLabel ?? null,
    buttonStyle: base?.buttonStyle ?? null,
    ...patch,
  };

  next.panelKey = requestedPanel;

  if (!CLOSE_ACTIONS.includes(next.closeAction)) {
    next.closeAction = base?.closeAction ?? 'delete';
  }

  next.maxOpen = Math.max(1, Math.min(MAX_OPEN_LIMIT, Number(next.maxOpen) || 1));
  next.position = Math.max(0, Math.min(99, Math.trunc(Number(next.position) || 0)));
  next.label = String(next.label ?? normalized).trim().slice(0, 80) || normalized;
  next.emoji = String(next.emoji ?? '').trim().slice(0, 64);
  next.welcomeMessage = String(next.welcomeMessage ?? '').trim().slice(0, 1500);
  next.nameTemplate = String(next.nameTemplate ?? 'ticket-{number}').trim().slice(0, 80);

  next.buttonLabel = optionalText(next.buttonLabel, 80);
  next.color = clampColor(next.color, base?.color ?? null);

  if (next.buttonStyle !== null && next.buttonStyle !== undefined) {
    const style = String(next.buttonStyle).toLowerCase();

    next.buttonStyle = BUTTON_STYLES.includes(style) ? style : base?.buttonStyle ?? null;
  }

  getDb()
    .prepare(
      `INSERT INTO ticket_types
         (guild_id, key, label, emoji, panel_key, category_id, support_role_ids,
          ping_role_ids, log_channel_id, welcome_message, name_template, max_open,
          color, close_action, position, button_label, button_style, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, key) DO UPDATE SET
         label = excluded.label,
         emoji = excluded.emoji,
         panel_key = excluded.panel_key,
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
      next.panelKey,
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
    panelsMigrated: row ? Boolean(row.panels_migrated) : false,
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
          panel_image, panel_thumbnail, legacy_cleared, panels_migrated,
          updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
         panels_migrated = excluded.panels_migrated,
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
      next.panelsMigrated ? 1 : 0,
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
