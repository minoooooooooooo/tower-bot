import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ModalBuilder,
  MessageFlags,
  PermissionFlagsBits,
  RateLimitError,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { COLORS, embed } from '../lib/embeds.js';
import { createLogger } from '../lib/logger.js';
import { errorReply, okReply } from '../lib/replies.js';
import {
  DEFAULT_PANEL_KEY,
  claimTicket,
  closeTicketRecord,
  createTicket,
  getTicketByChannel,
  getTicketPanel,
  getTicketSettings,
  getTicketType,
  listTicketPanels,
  listTicketTypes,
  markTicketDeleted,
  nextTicketNumber,
  normalizePanelKey,
  openTicketsFor,
  reopenTicketRecord,
  setTicketPanelMessage,
  setTicketTranscript,
  upsertTicketPanel,
} from './ticket-store.js';

const logger = createLogger('ticket');

export const TICKET_PREFIX = 'ticket:';

const PAGE_SIZE = 100;
const MAX_TRANSCRIPT_MESSAGES = 600;

/** A safe, expected failure whose message can be shown to the member. */
export class TicketError extends Error {}

export function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

export function padTicketNumber(number) {
  return String(number).padStart(4, '0');
}

export function sanitizeChannelName(value) {
  const clean = String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);

  return clean || 'ticket';
}

/** `{number}`, `{user}`, `{username}`, `{type}` inside the configured template. */
export function channelNameFor(type, user, number) {
  const template = type?.nameTemplate || 'ticket-{number}';
  const username = user?.username ?? user?.tag?.split('#')[0] ?? 'user';
  const rendered = template
    .replaceAll('{number}', padTicketNumber(number))
    .replaceAll('{user}', username)
    .replaceAll('{username}', username)
    .replaceAll('{type}', type?.key ?? 'ticket');

  return sanitizeChannelName(rendered);
}

export function renderWelcome(type, { user, guild, number } = {}) {
  const username = user?.username ?? user?.tag?.split('#')[0] ?? 'عضو';
  const template =
    type?.welcomeMessage ||
    'شكرًا على فتح التذكرة، {mention}. عضو من الفريق بيجيك قريب.';

  return template
    .replaceAll('{mention}', user ? `<@${user.id}>` : username)
    .replaceAll('{user}', username)
    .replaceAll('{username}', username)
    .replaceAll('{type}', type?.label ?? type?.key ?? 'تذكرة')
    .replaceAll('{server}', guild?.name ?? 'السيرفر')
    .replaceAll('{number}', padTicketNumber(number));
}

function applyEmoji(button, emoji) {
  if (!emoji) return button;

  try {
    button.setEmoji(emoji);
  } catch {
    // A malformed custom emoji must not stop the panel from rendering.
  }

  return button;
}

const BUTTON_STYLE_VALUES = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

/** Custom style wins; a plain ticket button is blue by default. */
export function buttonStyleFor(type) {
  return BUTTON_STYLE_VALUES[type?.buttonStyle] ?? ButtonStyle.Primary;
}

export function typeButton(type) {
  const button = new ButtonBuilder()
    .setCustomId(`${TICKET_PREFIX}open:${type.key}`)
    .setLabel(String(type.buttonLabel || type.label || type.key).slice(0, 80))
    .setStyle(buttonStyleFor(type));

  return applyEmoji(button, type.emoji);
}

export const DEFAULT_PANEL_TITLE = 'افتح تذكرة';
export const DEFAULT_PANEL_DESCRIPTION =
  'اختر الخيار اللي يناسب مشكلتك. كل زر يفتح تذكرة خاصة مع الفريق المناسب.';
export const DEFAULT_PANEL_FOOTER = 'اختر الخيار اللي يطابق مشكلتك';

/** Discord allows five buttons per row and five rows per message. */
export function buttonRows(types) {
  const rows = [];

  for (let index = 0; index < Math.min(types.length, 25); index += 5) {
    rows.push(
      new ActionRowBuilder().addComponents(...types.slice(index, index + 5).map(typeButton)),
    );
  }

  return rows;
}

