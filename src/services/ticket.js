import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ModalBuilder,
  MessageFlags,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { COLORS, embed, errorEmbed, successEmbed } from '../lib/embeds.js';
import { createLogger } from '../lib/logger.js';
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
  const username = user?.username ?? user?.tag?.split('#')[0] ?? 'member';
  const template =
    type?.welcomeMessage ||
    'Thanks for opening a ticket, {mention}. A staff member will help you soon.';

  return template
    .replaceAll('{mention}', user ? `<@${user.id}>` : username)
    .replaceAll('{user}', username)
    .replaceAll('{username}', username)
    .replaceAll('{type}', type?.label ?? type?.key ?? 'ticket')
    .replaceAll('{server}', guild?.name ?? 'the server')
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

export const DEFAULT_PANEL_TITLE = 'Open a ticket';
export const DEFAULT_PANEL_DESCRIPTION =
  'Choose the option that fits your issue. Each button opens a private ticket with the right team.';
export const DEFAULT_PANEL_FOOTER = 'Pick the option that matches your issue';

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
      'The configured ticket category no longer exists. An admin can fix it with `/ticket button edit`.',
    );
  }

  return category;
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

  if (!type) throw new TicketError('That ticket button no longer exists.');

  if (!type.categoryId) {
    throw new TicketError(
      `**${type.label}** has no category yet. An admin needs to run \`/ticket button edit key:${type.key} category:#category\`.`,
    );
  }

  const existing = openTicketsFor(guild.id, user.id, type.key);

  if (existing.length >= type.maxOpen) {
    const first = existing[0];
    throw new TicketError(
      `You already have an open ${type.label} ticket${first?.channelId ? `: <#${first.channelId}>` : '.'}`,
    );
  }

  const category = await resolveCategory(guild, type.categoryId);
  const number = nextTicketNumber(guild.id, type.key);
  const name = channelNameFor(type, user, number);
  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `Ticket #${padTicketNumber(number)} • ${type.label} • ${user.tag ?? user.username} (${user.id})`,
    permissionOverwrites: permissionOverwrites(guild, type, user.id),
    reason: `Ticket #${padTicketNumber(number)} opened by ${user.tag ?? user.username}`,
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
      `I created the ticket channel but could not record it: ${error.message}`,
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
      .setLabel('Claim')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${TICKET_PREFIX}close:${channel.id}`)
      .setLabel('Close')
      .setStyle(ButtonStyle.Danger),
  );

  await channel.send({
    content: mentions,
    embeds: [
      embed({
        title: `Ticket #${padTicketNumber(number)}`,
        description: renderWelcome(type, { user, guild, number }),
        color: type.color ?? COLORS.primary,
        fields: [
          { name: 'Option', value: type.label, inline: true },
          { name: 'Opened by', value: `<@${user.id}>`, inline: true },
        ],
        footer: 'Use the buttons below to claim or close this ticket',
      }),
    ],
    components: [buttons],
    allowedMentions: { parse: [], roles: pingIds, users: [user.id] },
  }).catch(async (error) => {
    markTicketDeleted(ticket.id);
    await channel.delete('Could not post the ticket welcome message').catch(() => null);
    throw new TicketError(
      `I created <#${channel.id}> but could not post the welcome message: ${error.message}`,
    );
  });

  await logTicket(guild, type, {
    embeds: [
      embed({
        title: 'Ticket opened',
        description: `#${padTicketNumber(number)} · ${type.label}`,
        color: COLORS.success,
        fields: [
          { name: 'Member', value: `<@${user.id}> (${user.tag ?? user.username})`, inline: true },
          { name: 'Channel', value: `<#${channel.id}>`, inline: true },
          { name: 'Category', value: `<#${category.id}>`, inline: true },
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
          attachment.name ?? 'attachment',
        )}</a></div>`,
    )
    .join('');
  const embeds = [...(message.embeds ?? [])]
    .map((item) => renderEmbed(item?.data ?? item))
    .join('');

  return `<article class="message">
    <div class="meta"><span class="author">${escapeHtml(
      message.author?.tag ?? message.author?.username ?? 'Unknown',
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
  const rows = messages.map(renderMessage).join('\n') || '<p class="empty">No messages.</p>';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Ticket #${padTicketNumber(ticket.number)} transcript</title>
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
  <h1>Ticket #${padTicketNumber(ticket.number)} — ${escapeHtml(type?.label ?? ticket.typeKey)}</h1>
  <div class="sub">Opened by ${escapeHtml(ticket.openerTag || ticket.openerId)} · ${escapeHtml(
    new Date(ticket.createdAt ?? Date.now()).toISOString(),
  )} · ${messages.length} message(s)</div>
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
          description: description ?? `Ticket #${padTicketNumber(ticket.number)} · ${type?.label ?? ticket.typeKey}`,
          color: color ?? COLORS.muted,
          fields: [
            { name: 'Member', value: `<@${ticket.openerId}>`, inline: true },
            { name: 'Messages', value: String(transcript.messages), inline: true },
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
  title = 'Ticket transcript',
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
      .setLabel('Reopen')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${TICKET_PREFIX}transcript:${channelId}`)
      .setLabel('Transcript')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${TICKET_PREFIX}delete:${channelId}`)
      .setLabel('Delete')
      .setStyle(ButtonStyle.Danger),
  );
}

/**
 * Closes a ticket. The transcript is written first; if a log channel exists and
 * the type is set to delete, the channel is removed. Without a log channel the
 * ticket is archived instead, so history is never silently destroyed.
 */
export async function closeTicketChannel({ guild, channel, ticket, type, actor, reason }) {
  if (ticket.status !== 'open') {
    throw new TicketError('This ticket is already closed. Reopen it first.');
  }

  const transcript = await createTranscript(channel, ticket, type);
  const log = await sendTranscript(guild, ticket, type, transcript, {
    title: 'Ticket closed',
    description: `#${padTicketNumber(ticket.number)} · ${type?.label ?? ticket.typeKey}`,
    color: COLORS.danger,
  });

  closeTicketRecord(ticket.id, {
    closedBy: actor?.id ?? 'unknown',
    reason: reason || null,
  });

  let mode = log && (type?.closeAction ?? 'delete') === 'delete' ? 'delete' : 'archive';

  if (mode === 'delete') {
    try {
      await channel.delete(`Ticket closed by ${actor?.tag ?? actor?.id ?? 'staff'}`);
      markTicketDeleted(ticket.id);
      return { mode, transcript, logged: Boolean(log) };
    } catch (error) {
      logger.warn(`Could not delete the ticket channel: ${error.message}`);
      mode = 'archive';
      // Fall through to the archive path so the ticket is not left open.
    }
  }

  const closedName = sanitizeChannelName(`closed-${channel.name}`);

  await channel.setName(closedName).catch(() => null);
  await channel.permissionOverwrites
    ?.edit?.(ticket.openerId, { SendMessages: false })
    .catch(() => null);

  await channel
    .send({
      embeds: [
        embed({
          title: 'Ticket closed',
          description: reason
            ? `Closed by <@${actor?.id}>.\n**Reason:** ${reason}`
            : `Closed by <@${actor?.id}>.`,
          color: COLORS.danger,
          footer: log ? 'A transcript was saved to the log channel' : 'No log channel is set',
        }),
      ],
      components: [closedButtons(channel.id)],
    })
    .catch(() => null);

  return { mode, transcript, logged: Boolean(log) };
}

export async function reopenTicketChannel({ channel, ticket, type }) {
  const reopened = reopenTicketRecord(ticket.id);
  const name = channelNameFor(type, { username: ticket.openerTag?.split('#')[0] }, ticket.number);

  await channel.setName(name).catch(() => null);
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
          title: 'Ticket reopened',
          description: 'This ticket was reopened. A staff member will continue here.',
          color: COLORS.success,
        }),
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`${TICKET_PREFIX}claim:${channel.id}`)
            .setLabel('Claim')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`${TICKET_PREFIX}close:${channel.id}`)
            .setLabel('Close')
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

  if (!ticket) throw new TicketError('This channel is not a ticket.');

  return { ticket, type: getTicketType(guild.id, ticket.typeKey) };
}

