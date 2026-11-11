import {
  AttachmentBuilder,
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, embed, errorEmbed, successEmbed, warningEmbed } from '../../lib/embeds.js';
import { resolveChannel, resolveMember, resolveRole } from '../../lib/resolve.js';
import { parseColor } from '../general/color.js';
import {
  BUTTON_STYLES,
  CLOSE_ACTIONS,
  claimTicket,
  deleteTicketType,
  getTicketByChannel,
  getTicketSettings,
  getTicketType,
  listTicketTypes,
  normalizeTypeKey,
  openTicketsFor,
  ticketCounts,
  updateTicketSettings,
  upsertTicketType,
} from '../../services/ticket-store.js';
import {
  TicketError,
  closeTicketChannel,
  ephemeral,
  isStaffMember,
  publishPanel,
  saveTicketTranscript,
  sanitizeChannelName,
} from '../../services/ticket.js';

function isAdmin(ctx) {
  return Boolean(ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild));
}

async function requireAdmin(ctx) {
  if (isAdmin(ctx)) return true;

  await ctx.reply(
    ephemeral({
      embeds: [errorEmbed('Missing permissions', 'You need **Manage Server** to configure tickets.')],
    }),
  );

  return false;
}

function isClearValue(value) {
  return ['none', 'off', 'clear', '-'].includes(String(value ?? '').trim().toLowerCase());
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseDesignColor(value) {
  if (value === null || value === undefined || isClearValue(value)) return null;

  const parsed = parseColor(String(value));

  if (!parsed) {
    throw new TicketError(`\`${value}\` is not a color. Try \`#5865f2\`, \`red\` or \`none\`.`);
  }

  return parsed.value;
}

function parseButtonStyle(value) {
  if (value === null || value === undefined || isClearValue(value)) return null;

  const style = String(value).toLowerCase();

  if (!BUTTON_STYLES.includes(style)) {
    throw new TicketError(`Use a button style: ${BUTTON_STYLES.join(', ')} or none.`);
  }

  return style;
}

async function resolveTextChannel(guild, value) {
  if (value === null || value === undefined) return null;
  if (isClearValue(value)) return null;

  const channel = await resolveChannel(guild, value);

  if (!channel) throw new TicketError(`Unknown channel: \`${value}\`.`);
  if (channel.isTextBased?.() === false) throw new TicketError(`<#${channel.id}> is not a text channel.`);

  return channel;
}

async function resolveCategory(guild, value) {
  if (value === null || value === undefined) return null;
  if (isClearValue(value)) return null;

  const channel = await resolveChannel(guild, value);

  if (!channel) throw new TicketError(`Unknown category: \`${value}\`.`);
  if (channel.type !== ChannelType.GuildCategory) {
    throw new TicketError(`<#${channel.id}> is not a category.`);
  }

  return channel;
}

async function resolveRoleList(guild, value) {
  if (value === null || value === undefined) return [];
  if (isClearValue(value)) return [];

  const tokens = String(value)
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  const ids = [];

  for (const token of tokens) {
    const role = await resolveRole(guild, token);

    if (!role) throw new TicketError(`Unknown role: \`${token}\`.`);
    ids.push(role.id);
  }

  return [...new Set(ids)];
}

function roleList(ids) {
  return ids?.length ? ids.map((id) => `<@&${id}>`).join(', ') : 'none';
}

function channelLabel(guild, id) {
  return id ? guild?.channels?.cache?.get(id)?.toString?.() ?? `<#${id}>` : 'not set';
}

function parseFlagTokens(args) {
  const flags = {};
  const rest = [];

  for (const token of args) {
    const separator = token.indexOf('=');

    if (separator > 0) {
      flags[token.slice(0, separator).trim().toLowerCase()] = token.slice(separator + 1);
    } else if (token) {
      rest.push(token);
    }
  }

  return { flags, rest };
}

function buttonLine(button) {
  return [
    `**${button.buttonLabel || button.label}** · \`${button.key}\``,
    `Category: ${button.categoryId ? `<#${button.categoryId}>` : '⚠️ not set'} · Style: ${button.buttonStyle ?? 'primary'}`,
    `Support: ${roleList(button.supportRoleIds)} · Ping: ${roleList(button.pingRoleIds)}`,
    `Max open: ${button.maxOpen} · Close: ${button.closeAction}`,
  ].join('\n');
}

function overviewEmbed() {
  return embed({
    title: 'Tickets',
    description: [
      'A single, fully customizable ticket panel. You choose the embed and every button.',
      '',
      '**Member commands**',
      '`/ticket close [reason]` — close the ticket you are in',
      '`/ticket claim` — claim or unclaim a ticket (support team)',
      '`/ticket transcript` — save the transcript (opener or support team)',
      '',
      '**Admin setup**',
      '`/ticket button add key:general label:Support category:#tickets` — create a button',
      '`/ticket button edit key:general ...` — change its text, color, category, roles or welcome',
      '`/ticket button remove key:general confirm:true` — delete a button',
      '`/ticket panel ...` — edit the embed and post or refresh the panel',
      '`/ticket list` — show the panel and every button',
      '`/ticket log #channel` — where transcripts and ticket events go',
      '',
      'Every value can be changed later. Nothing is predefined.',
    ].join('\n'),
    footer: 'The panel supports up to 25 buttons, five per row',
  });
}

async function refreshPanel(ctx) {
  const settings = getTicketSettings(ctx.guildId);

  if (!settings.panelChannelId) return;

  const channel =
    ctx.guild.channels.cache.get(settings.panelChannelId) ??
    (await ctx.guild.channels.fetch(settings.panelChannelId).catch(() => null));

  if (channel?.isTextBased?.() !== false) {
    await publishPanel(ctx.guild, channel).catch(() => null);
  }
}

async function readButtonOptions(ctx, startIndex) {
  const patch = {};
  let key;
  let label;

  if (ctx.isSlash) {
    key = ctx.getString('key');
    label = ctx.getString('label');

    const emoji = ctx.getString('emoji');
    if (emoji !== undefined) patch.emoji = emoji;

    const style = ctx.getString('style');
    if (style !== undefined) patch.buttonStyle = parseButtonStyle(style);

    const buttonLabel = ctx.getString('button_label');
    if (buttonLabel !== undefined) {
      patch.buttonLabel = isClearValue(buttonLabel) ? null : buttonLabel;
    }

    const category = ctx.getChannel('category');
    if (category) {
      if (category.type !== ChannelType.GuildCategory) {
        throw new TicketError('Pick a Discord category for the ticket channel.');
      }

      patch.categoryId = category.id;
    }

    const support = ctx.getString('support_roles');
    if (support !== undefined) patch.supportRoleIds = await resolveRoleList(ctx.guild, support);

    const ping = ctx.getString('ping_roles');
    if (ping !== undefined) patch.pingRoleIds = await resolveRoleList(ctx.guild, ping);

    const log = ctx.getChannel('log_channel');
    if (log) {
      if (log.isTextBased?.() === false) throw new TicketError('Pick a text channel for the log.');
      patch.logChannelId = log.id;
    }

    const welcome = ctx.getString('welcome');
    if (welcome !== undefined) patch.welcomeMessage = isClearValue(welcome) ? '' : welcome;

    const nameTemplate = ctx.getString('name_template');
    if (nameTemplate !== undefined) {
      patch.nameTemplate = isClearValue(nameTemplate) ? '' : nameTemplate;
    }

    const maxOpen = ctx.getInteger('max_open');
    if (maxOpen !== undefined) patch.maxOpen = maxOpen;

    const closeAction = ctx.getString('close_action');
    if (closeAction !== undefined) patch.closeAction = closeAction;

    const color = ctx.getString('color');
    if (color !== undefined) patch.color = parseDesignColor(color);

    const position = ctx.getInteger('position');
    if (position !== undefined) patch.position = position;
  } else {
    const { flags, rest } = parseFlagTokens(ctx.args.slice(startIndex));
    key = flags.key ?? rest[0];
    label = flags.label;

    if (flags.emoji !== undefined) patch.emoji = isClearValue(flags.emoji) ? '' : flags.emoji;
    if (flags.style !== undefined || flags.button_style !== undefined) {
      patch.buttonStyle = parseButtonStyle(flags.style ?? flags.button_style);
    }
    if (flags.button !== undefined || flags.button_label !== undefined) {
      const value = flags.button ?? flags.button_label;
      patch.buttonLabel = isClearValue(value) ? null : value;
    }
    if (flags.category !== undefined) {
      const category = await resolveCategory(ctx.guild, flags.category);
      patch.categoryId = category?.id ?? null;
    }
    if (flags.support !== undefined || flags.support_roles !== undefined) {
      patch.supportRoleIds = await resolveRoleList(ctx.guild, flags.support ?? flags.support_roles);
    }
    if (flags.ping !== undefined || flags.ping_roles !== undefined) {
      patch.pingRoleIds = await resolveRoleList(ctx.guild, flags.ping ?? flags.ping_roles);
    }
    if (flags.log !== undefined || flags.log_channel !== undefined) {
      const channel = await resolveTextChannel(ctx.guild, flags.log ?? flags.log_channel);
      patch.logChannelId = channel?.id ?? null;
    }
    if (flags.welcome !== undefined) {
      patch.welcomeMessage = isClearValue(flags.welcome) ? '' : flags.welcome;
    }
    if (flags.name !== undefined || flags.name_template !== undefined) {
      const value = flags.name ?? flags.name_template;
      patch.nameTemplate = isClearValue(value) ? '' : value;
    }
    if (flags.max !== undefined || flags.max_open !== undefined) {
      const value = Number(flags.max ?? flags.max_open);

      if (!Number.isFinite(value) || value < 1) {
        throw new TicketError('max_open must be a number from 1 to 10.');
      }

      patch.maxOpen = value;
    }
    if (flags.close !== undefined || flags.close_action !== undefined) {
      const value = String(flags.close ?? flags.close_action).toLowerCase();

      if (!CLOSE_ACTIONS.includes(value)) {
        throw new TicketError(`close_action must be ${CLOSE_ACTIONS.join(' or ')}.`);
      }

      patch.closeAction = value;
    }
    if (flags.color !== undefined) patch.color = parseDesignColor(flags.color);

    if (flags.position !== undefined) {
      const value = Number(flags.position);

      if (!Number.isFinite(value)) {
        throw new TicketError('position must be a number from 0 to 99.');
      }

      patch.position = Math.max(0, Math.min(99, Math.trunc(value)));
    }
  }

  return { key, label, patch };
}

async function handleButtonAdd(ctx) {
  if (!(await requireAdmin(ctx))) return;

  try {
    const { key, label, patch } = await readButtonOptions(ctx, 2);
    const normalized = normalizeTypeKey(key);

    if (!normalized) {
      await ctx.fail({ embeds: [errorEmbed('No key given', 'Use `/ticket button add key:general label:Support category:#tickets`.')] });
      return;
    }

    if (getTicketType(ctx.guildId, normalized)) {
      await ctx.fail({
        embeds: [errorEmbed('That key already exists', `Edit it with \`/ticket button edit key:${normalized} ...\`.` )],
      });
      return;
    }

    if (!String(label ?? '').trim()) {
      await ctx.fail({ embeds: [errorEmbed('No label given', 'A button needs a label, for example `label:Support`.')] });
      return;
    }

    if (!patch.categoryId) {
      await ctx.fail({
        embeds: [errorEmbed('No category given', 'Choose where this button creates ticket channels with `category:#category`.')],
      });
      return;
    }

    const button = upsertTicketType(ctx.guildId, normalized, { ...patch, label });
    await refreshPanel(ctx);

    await ctx.reply(
      ephemeral({
        embeds: [
          successEmbed(
            `Button added · ${button.buttonLabel || button.label}`,
            [
              buttonLine(button),
              '',
              'Run `/ticket panel` to refresh the posted panel, or edit it with `/ticket button edit`.',
            ].join('\n'),
          ),
        ],
      }),
    );
  } catch (error) {
    await ctx.fail({
      embeds: [errorEmbed('Could not add the button', error instanceof TicketError ? error.message : error.message)],
    });
  }
}

async function handleButtonEdit(ctx) {
  if (!(await requireAdmin(ctx))) return;

  try {
    const { key, label, patch } = await readButtonOptions(ctx, 2);
    const normalized = normalizeTypeKey(key);
    const existing = normalized ? getTicketType(ctx.guildId, normalized) : null;

    if (!existing) {
      await ctx.fail({ embeds: [errorEmbed('Unknown button', `No button called \`${key || '?'}\`. Add it first with \`/ticket button add\`.`)] });
      return;
    }

    if (label !== undefined) patch.label = label;

    const button = upsertTicketType(ctx.guildId, normalized, patch);
    await refreshPanel(ctx);

    await ctx.reply(
      ephemeral({
        embeds: [successEmbed(`Button saved · ${button.buttonLabel || button.label}`, buttonLine(button))],
      }),
    );
  } catch (error) {
    await ctx.fail({
      embeds: [errorEmbed('Could not save the button', error instanceof TicketError ? error.message : error.message)],
    });
  }
}

async function handleButtonRemove(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const key = ctx.isSlash ? ctx.getString('key') : parseFlagTokens(ctx.args.slice(2)).flags.key ?? parseFlagTokens(ctx.args.slice(2)).rest[0];
  const confirmed = ctx.isSlash ? ctx.getBoolean('confirm') : parseFlagTokens(ctx.args.slice(2)).flags.confirm !== undefined || ctx.args.includes('confirm');
  const normalized = normalizeTypeKey(key);
  const button = normalized ? getTicketType(ctx.guildId, normalized) : null;

  if (!button) {
    await ctx.fail({ embeds: [errorEmbed('Unknown button', `No button called \`${key || '?'}\`.`)] });
    return;
  }

  if (!confirmed) {
    await ctx.fail({
      embeds: [
        warningEmbed(
          'Confirmation needed',
          `This deletes \`${button.key}\`. Run \`/ticket button remove key:${button.key} confirm:true\`.`,
        ),
      ],
    });
    return;
  }

  const open = openTicketsFor(ctx.guildId, null, button.key).length;

  if (open > 0) {
    await ctx.fail({
      embeds: [
        warningEmbed('Open tickets still exist', `Close the ${open} open ticket(s) of this button before deleting it.`),
      ],
    });
    return;
  }

  deleteTicketType(ctx.guildId, button.key);
  await refreshPanel(ctx);

  await ctx.reply({
    embeds: [successEmbed('Button deleted', `\`${button.key}\` was removed from the panel.`)],
  });
}

async function handleButtonList(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const buttons = listTicketTypes(ctx.guildId);
  const settings = getTicketSettings(ctx.guildId);

  await ctx.reply({
    embeds: [
      embed({
        title: 'Panel buttons',
        description: buttons.length
          ? [
              `**${buttons.length}** button(s). They appear in this order.`,
              `Panel: ${settings.panelMessageId ? channelLabel(ctx.guild, settings.panelChannelId) : 'not posted'}`,
            ].join('\n')
          : 'No buttons yet. Add one with `/ticket button add key:general label:Support category:#tickets`.',
        fields: buttons.map((button) => ({
          name: `${button.emoji ? `${button.emoji} ` : ''}${button.buttonLabel || button.label} · ${button.key}`,
          value: buttonLine(button),
        })),
        color: COLORS.primary,
      }),
    ],
  });
}

function readPanelDesign(ctx, startIndex) {
  const patch = {};

  if (ctx.isSlash) {
    const title = ctx.getString('title');
    if (title !== undefined) patch.title = isClearValue(title) ? null : title;

    const description = ctx.getString('description');
    if (description !== undefined) {
      patch.description = isClearValue(description) ? null : description;
    }

    const footer = ctx.getString('footer');
    if (footer !== undefined) patch.footer = isClearValue(footer) ? null : footer;

    const image = ctx.getString('image');
    if (image !== undefined) patch.image = isClearValue(image) ? null : image;

    const thumbnail = ctx.getString('thumbnail');
    if (thumbnail !== undefined) patch.thumbnail = isClearValue(thumbnail) ? null : thumbnail;

    const color = ctx.getString('color');
    if (color !== undefined) patch.color = parseDesignColor(color);
  } else {
    const { flags } = parseFlagTokens(ctx.args.slice(startIndex));

    for (const [key, field] of [
      ['title', 'title'],
      ['description', 'description'],
      ['footer', 'footer'],
      ['image', 'image'],
      ['thumbnail', 'thumbnail'],
    ]) {
      if (flags[key] !== undefined) {
        patch[field] = isClearValue(flags[key]) ? null : flags[key];
      }
    }

    if (flags.color !== undefined) patch.color = parseDesignColor(flags.color);
  }

  for (const field of ['image', 'thumbnail']) {
    if (patch[field] && !isHttpUrl(patch[field])) {
      throw new TicketError(`The ${field} must be an http(s) image URL.`);
    }
  }

  return patch;
}

async function handlePanel(ctx) {
  if (!(await requireAdmin(ctx))) return;

  try {
    const buttons = listTicketTypes(ctx.guildId);

    if (!buttons.length) {
      await ctx.fail({
        embeds: [
          warningEmbed(
            'No buttons yet',
            'Add at least one button first: `/ticket button add key:general label:Support category:#tickets`.',
          ),
        ],
      });
      return;
    }

    const settings = getTicketSettings(ctx.guildId);
    const patch = readPanelDesign(ctx, 1);
    let channel;

    if (ctx.isSlash) {
      channel = ctx.getChannel('channel');
    } else {
      const { rest } = parseFlagTokens(ctx.args.slice(1));

      if (rest[0]) channel = await resolveTextChannel(ctx.guild, rest[0]);
    }

    if (!channel && settings.panelChannelId) {
      channel =
        ctx.guild.channels.cache.get(settings.panelChannelId) ??
        (await ctx.guild.channels.fetch(settings.panelChannelId).catch(() => null));
    }

    if (!channel) channel = ctx.channel;

    if (!channel?.isTextBased?.()) {
      await ctx.fail({ embeds: [errorEmbed('No channel', 'Pick a text channel for the panel.')] });
      return;
    }

    const message = await publishPanel(ctx.guild, channel, patch);

    await ctx.reply(
      ephemeral({
        embeds: [
          successEmbed(
            'Panel posted',
            [
              `The panel is live in ${channel} ([jump](${message.url ?? '#'})).`,
              `It has **${buttons.length}** button(s) and uses your custom embed.`,
            ].join('\n'),
          ),
        ],
      }),
    );
  } catch (error) {
    await ctx.fail({
      embeds: [
        errorEmbed(
          'Could not post the panel',
          error instanceof TicketError
            ? error.message
            : `Check that I can **View Channel**, **Send Messages** and **Embed Links** in the channel. ${error.message}`,
        ),
      ],
    });
  }
}

async function handleList(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const buttons = listTicketTypes(ctx.guildId);
  const settings = getTicketSettings(ctx.guildId);
  const counts = ticketCounts(ctx.guildId);

  await ctx.reply({
    embeds: [
      embed({
        title: 'Ticket setup',
        description: [
          `Buttons: **${buttons.length}** · open: **${counts.open}** · archived: **${counts.closed}** · deleted: **${counts.deleted}**`,
          `Log channel: ${channelLabel(ctx.guild, settings.logChannelId)}`,
          `Panel: ${settings.panelMessageId ? channelLabel(ctx.guild, settings.panelChannelId) : 'not posted'}`,
          `Panel title: **${settings.panelTitle || 'Open a ticket'}** · color: ${settings.panelColor ? `#${settings.panelColor.toString(16).padStart(6, '0')}` : 'default'}`,
        ].join('\n'),
        fields: buttons.map((button) => ({
          name: `${button.emoji ? `${button.emoji} ` : ''}${button.buttonLabel || button.label} · ${button.key}`,
          value: buttonLine(button),
        })),
        footer: 'Edit the embed with /ticket panel and the buttons with /ticket button edit',
      }),
    ],
  });
}

async function handleLog(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const raw = ctx.isSlash ? ctx.getString('channel') : ctx.args[1];
  const settings = getTicketSettings(ctx.guildId);

  if (ctx.isSlash) {
    const channel = ctx.getChannel('channel');

    if (!channel) {
      await ctx.reply(
        ephemeral({
          embeds: [
            embed({
              title: 'Ticket log',
              description: `Current log channel: ${channelLabel(ctx.guild, settings.logChannelId)}`,
              color: COLORS.primary,
            }),
          ],
        }),
      );
      return;
    }

    if (channel.isTextBased?.() === false) {
      await ctx.fail({ embeds: [errorEmbed('Invalid channel', 'Pick a text channel.')] });
      return;
    }

    updateTicketSettings(ctx.guildId, { logChannelId: channel.id });
    await ctx.reply(
      ephemeral({
        embeds: [successEmbed('Ticket log set', `Transcripts and ticket events now go to ${channel}.`)],
      }),
    );
    return;
  }

  if (!raw) {
    await ctx.reply({
      embeds: [
        embed({
          title: 'Ticket log',
          description: `Current log channel: ${channelLabel(ctx.guild, settings.logChannelId)}`,
          color: COLORS.primary,
        }),
      ],
    });
    return;
  }

  try {
    const channel = await resolveTextChannel(ctx.guild, raw);
    updateTicketSettings(ctx.guildId, { logChannelId: channel?.id ?? null });
    await ctx.reply({
      embeds: [
        successEmbed(
          channel ? 'Ticket log set' : 'Ticket log cleared',
          channel
            ? `Transcripts and ticket events now go to ${channel}.`
            : 'Closed tickets will now be archived instead of deleted.',
        ),
      ],
    });
  } catch (error) {
    await ctx.fail({ embeds: [errorEmbed('Could not set the log channel', error.message)] });
  }
}

function ticketContext(ctx) {
  const ticket = getTicketByChannel(ctx.guildId, ctx.channelId);

  if (!ticket) throw new TicketError('This channel is not a ticket.');

  return { ticket, type: getTicketType(ctx.guildId, ticket.typeKey) };
}

async function handleClose(ctx) {
  let context;

  try {
    context = ticketContext(ctx);
  } catch (error) {
    await ctx.fail({ embeds: [errorEmbed('Not a ticket', error.message)] });
    return;
  }

  const { ticket, type } = context;

  if (ticket.openerId !== ctx.user.id && !isStaffMember(ctx.guild, ctx.member, type)) {
    await ctx.fail({
      embeds: [errorEmbed('Missing permissions', 'Only the opener or the support team can close this ticket.')],
    });
    return;
  }

  const reason = ctx.isSlash ? ctx.getString('reason') ?? '' : ctx.args.slice(1).join(' ');
  if (ctx.isSlash) await ctx.defer({ ephemeral: true });

  try {
    const result = await closeTicketChannel({
      guild: ctx.guild,
      channel: ctx.channel,
      ticket,
      type,
      actor: ctx.user,
      reason,
    });

    const message =
      result.mode === 'delete'
        ? `Ticket #${String(ticket.number).padStart(4, '0')} closed and deleted. The transcript was saved.`
        : result.logged
          ? `Ticket #${String(ticket.number).padStart(4, '0')} closed and archived. The transcript was saved.`
          : 'Ticket closed and archived. No log channel is set, so no transcript was stored.';

    await ctx.editReply({ embeds: [successEmbed('Ticket closed', message)] }).catch(() => null);
  } catch (error) {
    await ctx
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

async function handleClaim(ctx) {
  let context;

  try {
    context = ticketContext(ctx);
  } catch (error) {
    await ctx.fail({ embeds: [errorEmbed('Not a ticket', error.message)] });
    return;
  }

  const { ticket, type } = context;

  if (!isStaffMember(ctx.guild, ctx.member, type)) {
    await ctx.fail({ embeds: [errorEmbed('Missing permissions', 'Only the support team can claim tickets.')] });
    return;
  }

  if (ctx.isSlash) await ctx.defer({ ephemeral: true });

  if (ticket.claimedBy === ctx.user.id) {
    claimTicket(ticket.id, null);
    await ctx.channel
      .send({
        embeds: [embed({ title: 'Ticket unclaimed', description: 'Anyone on the team can pick it up again.', color: COLORS.muted })],
        allowedMentions: { parse: [] },
      })
      .catch(() => null);
    await ctx.editReply({ content: 'This ticket is unclaimed again.' }).catch(() => null);
    return;
  }

  if (ticket.claimedBy) {
    await ctx
      .editReply({
        embeds: [errorEmbed('Already claimed', `This ticket is claimed by <@${ticket.claimedBy}>.`)],
      })
      .catch(() => null);
    return;
  }

  claimTicket(ticket.id, ctx.user.id);
  await ctx.channel
    .send({
      embeds: [
        embed({
          title: 'Ticket claimed',
          description: `This ticket is now handled by <@${ctx.user.id}>.`,
          color: COLORS.success,
        }),
      ],
      allowedMentions: { parse: [] },
    })
    .catch(() => null);
  await ctx.editReply({ content: 'You claimed this ticket.' }).catch(() => null);
}

async function ticketMember(ctx) {
  const token = ctx.isSlash ? null : ctx.args[1];
  const member = ctx.isSlash
    ? ctx.getMember('user') ?? (ctx.getUser('user') ? await ctx.guild.members.fetch(ctx.getUser('user').id).catch(() => null) : null)
    : await resolveMember(ctx.guild, token, ctx.message).catch(() => null);

  if (!member) throw new TicketError('Member not found.');
  if (member.user?.bot) throw new TicketError('That member is a bot.');

  return member;
}

async function handleAddRemove(ctx, add) {
  let context;

  try {
    context = ticketContext(ctx);
  } catch (error) {
    await ctx.fail({ embeds: [errorEmbed('Not a ticket', error.message)] });
    return;
  }

  if (!isStaffMember(ctx.guild, ctx.member, context.type)) {
    await ctx.fail({ embeds: [errorEmbed('Missing permissions', 'Only the support team can change ticket access.')] });
    return;
  }

  let member;

  try {
    member = await ticketMember(ctx);
  } catch (error) {
    await ctx.fail({ embeds: [errorEmbed('Member not found', error.message)] });
    return;
  }

  if (!add && member.id === context.ticket.openerId) {
    await ctx.fail({ embeds: [errorEmbed('Cannot remove the opener', 'The ticket opener always keeps access.')] });
    return;
  }

  try {
    await ctx.channel.permissionOverwrites.edit(
      member.id,
      add
        ? {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true,
            AttachFiles: true,
            EmbedLinks: true,
          }
        : { ViewChannel: false, SendMessages: false },
      { reason: `${add ? 'Added to' : 'Removed from'} ticket by ${ctx.user.tag ?? ctx.user.id}` },
    );

    await ctx.reply({
      embeds: [
        successEmbed(
          add ? 'Member added' : 'Member removed',
          `${member} ${add ? 'can now see and write in this ticket.' : 'can no longer see this ticket.'}`,
        ),
      ],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await ctx.fail({ embeds: [errorEmbed('Could not update access', error.message)] });
  }
}

async function handleRename(ctx) {
  let context;

  try {
    context = ticketContext(ctx);
  } catch (error) {
    await ctx.fail({ embeds: [errorEmbed('Not a ticket', error.message)] });
    return;
  }

  if (!isStaffMember(ctx.guild, ctx.member, context.type)) {
    await ctx.fail({ embeds: [errorEmbed('Missing permissions', 'Only the support team can rename tickets.')] });
    return;
  }

  const raw = ctx.isSlash ? ctx.getString('name') : ctx.args.slice(1).join(' ');
  const name = sanitizeChannelName(raw);

  if (!raw || name === 'ticket') {
    await ctx.fail({ embeds: [errorEmbed('No name given', 'Use letters, numbers, `-` or `_`.')] });
    return;
  }

  try {
    await ctx.channel.setName(name, `Ticket renamed by ${ctx.user.tag ?? ctx.user.id}`);
    await ctx.reply({ embeds: [successEmbed('Ticket renamed', `This ticket is now \`${name}\`.`)] });
  } catch (error) {
    await ctx.fail({ embeds: [errorEmbed('Could not rename the ticket', error.message)] });
  }
}

async function handleTranscript(ctx) {
  let context;

  try {
    context = ticketContext(ctx);
  } catch (error) {
    await ctx.fail({ embeds: [errorEmbed('Not a ticket', error.message)] });
    return;
  }

  const { ticket, type } = context;

  if (ticket.openerId !== ctx.user.id && !isStaffMember(ctx.guild, ctx.member, type)) {
    await ctx.fail({
      embeds: [errorEmbed('Missing permissions', 'Only the opener or the support team can export a transcript.')],
    });
    return;
  }

  if (ctx.isSlash) await ctx.defer({ ephemeral: true });

  try {
    const { transcript, log } = await saveTicketTranscript({
      guild: ctx.guild,
      channel: ctx.channel,
      ticket,
      type,
      title: 'Ticket transcript',
      color: COLORS.primary,
    });

    if (log) {
      await ctx
        .editReply({
          embeds: [successEmbed('Transcript saved', `It was sent to ${channelLabel(ctx.guild, log.channelId)} with ${transcript.messages} message(s).`)],
        })
        .catch(() => null);
      return;
    }

    const payload = {
      content: 'No log channel is set, so here is the transcript directly.',
      files: [new AttachmentBuilder(Buffer.from(transcript.html, 'utf8'), { name: transcript.filename })],
    };

    if (ctx.isSlash) await ctx.editReply(payload).catch(() => null);
    else await ctx.reply(payload).catch(() => null);
  } catch (error) {
    await ctx
      .editReply({
        embeds: [
          errorEmbed(
            'Could not create the transcript',
            error instanceof TicketError ? error.message : 'Something went wrong.',
          ),
        ],
      })
      .catch(() => null);
  }
}

function addButtonOptions(sub, { requireLabel = false } = {}) {
  return sub
    .addStringOption((option) =>
      option.setName('key').setDescription('Short id used in the button, for example general').setRequired(true).setAutocomplete(true),
    )
    .addStringOption((option) =>
      option.setName('label').setDescription('Name shown in the embed and ticket').setRequired(requireLabel),
    )
    .addChannelOption((option) =>
      option
        .setName('category')
        .setDescription('Category where this button creates ticket channels')
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(requireLabel),
    )
    .addStringOption((option) =>
      option.setName('emoji').setDescription('Button emoji, for example 🎫').setRequired(false),
    )
    .addStringOption((option) =>
      option.setName('button_label').setDescription('Text on the button if it differs from the label').setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('style')
        .setDescription('Button color')
        .addChoices(
          { name: 'Blue (primary)', value: 'primary' },
          { name: 'Gray (secondary)', value: 'secondary' },
          { name: 'Green (success)', value: 'success' },
          { name: 'Red (danger)', value: 'danger' },
        )
        .setRequired(false),
    )
    .addStringOption((option) =>
      option.setName('support_roles').setDescription('Roles that can see and manage this ticket (comma-separated)').setRequired(false),
    )
    .addStringOption((option) =>
      option.setName('ping_roles').setDescription('Roles pinged when this ticket opens (comma-separated)').setRequired(false),
    )
    .addChannelOption((option) =>
      option
        .setName('log_channel')
        .setDescription('Transcript and event log for this button')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false),
    )
    .addStringOption((option) =>
      option.setName('welcome').setDescription('Welcome text; supports {mention}, {user}, {server}, {type}, {number}').setRequired(false),
    )
    .addStringOption((option) =>
      option.setName('name_template').setDescription('Channel name; supports {number}, {user}, {type}').setRequired(false),
    )
    .addIntegerOption((option) =>
      option.setName('max_open').setDescription('Open tickets per member (1–10, default 1)').setMinValue(1).setMaxValue(10).setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('close_action')
        .setDescription('Delete the channel after closing, or archive it')
        .addChoices(
          { name: 'Delete channel', value: 'delete' },
          { name: 'Archive channel', value: 'archive' },
        )
        .setRequired(false),
    )
    .addStringOption((option) =>
      option.setName('color').setDescription('Embed color for this ticket, for example #5865f2 or red').setRequired(false),
    )
    .addIntegerOption((option) =>
      option.setName('position').setDescription('Order on the panel (lower first)').setMinValue(0).setMaxValue(99).setRequired(false),
    );
}

export default {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('A fully customizable ticket panel with private channels and transcripts')
    .setContexts(InteractionContextType.Guild)
    .addSubcommandGroup((group) =>
      group
        .setName('button')
        .setDescription('Admin: add, edit or remove panel buttons')
        .addSubcommand((sub) =>
          addButtonOptions(
            sub.setName('add').setDescription('Admin: add a customizable button to the panel'),
            { requireLabel: true },
          ),
        )
        .addSubcommand((sub) =>
          addButtonOptions(sub.setName('edit').setDescription('Admin: change one button')),
        )
        .addSubcommand((sub) =>
          sub
            .setName('remove')
            .setDescription('Admin: delete a button from the panel')
            .addStringOption((option) =>
              option.setName('key').setDescription('Button key').setRequired(true).setAutocomplete(true),
            )
            .addBooleanOption((option) =>
              option.setName('confirm').setDescription('Set true to confirm deletion').setRequired(true),
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('panel')
        .setDescription('Admin: edit the embed and post or refresh the panel')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Where to post it (default: saved panel channel or this channel)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(false),
        )
        .addStringOption((option) => option.setName('title').setDescription('Embed title').setRequired(false))
        .addStringOption((option) =>
          option.setName('description').setDescription('Embed description').setRequired(false),
        )
        .addStringOption((option) =>
          option.setName('color').setDescription('Embed color, for example #5865f2 or red').setRequired(false),
        )
        .addStringOption((option) => option.setName('footer').setDescription('Embed footer').setRequired(false))
        .addStringOption((option) =>
          option.setName('image').setDescription('Large image URL (http/https)').setRequired(false),
        )
        .addStringOption((option) =>
          option.setName('thumbnail').setDescription('Thumbnail URL (http/https)').setRequired(false),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Admin: show the panel and every button'))
    .addSubcommand((sub) => sub.setName('buttons').setDescription('Admin: list every panel button'))
    .addSubcommand((sub) =>
      sub
        .setName('log')
        .setDescription('Admin: set the transcript and event log channel')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Log channel (empty shows the current one)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('close')
        .setDescription('Close the ticket in this channel')
        .addStringOption((option) => option.setName('reason').setDescription('Optional close reason').setRequired(false)),
    )
    .addSubcommand((sub) => sub.setName('claim').setDescription('Claim or unclaim this ticket (support team)'))
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add a member to this ticket (support team)')
        .addUserOption((option) => option.setName('user').setDescription('Member to add').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove a member from this ticket (support team)')
        .addUserOption((option) => option.setName('user').setDescription('Member to remove').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('rename')
        .setDescription('Rename this ticket (support team)')
        .addStringOption((option) => option.setName('name').setDescription('New channel name').setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName('transcript').setDescription('Save an HTML transcript of this ticket')),

  name: 'ticket',
  aliases: ['tickets', 'ticket-tool', 'support'],
  description: 'A fully customizable ticket panel with private channels and transcripts',
  category: 'Community',
  usage: 'ticket [button|panel|list|buttons|log|close|claim|add|remove|rename|transcript]',
  cooldown: 3,
  guildOnly: true,

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);

    if (!['key'].includes(focused.name)) {
      await interaction.respond([]);
      return;
    }

    const query = String(focused.value ?? '').toLowerCase();
    const buttons = listTicketTypes(interaction.guildId)
      .filter(
        (button) =>
          !query || button.key.includes(query) || button.label.toLowerCase().includes(query),
      )
      .slice(0, 25)
      .map((button) => ({
        name: `${button.buttonLabel || button.label} (${button.key})`,
        value: button.key,
      }));

    await interaction.respond(buttons);
  },

  async execute(ctx) {
    if (ctx.isSlash) {
      const group = ctx.getSubcommandGroup(false);

      if (group === 'button') {
        const action = ctx.getSubcommand(false);

        if (action === 'add') return handleButtonAdd(ctx);
        if (action === 'edit') return handleButtonEdit(ctx);
        if (action === 'remove') return handleButtonRemove(ctx);

        return ctx.reply({ embeds: [overviewEmbed()] });
      }

      const subcommand = ctx.getSubcommand(false) ?? '';

      switch (subcommand) {
        case 'panel':
          return handlePanel(ctx);
        case 'list':
          return handleList(ctx);
        case 'buttons':
          return handleButtonList(ctx);
        case 'log':
          return handleLog(ctx);
        case 'close':
          return handleClose(ctx);
        case 'claim':
          return handleClaim(ctx);
        case 'add':
          return handleAddRemove(ctx, true);
        case 'remove':
          return handleAddRemove(ctx, false);
        case 'rename':
          return handleRename(ctx);
        case 'transcript':
          return handleTranscript(ctx);
        default:
          return ctx.reply({ embeds: [overviewEmbed()] });
      }
    }

    const subcommand = (ctx.args[0] ?? '').toLowerCase();

    if (subcommand === 'button') {
      const action = (ctx.args[1] ?? '').toLowerCase();

      if (action === 'add') return handleButtonAdd(ctx);
      if (action === 'edit' || action === 'set') return handleButtonEdit(ctx);
      if (action === 'remove' || action === 'delete') return handleButtonRemove(ctx);
      if (action === 'list') return handleButtonList(ctx);

      return ctx.reply({ embeds: [overviewEmbed()] });
    }

    switch (subcommand) {
      case 'panel':
        return handlePanel(ctx);
      case 'list':
      case 'status':
        return handleList(ctx);
      case 'buttons':
        return handleButtonList(ctx);
      case 'log':
        return handleLog(ctx);
      case 'close':
        return handleClose(ctx);
      case 'claim':
        return handleClaim(ctx);
      case 'add':
        return handleAddRemove(ctx, true);
      case 'remove':
        return handleAddRemove(ctx, false);
      case 'rename':
        return handleRename(ctx);
      case 'transcript':
        return handleTranscript(ctx);
      default:
        return ctx.reply({ embeds: [overviewEmbed()] });
    }
  },
};