/** One named panel: its own embed and only the buttons assigned to it. */
export function buildPanel(guildId, panelKey = DEFAULT_PANEL_KEY) {
  const key = normalizePanelKey(panelKey) || DEFAULT_PANEL_KEY;
  const panel = getTicketPanel(guildId, key);
  const types = listTicketTypes(guildId, key);

  return {
    embeds: [
      embed({
        title: panel?.title || DEFAULT_PANEL_TITLE,
        description: panel?.description || DEFAULT_PANEL_DESCRIPTION,
        color: panel?.color ?? COLORS.primary,
        footer: panel?.footer || DEFAULT_PANEL_FOOTER,
        image: panel?.image || undefined,
        thumbnail: panel?.thumbnail || undefined,
      }),
    ],
    components: buttonRows(types),
    allowedMentions: { parse: [] },
  };
}

async function fetchMessage(channel, messageId) {
  if (!channel?.messages?.fetch || !messageId) return null;
  return channel.messages.fetch(messageId).catch(() => null);
}

async function resolveChannelById(guild, channelId) {
  if (!channelId) return null;
  return (
    guild.channels.cache.get(channelId) ??
    (await guild.channels.fetch(channelId).catch(() => null))
  );
}

/**
 * Publishes or edits one panel. Re-posting is idempotent: the stored message is
 * edited in place, and a panel left in another channel is removed so the server
 * does not end up with two live copies of the same panel.
 *
 * `publishPanel(guild, channel, { title })` is accepted as shorthand for the
 * default panel, which keeps older call sites working.
 */
export async function publishPanel(
  guild,
  channel,
  panelKey = DEFAULT_PANEL_KEY,
  patch = {},
) {
  if (panelKey && typeof panelKey === 'object') {
    patch = panelKey;
    panelKey = DEFAULT_PANEL_KEY;
  }

  const key = normalizePanelKey(panelKey) || DEFAULT_PANEL_KEY;
  const before = getTicketPanel(guild.id, key);
  let panel = before ?? upsertTicketPanel(guild.id, key, {});

  if (Object.keys(patch ?? {}).length > 0) {
    panel = upsertTicketPanel(guild.id, key, patch);
  }

  const payload = buildPanel(guild.id, key);
  let message = null;

  if (panel.messageId && panel.channelId === channel.id) {
    const existing = await fetchMessage(channel, panel.messageId);

    if (existing) {
      message = await existing.edit(payload);
    }
  }

  if (!message && panel.messageId && panel.channelId && panel.channelId !== channel.id) {
    const oldChannel = await resolveChannelById(guild, panel.channelId);
    const old = await fetchMessage(oldChannel, panel.messageId);

    if (old) await old.delete().catch(() => null);
  }

  if (!message) {
    message = await channel.send(payload);
  }

  setTicketPanelMessage(guild.id, key, {
    channelId: channel.id,
    messageId: message.id,
  });

  return message;
}

/**
 * Re-edits every posted panel in place. Button changes call this so a server
 * never has to repost its panels by hand.
 */
export async function refreshPanels(guild) {
  let refreshed = 0;

  for (const panel of listTicketPanels(guild.id)) {
    if (!panel.messageId || !panel.channelId) continue;

    const channel = await resolveChannelById(guild, panel.channelId);

    if (!channel) continue;

    const message = await fetchMessage(channel, panel.messageId);

    if (!message) continue;

    const edited = await message
      .edit(buildPanel(guild.id, panel.key))
      .catch(() => null);

    if (edited) refreshed += 1;
  }

  return refreshed;
}

export function isStaffMember(guild, member, type) {
  if (!member) return false;

  if (guild?.ownerId === member.id) return true;
  if (
    member.permissions?.has?.(PermissionFlagsBits.Administrator) ||
    member.permissions?.has?.(PermissionFlagsBits.ManageGuild) ||
    member.permissions?.has?.(PermissionFlagsBits.ManageChannels)
  ) {
    return true;
  }

  const roleIds = new Set([
    ...(type?.supportRoleIds ?? []),
    ...(type?.pingRoleIds ?? []),
  ]);

  return Boolean(member.roles?.cache?.some?.((role) => roleIds.has(role.id)));
}

async function resolveCategory(guild, categoryId) {
  const category =
    guild.channels.cache.get(categoryId) ??
    (await guild.channels.fetch(categoryId).catch(() => null));

  if (!category || category.type !== ChannelType.GuildCategory) {
    throw new TicketError(
      'فئة التذاكر المضبوطة ما عادت موجودة. المشرف يقدر يصلحها بـ `/ticket button edit`.',
    );
  }

  return category;
}

/**
 * Moves a ticket channel. A missing category must not block the close, so the
 * channel simply stays where it is. Parent-only edits are not subject to the
 * name/topic sublimit.
 */