function canClose(guild, member, ticket, type) {
  return ticket.openerId === member?.id || isStaffMember(guild, member, type);
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
      embeds: [
        successEmbed(
          'Ticket opened',
          `Your private ticket is ready: <#${channel.id}> (#${padTicketNumber(ticket.number)}).`,
        ),
      ],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    if (!(error instanceof TicketError)) {
      logger.error(`Could not open ticket "${typeKey}"`, error);
    }

    await interaction.editReply({
      embeds: [
        errorEmbed(
          'Could not open the ticket',
          error instanceof TicketError
            ? error.message
            : 'Something went wrong while creating the channel. Check my Manage Channels permission and the configured category.',
        ),
      ],
    });
  }
}

async function handleClaim(interaction, channelId) {
  await interaction.deferReply(ephemeral({}));

  try {
    const { ticket, type } = await ticketContext(interaction.guild, channelId);

    if (!isStaffMember(interaction.guild, interaction.member, type)) {
      throw new TicketError('Only the support team can claim tickets.');
    }

    const channel = await loadChannel(interaction.guild, channelId);

    if (!channel) throw new TicketError('The ticket channel no longer exists.');

    if (ticket.claimedBy === interaction.user.id) {
      claimTicket(ticket.id, null);
      await channel.send({
        embeds: [embed({ title: 'Ticket unclaimed', description: 'Anyone on the team can pick it up again.', color: COLORS.muted })],
        allowedMentions: { parse: [] },
      });
      await interaction.editReply({ content: 'This ticket is unclaimed again.' });
      return;
    }

    if (ticket.claimedBy) {
      throw new TicketError(`This ticket is already claimed by <@${ticket.claimedBy}>.`);
    }

    claimTicket(ticket.id, interaction.user.id);
    await channel.send({
      embeds: [
        embed({
          title: 'Ticket claimed',
          description: `This ticket is now handled by <@${interaction.user.id}>.`,
          color: COLORS.success,
        }),
      ],
      allowedMentions: { parse: [] },
    });
    await interaction.editReply({ content: 'You claimed this ticket.' });
  } catch (error) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          'Could not claim the ticket',
          error instanceof TicketError ? error.message : 'Something went wrong.',
        ),
      ],
    });
  }
}