async function moveTicketChannel(channel, category) {
  if (!category) return;

  try {
    await channel.setParent(category.id, { lockPermissions: false });
  } catch (error) {
    logger.warn(`Could not move the ticket channel: ${error.message}`);
  }
}

/**
 * Renames a ticket channel, but gives up immediately when Discord's channel-edit
 * limit is active. `rest.rejectOnRateLimit` turns the usual multi-minute wait
 * into an instant `RateLimitError`, so a close never appears stuck on "typing".
 */
async function renameTicketChannel(channel, name) {
  try {
    await channel.setName(name);
  } catch (error) {
    if (error instanceof RateLimitError || error?.name === 'RateLimitError') {
      const seconds = Math.max(1, Math.round((error.retryAfter ?? 0) / 1000));

      logger.warn(
        `Skipped renaming ticket channel ${channel.id}; Discord's channel-edit limit is active for another ${seconds}s`,
      );

      return;
    }

    logger.warn(`Could not rename the ticket channel: ${error.message}`);
  }
}

function permissionOverwrites(guild, type, openerId) {
  const allow = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AddReactions,
  ];
  const roleIds = [...new Set([...type.supportRoleIds, ...type.pingRoleIds])];
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: openerId,
      allow,
    },
  ];

  for (const roleId of roleIds) {
    overwrites.push({ id: roleId, allow });
  }

  const me = guild.members?.me;

  if (me) {
    overwrites.push({
      id: me.id,
      allow: [
        ...allow,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
      ],
    });
  }

  return overwrites;
}

async function resolveLogChannel(guild, type) {
  const id = type?.logChannelId || getTicketSettings(guild.id).logChannelId;

  if (!id) return null;

  const channel =
    guild.channels.cache.get(id) ??
    (await guild.channels.fetch(id).catch(() => null));

  return channel?.isTextBased?.() === false ? null : channel ?? null;
}

async function logTicket(guild, type, payload) {
  const channel = await resolveLogChannel(guild, type);

  if (!channel) return null;

  return channel.send(payload).catch((error) => {
    logger.warn(`Could not write the ticket log: ${error.message}`);
    return null;
  });
}

/**
 * Creates the private channel, the database row and the welcome message. The
 * caller has already acknowledged the interaction, so a slow Discord call does
 * not expire the button.
 */
export async function createTicketChannel({ guild, user, typeKey }) {
  const type = getTicketType(guild.id, typeKey);

  if (!type) throw new TicketError('هذا الزر ما عاد موجود.');

  if (!type.categoryId) {
    throw new TicketError(
      `**${type.label}** ما له فئة. المشرف يحتاج يشغّل \`/ticket button edit key:${type.key} category:#category\`.`,
    );
  }

  const existing = openTicketsFor(guild.id, user.id, type.key);

  if (existing.length >= type.maxOpen) {
    const first = existing[0];
    throw new TicketError(
      `عندك تذكرة ${type.label} مفتوحة${first?.channelId ? `: <#${first.channelId}>` : '.'}`,
    );
  }

  const category = await resolveCategory(guild, type.categoryId);
  const number = nextTicketNumber(guild.id, type.key);
  const name = channelNameFor(type, user, number);
  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `تذكرة #${padTicketNumber(number)} • ${type.label} • ${user.tag ?? user.username} (${user.id})`,
    permissionOverwrites: permissionOverwrites(guild, type, user.id),
    reason: `تذكرة #${padTicketNumber(number)} فتحها ${user.tag ?? user.username}`,
  });

  let ticket;

  try {
    ticket = createTicket({
      guildId: guild.id,
      channelId: channel.id,
      number,
      typeKey: type.key,
      openerId: user.id,
      openerTag: user.tag ?? user.username,
    });
  } catch (error) {
    await channel.delete('Could not record the ticket').catch(() => null);
    throw new TicketError(
      `سويت قناة التذكرة بس ما قدرت أسجّلها: ${error.message}`,
    );
  }

  const pingIds = type.pingRoleIds.length ? type.pingRoleIds : type.supportRoleIds;
  // Mentions inside an embed never notify, so the opener and the ping roles go in
  // the message content. allowedMentions keeps it to exactly those roles plus the
  // opener, instead of parsing everything the welcome text happens to contain.
  const mentions = [`<@${user.id}>`, ...pingIds.map((id) => `<@&${id}>`)].join(' ');
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${TICKET_PREFIX}claim:${channel.id}`)
      .setLabel('استلام')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${TICKET_PREFIX}close:${channel.id}`)
      .setLabel('إغلاق')
      .setStyle(ButtonStyle.Danger),
  );

  await channel.send({
    content: mentions,
    embeds: [
      embed({
        title: `تذكرة #${padTicketNumber(number)}`,
        description: renderWelcome(type, { user, guild, number }),
        color: type.color ?? COLORS.primary,
        fields: [
          { name: 'الخيار', value: type.label, inline: true },
          { name: 'فتحها', value: `<@${user.id}>`, inline: true },
        ],
        footer: 'استخدم الأزرار تحت عشان تستلم التذكرة أو تقفلها',
      }),
    ],
    components: [buttons],
    allowedMentions: { parse: [], roles: pingIds, users: [user.id] },
  }).catch(async (error) => {
    markTicketDeleted(ticket.id);
    await channel.delete('Could not post the ticket welcome message').catch(() => null);
    throw new TicketError(
      `سويت <#${channel.id}> بس ما قدرت أكتب رسالة الترحيب: ${error.message}`,
    );
  });

  await logTicket(guild, type, {
    embeds: [
      embed({
        title: 'انفتحت تذكرة',
        description: `#${padTicketNumber(number)} · ${type.label}`,
        color: COLORS.success,
        fields: [
          { name: 'العضو', value: `<@${user.id}> (${user.tag ?? user.username})`, inline: true },
          { name: 'القناة', value: `<#${channel.id}>`, inline: true },
          { name: 'الفئة', value: `<#${category.id}>`, inline: true },
        ],
      }),
    ],
    allowedMentions: { parse: [] },
  });

  return { ticket, type, channel };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderEmbed(embedData) {
  if (!embedData) return '';

  const fields = (embedData.fields ?? [])
    .map(
      (field) =>
        `<div class="field"><strong>${escapeHtml(field.name)}</strong><div>${escapeHtml(field.value)}</div></div>`,
    )
    .join('');

  return `<div class="embed">${
    embedData.title ? `<div class="embed-title">${escapeHtml(embedData.title)}</div>` : ''
  }${
    embedData.description
      ? `<div class="embed-description">${escapeHtml(embedData.description)}</div>`
      : ''
  }${fields}</div>`;
}