async function handleCloseButton(interaction, channelId) {
  try {
    const { ticket, type } = await ticketContext(interaction.guild, channelId);

    if (!canClose(interaction.guild, interaction.member, ticket, type)) {
      throw new TicketError('Only the ticket opener or the support team can close this ticket.');
    }

    const modal = new ModalBuilder()
      .setCustomId(`${TICKET_PREFIX}close:${channelId}`)
      .setTitle('Close ticket')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('reason')
            .setLabel('Reason (optional)')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(400),
        ),
      );

    await interaction.showModal(modal);
  } catch (error) {
    await interaction
      .reply(
        ephemeral({
          embeds: [
            errorEmbed(
              'Could not close the ticket',
              error instanceof TicketError ? error.message : 'Something went wrong.',
            ),
          ],
        }),
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
      throw new TicketError('Only the ticket opener or the support team can export a transcript.');
    }

    const channel = await loadChannel(interaction.guild, channelId);

    if (!channel) throw new TicketError('The ticket channel no longer exists.');

    const transcript = await createTranscript(channel, ticket, type);
    const log = await sendTranscript(interaction.guild, ticket, type, transcript, {
      title: 'Ticket transcript',
      description: `#${padTicketNumber(ticket.number)} · ${type?.label ?? ticket.typeKey}`,
      color: COLORS.primary,
    });

    if (log) {
      await interaction.editReply({
        embeds: [
          successEmbed(
            'Transcript saved',
            `The transcript was sent to <#${log.channelId}> with ${transcript.messages} message(s).`,
          ),
        ],
      });
      return;
    }

    await interaction.editReply({
      content: 'No log channel is set, so here is the transcript directly.',
      files: [
        new AttachmentBuilder(Buffer.from(transcript.html, 'utf8'), {
          name: transcript.filename,
        }),
      ],
    });
  } catch (error) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          'Could not export the transcript',
          error instanceof TicketError ? error.message : 'Something went wrong.',
        ),
      ],
    });
  }
}

async function handleReopen(interaction, channelId) {
  await interaction.deferReply(ephemeral({}));

  try {
    const { ticket, type } = await ticketContext(interaction.guild, channelId);

    if (!isStaffMember(interaction.guild, interaction.member, type)) {
      throw new TicketError('Only the support team can reopen tickets.');
    }

    if (ticket.status === 'open') throw new TicketError('This ticket is already open.');

    const channel = await loadChannel(interaction.guild, channelId);

    if (!channel) throw new TicketError('The ticket channel no longer exists.');

    await reopenTicketChannel({ channel, ticket, type });
    await interaction.editReply({ content: 'The ticket was reopened.' });
  } catch (error) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          'Could not reopen the ticket',
          error instanceof TicketError ? error.message : 'Something went wrong.',
        ),
      ],
    });
  }
}

async function handleDelete(interaction, channelId) {
  await interaction.deferReply(ephemeral({}));

  try {
    const { ticket, type } = await ticketContext(interaction.guild, channelId);

    if (!isStaffMember(interaction.guild, interaction.member, type)) {
      throw new TicketError('Only the support team can delete tickets.');
    }

    markTicketDeleted(ticket.id);
    const channel = await loadChannel(interaction.guild, channelId);
    await channel?.delete?.(`Ticket deleted by ${interaction.user.tag ?? interaction.user.id}`).catch(
      () => null,
    );
    await interaction.editReply({ content: 'The ticket was deleted.' }).catch(() => null);
  } catch (error) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          'Could not delete the ticket',
          error instanceof TicketError ? error.message : 'Something went wrong.',
        ),
      ],
    });
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

    if (!canClose(interaction.guild, interaction.member, ticket, type)) {
      throw new TicketError('Only the ticket opener or the support team can close this ticket.');
    }

    const channel = await loadChannel(interaction.guild, channelId);

    if (!channel) throw new TicketError('The ticket channel no longer exists.');

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
        ? 'Ticket closed and deleted. The transcript was saved.'
        : result.logged
          ? 'Ticket closed and archived. The transcript was saved.'
          : 'Ticket closed and archived. No log channel is set, so no transcript was stored.';

    await interaction.editReply({ content: message }).catch(() => null);
  } catch (error) {
    if (!(error instanceof TicketError)) {
      logger.error('Could not close ticket from modal', error);
    }

    await interaction
      .editReply({
        embeds: [
          errorEmbed(
            'Could not close the ticket',
            error instanceof TicketError ? error.message : 'Something went wrong.',
          ),
        ],
      })
      .catch(() => null);
  }
}