function renderMessage(message) {
  const attachments = [...(message.attachments?.values?.() ?? [])]
    .map(
      (attachment) =>
        `<div class="attachment">📎 <a href="${escapeHtml(attachment.url)}">${escapeHtml(
          attachment.name ?? 'مرفق',
        )}</a></div>`,
    )
    .join('');
  const embeds = [...(message.embeds ?? [])]
    .map((item) => renderEmbed(item?.data ?? item))
    .join('');

  return `<article class="message">
    <div class="meta"><span class="author">${escapeHtml(
      message.author?.tag ?? message.author?.username ?? 'غير معروف',
    )}</span><span class="time">${escapeHtml(
      new Date(message.createdTimestamp ?? Date.now()).toISOString(),
    )}</span></div>
    ${message.content ? `<div class="content">${escapeHtml(message.content)}</div>` : ''}
    ${embeds}
    ${attachments}
  </article>`;
}

export async function collectTranscript(channel, limit = MAX_TRANSCRIPT_MESSAGES) {
  const messages = [];
  let before;

  while (messages.length < limit) {
    const batch = await channel.messages.fetch({
      limit: Math.min(PAGE_SIZE, limit - messages.length),
      before,
    });

    if (!batch?.size) break;

    messages.push(...batch.values());
    before = batch.last()?.id;

    if (batch.size < PAGE_SIZE) break;
  }

  return messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

export async function createTranscript(channel, ticket, type) {
  const messages = await collectTranscript(channel);
  const rows = messages.map(renderMessage).join('\n') || '<p class="empty">ما فيه رسائل.</p>';
  const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<title>تذكرة #${padTicketNumber(ticket.number)} — نسخة المحادثة</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 32px; background: #1e1f22; color: #dbdee1; font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 900px; margin: 0 auto; }
  header { border-bottom: 1px solid #3f4147; margin-bottom: 24px; padding-bottom: 16px; }
  h1 { margin: 0 0 8px; font-size: 24px; }
  .sub { color: #949ba4; }
  .message { background: #2b2d31; border-radius: 8px; padding: 12px 14px; margin: 0 0 10px; }
  .meta { display: flex; gap: 12px; justify-content: space-between; color: #949ba4; font-size: 12px; margin-bottom: 4px; }
  .author { color: #f2f3f5; font-weight: 600; }
  .content { white-space: pre-wrap; word-wrap: break-word; }
  .embed { border-left: 4px solid #5865f2; background: #232428; padding: 8px 12px; margin-top: 8px; }
  .embed-title { font-weight: 700; margin-bottom: 4px; }
  .embed-description { white-space: pre-wrap; }
  .field { margin-top: 6px; }
  .attachment { margin-top: 6px; font-size: 13px; }
  a { color: #00a8fc; }
  .empty { color: #949ba4; }
</style>
</head>
<body>
<main>
<header>
  <h1>تذكرة #${padTicketNumber(ticket.number)} — ${escapeHtml(type?.label ?? ticket.typeKey)}</h1>
  <div class="sub">فتحها ${escapeHtml(ticket.openerTag || ticket.openerId)} · ${escapeHtml(
    new Date(ticket.createdAt ?? Date.now()).toISOString(),
  )} · ${messages.length} رسالة</div>
</header>
${rows}
</main>
</body>
</html>`;

  return {
    html,
    filename: `ticket-${padTicketNumber(ticket.number)}.html`,
    messages: messages.length,
  };
}

async function sendTranscript(guild, ticket, type, transcript, { title, description, color }) {
  const logChannel = await resolveLogChannel(guild, type);

  if (!logChannel) return null;

  const file = new AttachmentBuilder(Buffer.from(transcript.html, 'utf8'), {
    name: transcript.filename,
  });

  const message = await logChannel
    .send({
      embeds: [
        embed({
          title,
          description: description ?? `تذكرة #${padTicketNumber(ticket.number)} · ${type?.label ?? ticket.typeKey}`,
          color: color ?? COLORS.muted,
          fields: [
            { name: 'العضو', value: `<@${ticket.openerId}>`, inline: true },
            { name: 'الرسائل', value: String(transcript.messages), inline: true },
          ],
        }),
      ],
      files: [file],
      allowedMentions: { parse: [] },
    })
    .catch((error) => {
      logger.warn(`Could not write the ticket transcript: ${error.message}`);
      return null;
    });

  if (message) setTicketTranscript(ticket.id, message.id);

  return message;
}

/** Used by `/ticket transcript`: writes the log file and returns both parts. */
export async function saveTicketTranscript({
  guild,
  channel,
  ticket,
  type,
  title = 'نسخة التذكرة',
  description = null,
  color = COLORS.primary,
}) {
  const transcript = await createTranscript(channel, ticket, type);
  const log = await sendTranscript(guild, ticket, type, transcript, {
    title,
    description,
    color,
  });

  return { transcript, log };
}

function closedButtons(channelId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${TICKET_PREFIX}reopen:${channelId}`)
      .setLabel('إعادة فتح')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${TICKET_PREFIX}transcript:${channelId}`)
      .setLabel('نسخة المحادثة')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${TICKET_PREFIX}delete:${channelId}`)
      .setLabel('حذف')
      .setStyle(ButtonStyle.Danger),
  );
}

async function setOpenerAccess(channel, ticket, allow) {
  try {
    await channel.permissionOverwrites?.edit?.(ticket.openerId, {
      ViewChannel: allow,
      SendMessages: allow,
      ReadMessageHistory: allow,
    });

    return true;
  } catch (error) {
    logger.warn(
      `Could not ${allow ? 'restore' : 'hide'} ticket #${padTicketNumber(ticket.number)} for the opener: ${error.message}`,
    );

    return false;
  }
}

/**
 * Closes a ticket. The opener is hidden before the transcript is collected, so a
 * slow transcript never leaves the member watching the ticket. The transcript is
 * written first; if a log channel exists and the type is set to delete, the
 * channel is removed. Without a log channel the ticket is archived instead, so
 * history is never silently destroyed.
 */
export async function closeTicketChannel({ guild, channel, ticket, type, actor, reason }) {
  if (ticket.status !== 'open') {
    throw new TicketError('هذي التذكرة مقفلة أصلًا. رجّعها أول.');
  }

  const hidden = await setOpenerAccess(channel, ticket, false);

  try {
    const buildStarted = Date.now();
    const transcript = await createTranscript(channel, ticket, type);
    const builtMs = Date.now() - buildStarted;
    const logStarted = Date.now();
    const log = await sendTranscript(guild, ticket, type, transcript, {
      title: 'انقفلت التذكرة',
      description: `#${padTicketNumber(ticket.number)} · ${type?.label ?? ticket.typeKey}`,
      color: COLORS.danger,
    });

    logger.info(
      `Ticket #${padTicketNumber(ticket.number)} transcript: ${transcript.messages} message(s) in ${builtMs} ms; log ${
        log ? `written in ${Date.now() - logStarted} ms` : 'skipped'
      }`,
    );

    closeTicketRecord(ticket.id, {
      closedBy: actor?.id ?? 'unknown',
      reason: reason || null,
    });

    let mode = log && (type?.closeAction ?? 'delete') === 'delete' ? 'delete' : 'archive';

    if (mode === 'delete') {
      try {
        await channel.delete(`تذكرة سكّرها ${actor?.tag ?? actor?.id ?? 'مشرف'}`);
        markTicketDeleted(ticket.id);
        return { mode, transcript, logged: Boolean(log) };
      } catch (error) {
        logger.warn(`Could not delete the ticket channel: ${error.message}`);
        mode = 'archive';
        // Fall through to the archive path so the ticket is not left open.
      }
    }

    const closedName = sanitizeChannelName(`closed-${channel.name}`);
    let closedCategory = null;

    if (type?.closedCategoryId) {
      try {
        closedCategory = await resolveCategory(guild, type.closedCategoryId);
      } catch (error) {
        // A deleted category must not block closing; the ticket simply stays put.
        logger.warn(`Could not move the closed ticket: ${error.message}`);
      }
    }

    await moveTicketChannel(channel, closedCategory);
    await renameTicketChannel(channel, closedName);
    if (!hidden) await setOpenerAccess(channel, ticket, false);

    await channel
      .send({
        embeds: [
          embed({
            title: 'انقفلت التذكرة',
            description: reason
              ? `قفلها <@${actor?.id}>.\n**السبب:** ${reason}`
              : `قفلها <@${actor?.id}>.`,
            color: COLORS.danger,
            footer: log ? 'انحفظت نسخة المحادثة في قناة السجل' : 'ما فيه قناة سجل مضبوطة',
          }),
        ],
        components: [closedButtons(channel.id)],
      })
      .catch(() => null);

    return { mode, transcript, logged: Boolean(log) };
  } catch (error) {
    // The ticket is still open, so give the opener their channel back.
    if (hidden) await setOpenerAccess(channel, ticket, true);

    throw error;
  }
}

export async function reopenTicketChannel({ guild, channel, ticket, type }) {
  const reopened = reopenTicketRecord(ticket.id);
  const name = channelNameFor(type, { username: ticket.openerTag?.split('#')[0] }, ticket.number);
  let category = null;

  if (type?.categoryId) {
    try {
      category = await resolveCategory(guild, type.categoryId);
    } catch (error) {
      // Keep the reopen working even if the category was deleted meanwhile.
      logger.warn(`Could not move the reopened ticket: ${error.message}`);
    }
  }

  await moveTicketChannel(channel, category);
  await renameTicketChannel(channel, name);
  await channel.permissionOverwrites
    ?.edit?.(ticket.openerId, {
      SendMessages: true,
      ViewChannel: true,
      ReadMessageHistory: true,
    })
    .catch(() => null);

  await channel
    .send({
      embeds: [
        embed({
          title: 'رجعت التذكرة',
          description: 'هذي التذكرة رجعت مفتوحة. عضو من الفريق بيكمل معك هنا.',
          color: COLORS.success,
        }),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`${TICKET_PREFIX}claim:${channel.id}`)
            .setLabel('استلام')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`${TICKET_PREFIX}close:${channel.id}`)
            .setLabel('إغلاق')
            .setStyle(ButtonStyle.Danger),
        ),
      ],
    })
    .catch(() => null);

  return reopened;
}

async function loadChannel(guild, channelId) {
  return (
    guild.channels.cache.get(channelId) ??
    (await guild.channels.fetch(channelId).catch(() => null))
  );
}

async function ticketContext(guild, channelId) {
  const ticket = getTicketByChannel(guild.id, channelId);

  if (!ticket) throw new TicketError('هذي القناة مو تذكرة.');

  return { ticket, type: getTicketType(guild.id, ticket.typeKey) };
}

async function handleOpen(interaction, typeKey) {
  await interaction.deferReply(ephemeral({}));

  try {
    const { ticket, channel } = await createTicketChannel({
      guild: interaction.guild,
      user: interaction.user,
      typeKey,
    });

    await interaction.editReply({
      ...okReply(
        'انفتحت التذكرة',
        `تذكرتك الخاصة جاهزة: <#${channel.id}> (#${padTicketNumber(ticket.number)}).`,
      ),
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    if (!(error instanceof TicketError)) {
      logger.error(`Could not open ticket "${typeKey}"`, error);
    }

    await interaction.editReply(
      errorReply(
        'ما قدرت أفتح التذكرة',
        error instanceof TicketError
          ? error.message
          : 'صار خطأ وأنا أسوي القناة. تأكد من صلاحية **إدارة القنوات** عندي ومن الفئة المضبوطة.',
      ),
    );
  }
}

async function handleClaim(interaction, channelId) {
  await interaction.deferReply(ephemeral({}));

  try {
    const { ticket, type } = await ticketContext(interaction.guild, channelId);

    if (!isStaffMember(interaction.guild, interaction.member, type)) {
      throw new TicketError('فريق الدعم بس يقدر يستلم التذاكر.');
    }

    const channel = await loadChannel(interaction.guild, channelId);

    if (!channel) throw new TicketError('قناة التذكرة ما عادت موجودة.');

    if (ticket.claimedBy === interaction.user.id) {
      claimTicket(ticket.id, null);
      await channel.send({
        embeds: [embed({ title: 'التذكرة صارت غير مستلمة', description: 'أي أحد من الفريق يقدر يستلمها من جديد.', color: COLORS.muted })],
        allowedMentions: { parse: [] },
      });
      await interaction.editReply({ content: 'رجعناها غير مستلمة.' });
      return;
    }

    if (ticket.claimedBy) {
      throw new TicketError(`هذي التذكرة مستلمها <@${ticket.claimedBy}>.`);
    }

    claimTicket(ticket.id, interaction.user.id);
    await channel.send({
      embeds: [
        embed({
          title: 'التذكرة صارت مستلمة',
          description: `الحين يتابعها <@${interaction.user.id}>.`,
          color: COLORS.success,
        }),
      ],
      allowedMentions: { parse: [] },
    });
    await interaction.editReply({ content: 'استلمت التذكرة.' });
  } catch (error) {
    await interaction.editReply(
      errorReply(
        'ما قدرت أستلم التذكرة',
        error instanceof TicketError ? error.message : 'صار خطأ.',
      ),
    );
  }
}

async function handleCloseButton(interaction, channelId) {
  try {
    const { type } = await ticketContext(interaction.guild, channelId);

    if (!isStaffMember(interaction.guild, interaction.member, type)) {
      throw new TicketError('فريق الدعم بس يقدر يقفل التذاكر.');
    }

    const modal = new ModalBuilder()
      .setCustomId(`${TICKET_PREFIX}close:${channelId}`)
      .setTitle('إغلاق التذكرة')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('reason')
            .setLabel('السبب (اختياري)')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(400),
        ),
      );

    await interaction.showModal(modal);
  } catch (error) {
    await interaction
      .reply(
        ephemeral(
          errorReply(
            'ما قدرت أقفل التذكرة',
            error instanceof TicketError ? error.message : 'صار خطأ.',
          ),
        ),
      )
      .catch(() => null);
  }
}

async function handleTranscriptButton(interaction, channelId) {
  await interaction.deferReply(ephemeral({}));

  try {
    const { ticket, type } = await ticketContext(interaction.guild, channelId);

    if (
      ticket.openerId !== interaction.user.id &&
      !isStaffMember(interaction.guild, interaction.member, type)
    ) {
      throw new TicketError('صاحب التذكرة أو فريق الدعم بس يقدر يصدّر نسخة.');
    }

    const channel = await loadChannel(interaction.guild, channelId);

    if (!channel) throw new TicketError('قناة التذكرة ما عادت موجودة.');

    const transcript = await createTranscript(channel, ticket, type);
    const log = await sendTranscript(interaction.guild, ticket, type, transcript, {
      title: 'نسخة التذكرة',
      description: `#${padTicketNumber(ticket.number)} · ${type?.label ?? ticket.typeKey}`,
      color: COLORS.primary,
    });

    if (log) {
      await interaction.editReply(
        okReply(
          'انحفظت النسخة',
          `انرسلت إلى <#${log.channelId}> ومعها ${transcript.messages} رسالة.`,
        ),
      );
      return;
    }

    await interaction.editReply({
      content: 'ما فيه قناة سجل مضبوطة، فهذي النسخة مباشرة.',
      files: [
        new AttachmentBuilder(Buffer.from(transcript.html, 'utf8'), {
          name: transcript.filename,
        }),
      ],
    });
  } catch (error) {
    await interaction.editReply(
      errorReply(
        'ما قدرت أصدّر النسخة',
        error instanceof TicketError ? error.message : 'صار خطأ.',
      ),
    );
  }
}

async function handleReopen(interaction, channelId) {
  await interaction.deferReply(ephemeral({}));

  try {
    const { ticket, type } = await ticketContext(interaction.guild, channelId);

    if (!isStaffMember(interaction.guild, interaction.member, type)) {
      throw new TicketError('فريق الدعم بس يقدر يرجّع التذاكر.');
    }

    if (ticket.status === 'open') throw new TicketError('هذي التذكرة مفتوحة أصلًا.');

    const channel = await loadChannel(interaction.guild, channelId);

    if (!channel) throw new TicketError('قناة التذكرة ما عادت موجودة.');

    await reopenTicketChannel({ guild: interaction.guild, channel, ticket, type });
    await interaction.editReply({ content: 'رجعت التذكرة.' });
  } catch (error) {
    await interaction.editReply(
      errorReply(
        'ما قدرت أرجّع التذكرة',
        error instanceof TicketError ? error.message : 'صار خطأ.',
      ),
    );
  }
}

async function handleDelete(interaction, channelId) {
  await interaction.deferReply(ephemeral({}));

  try {
    const { ticket, type } = await ticketContext(interaction.guild, channelId);

    if (!isStaffMember(interaction.guild, interaction.member, type)) {
      throw new TicketError('فريق الدعم بس يقدر يحذف التذاكر.');
    }

    markTicketDeleted(ticket.id);
    const channel = await loadChannel(interaction.guild, channelId);
    await channel?.delete?.(`تذكرة حذفها ${interaction.user.tag ?? interaction.user.id}`).catch(
      () => null,
    );
    await interaction.editReply({ content: 'انحذفت التذكرة.' }).catch(() => null);
  } catch (error) {
    await interaction.editReply(
      errorReply(
        'ما قدرت أحذف التذكرة',
        error instanceof TicketError ? error.message : 'صار خطأ.',
      ),
    );
  }
}

/** Routes every button whose custom id starts with `ticket:`. */
export async function handleTicketButton(interaction) {
  const [, action, ...rest] = String(interaction.customId).split(':');

  if (action === 'open') return handleOpen(interaction, rest.join(':'));
  if (action === 'claim') return handleClaim(interaction, rest[0]);
  if (action === 'close') return handleCloseButton(interaction, rest[0]);
  if (action === 'transcript') return handleTranscriptButton(interaction, rest[0]);
  if (action === 'reopen') return handleReopen(interaction, rest[0]);
  if (action === 'delete') return handleDelete(interaction, rest[0]);
}

/** Handles the close-reason modal. */
export async function handleTicketModal(interaction) {
  const [, action, channelId] = String(interaction.customId).split(':');

  if (action !== 'close') return;

  await interaction.deferReply(ephemeral({}));

  try {
    const { ticket, type } = await ticketContext(interaction.guild, channelId);

    if (!isStaffMember(interaction.guild, interaction.member, type)) {
      throw new TicketError('فريق الدعم بس يقدر يقفل التذاكر.');
    }

    const channel = await loadChannel(interaction.guild, channelId);

    if (!channel) throw new TicketError('قناة التذكرة ما عادت موجودة.');

    const reason = interaction.fields?.getTextInputValue?.('reason') ?? '';
    const result = await closeTicketChannel({
      guild: interaction.guild,
      channel,
      ticket,
      type,
      actor: interaction.user,
      reason,
    });

    const message =
      result.mode === 'delete'
        ? 'انقفلت التذكرة وانحذفت. النسخة انحفظت.'
        : result.logged
          ? 'انقفلت التذكرة وانؤرشفت. النسخة انحفظت.'
          : 'انقفلت التذكرة وانؤرشفت. ما فيه قناة سجل مضبوطة، فما انحفظت نسخة.';

    await interaction.editReply({ content: message }).catch(() => null);
  } catch (error) {
    if (!(error instanceof TicketError)) {
      logger.error('Could not close ticket from modal', error);
    }

    await interaction
      .editReply(
        errorReply(
          'ما قدرت أقفل التذكرة',
          error instanceof TicketError ? error.message : 'صار خطأ.',
        ),
      )
      .catch(() => null);
  }
}
