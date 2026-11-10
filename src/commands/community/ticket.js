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
  CLOSE_ACTIONS,
  TICKET_KINDS,
  claimTicket,
  deleteTicketType,
  ensureDefaultTicketTypes,
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
  publishComplaintPanel,
  publishTypePanel,
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

function typeLine(type) {
  const category = type.categoryId ? `<#${type.categoryId}>` : '⚠️ not set';
  const panel = type.panelMessageId && type.panelChannelId ? `<#${type.panelChannelId}>` : 'not posted';

  return [
    `**${type.label}** · \`${type.key}\` · ${type.kind}`,
    `Category: ${category} · Support: ${roleList(type.supportRoleIds)} · Ping: ${roleList(type.pingRoleIds)}`,
    `Panel: ${panel} · Max open: ${type.maxOpen} · Close: ${type.closeAction}`,
  ].join('\n');
}

function overviewEmbed() {
  return embed({
    title: 'Tickets',
    description: [
      'A Ticket Tool-style system: private channels, panels, claiming, closing and HTML transcripts.',
      '',
      '**Member commands**',
      '`/ticket close [reason]` — close the ticket you are in',
      '`/ticket claim` — claim or unclaim a ticket (support team)',
      '`/ticket transcript` — save the transcript (opener or support team)',
      '',
      '**Admin setup**',
      '`/ticket setup type:<key> category:#category support_roles:@role ping_roles:@role`',
      '`/ticket log [#channel]` — where transcripts and ticket events are sent',
      '`/ticket panel [type] [#channel]` — post one type panel',
      '`/ticket complaint [#channel]` — post the separate administration complaint panel',
      '`/ticket list` — show every type and its configuration',
      '`/ticket reset type:<key> confirm:true` — delete a type',
      '',
      `Types: ${listTicketTypesPlaceholder()}`,
    ].join('\n'),
    footer: 'Buttons open a private channel in the category configured for that type',
  });
}

function listTicketTypesPlaceholder() {
  return '`general`, `complaint-submod`, `complaint-mod`, `complaint-owner` (created automatically)';
}

async function handleSetup(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const rawType = ctx.isSlash ? ctx.getString('type') : ctx.args[1];
  const key = normalizeTypeKey(rawType);

  if (!key) {
    await ctx.fail({
      embeds: [errorEmbed('No type given', 'Use `/ticket setup type:general category:#tickets`.')],
    });
    return;
  }

  const patch = {};

  if (ctx.isSlash) {
    const stringFields = {
      label: 'label',
      description: 'description',
      support_roles: 'support_roles',
      ping_roles: 'ping_roles',
      welcome: 'welcome_message',
      name_template: 'name_template',
      emoji: 'emoji',
    };

    for (const [option, field] of Object.entries(stringFields)) {
      const value = ctx.getString(option);
      if (value === undefined) continue;

      if (field === 'support_roles' || field === 'ping_roles') {
        patch[field === 'support_roles' ? 'supportRoleIds' : 'pingRoleIds'] =
          await resolveRoleList(ctx.guild, value);
      } else {
        patch[field] = value;
      }
    }

    const category = ctx.getChannel('category');
    if (category) {
      if (category.type !== ChannelType.GuildCategory) {
        await ctx.fail({ embeds: [errorEmbed('Invalid category', 'Pick a Discord category.')] });
        return;
      }

      patch.categoryId = category.id;
    }

    const log = ctx.getChannel('log_channel');
    if (log) {
      if (log.isTextBased?.() === false) {
        await ctx.fail({ embeds: [errorEmbed('Invalid log channel', 'Pick a text channel.')] });
        return;
      }

      patch.logChannelId = log.id;
    }

    const panel = ctx.getChannel('panel_channel');
    if (panel) {
      if (panel.isTextBased?.() === false) {
        await ctx.fail({ embeds: [errorEmbed('Invalid panel channel', 'Pick a text channel.')] });
        return;
      }

      patch.panelChannelId = panel.id;
    }

    const maxOpen = ctx.getInteger('max_open');
    if (maxOpen !== undefined) patch.maxOpen = maxOpen;

    const kind = ctx.getString('kind');
    if (kind !== undefined) patch.kind = kind;

    const closeAction = ctx.getString('close_action');
    if (closeAction !== undefined) patch.closeAction = closeAction;

    const color = ctx.getString('color');
    if (color !== undefined) {
      if (!color || isClearValue(color)) {
        patch.color = null;
      } else {
        const parsed = parseColor(color);

        if (!parsed) {
          await ctx.fail({
            embeds: [errorEmbed('Invalid color', `\`${color}\` is not a color. Try \`#5865f2\` or \`red\`.`)],
          });
          return;
        }

        patch.color = parsed.value;
      }
    }
  } else {
    for (const token of ctx.args.slice(2)) {
      const separator = token.indexOf('=');

      if (separator <= 0) {
        await ctx.fail({
          embeds: [
            errorEmbed(
              'Invalid setup argument',
              `\`${token}\` must be \`key=value\`, for example \`category=#tickets\` or \`ping=@Mods\`.`,
            ),
          ],
        });
        return;
      }

      const rawKey = token.slice(0, separator).trim().toLowerCase();
      const value = token.slice(separator + 1);
      const name = {
        support: 'support_roles',
        ping: 'ping_roles',
        log: 'log_channel',
        panel: 'panel_channel',
        name: 'name_template',
        max: 'max_open',
        close: 'close_action',
      }[rawKey] ?? rawKey;

      if (name === 'category') {
        const category = await resolveCategory(ctx.guild, value);
        patch.categoryId = category?.id ?? null;
      } else if (name === 'support_roles' || name === 'ping_roles') {
        patch[name === 'support_roles' ? 'supportRoleIds' : 'pingRoleIds'] = await resolveRoleList(
          ctx.guild,
          value,
        );
      } else if (name === 'log_channel' || name === 'panel_channel') {
        const channel = await resolveTextChannel(ctx.guild, value);
        patch[name === 'log_channel' ? 'logChannelId' : 'panelChannelId'] = channel?.id ?? null;
      } else if (name === 'max_open') {
        const number = Number(value);

        if (!Number.isFinite(number) || number < 1) {
          await ctx.fail({ embeds: [errorEmbed('Invalid max_open', 'Use a number from 1 to 10.')] });
          return;
        }

        patch.maxOpen = number;
      } else if (name === 'color') {
        if (!value || isClearValue(value)) {
          patch.color = null;
        } else {
          const parsed = parseColor(value);

          if (!parsed) {
            await ctx.fail({ embeds: [errorEmbed('Invalid color', `\`${value}\` is not a color.`)] });
            return;
          }

          patch.color = parsed.value;
        }
      } else if (name === 'kind') {
        if (!TICKET_KINDS.includes(value.toLowerCase())) {
          await ctx.fail({
            embeds: [errorEmbed('Invalid kind', `Use \`${TICKET_KINDS.join('` or `')}\`.`)],
          });
          return;
        }

        patch.kind = value.toLowerCase();
      } else if (name === 'close_action') {
        if (!CLOSE_ACTIONS.includes(value.toLowerCase())) {
          await ctx.fail({
            embeds: [errorEmbed('Invalid close action', `Use \`${CLOSE_ACTIONS.join('` or `')}\`.`)],
          });
          return;
        }

        patch.closeAction = value.toLowerCase();
      } else if (['label', 'description', 'welcome_message', 'name_template', 'emoji'].includes(name)) {
        patch[name] = value;
      } else {
        await ctx.fail({ embeds: [errorEmbed('Unknown setup key', `\`${rawKey}\` is not a setup key.`)] });
        return;
      }
    }
  }

  let type;

  try {
    type = upsertTicketType(ctx.guildId, key, patch);
  } catch (error) {
    await ctx.fail({ embeds: [errorEmbed('Could not save the type', error.message)] });
    return;
  }

  await ctx.reply(
    ephemeral({
      embeds: [
        successEmbed(
          `Ticket type saved · ${type.label}`,
          [
            typeLine(type),
            '',
            type.categoryId
              ? `Post it with \`/ticket panel type:${type.key} channel:#channel\`.`
              : 'Set a category before posting the panel: the button cannot create a channel without one.',
          ].join('\n'),
        ),
      ],
    }),
  );
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

async function panelTarget(ctx, channelOption, type) {
  if (ctx.isSlash) {
    const channel = ctx.getChannel(channelOption);
    if (channel) return channel;
  }

  if (type?.panelChannelId) {
    return (
      ctx.guild.channels.cache.get(type.panelChannelId) ??
      (await ctx.guild.channels.fetch(type.panelChannelId).catch(() => null))
    );
  }

  return ctx.channel;
}

async function handlePanel(ctx) {
  if (!(await requireAdmin(ctx))) return;

  ensureDefaultTicketTypes(ctx.guildId);

  let rawType = ctx.isSlash ? ctx.getString('type') : ctx.args[1];
  let rawChannel = null;

  if (!ctx.isSlash && rawType) {
    const maybeChannel = await resolveChannel(ctx.guild, rawType);

    if (maybeChannel) {
      rawChannel = rawType;
      rawType = null;
    } else if (ctx.args[2]) {
      rawChannel = ctx.args[2];
    }
  }

  const key = normalizeTypeKey(rawType || 'general');
  const type = getTicketType(ctx.guildId, key);

  if (!type) {
    await ctx.fail({
      embeds: [
        errorEmbed(
          'Unknown ticket type',
          `No type called \`${key}\`. Create it with \`/ticket setup type:${key} category:#category\`.`,
        ),
      ],
    });
    return;
  }

  const channel = rawChannel
    ? await resolveTextChannel(ctx.guild, rawChannel)
    : await panelTarget(ctx, 'channel', type);

  if (!channel) {
    await ctx.fail({ embeds: [errorEmbed('No channel', 'Pick a channel for the panel.')] });
    return;
  }

  try {
    const message = await publishTypePanel(ctx.guild, type, channel);

    await ctx.reply(
      ephemeral({
        embeds: [
          successEmbed(
            'Panel posted',
            [
              `**${type.label}** is live in ${channel} ([jump](${message.url ?? '#'})).`,
              type.categoryId
                ? `Its button opens a private ticket in <#${type.categoryId}>.`
                : '⚠️ No category is set, so the button will explain the missing setup instead of opening a ticket.',
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
          `Check that I can **View Channel**, **Send Messages** and **Embed Links** in ${channel}.`,
        ),
      ],
    });
  }
}

async function handleComplaint(ctx) {
  if (!(await requireAdmin(ctx))) return;

  ensureDefaultTicketTypes(ctx.guildId);

  const settings = getTicketSettings(ctx.guildId);
  let channel = null;
  let title;
  let description;

  if (ctx.isSlash) {
    channel = ctx.getChannel('channel');
    title = ctx.getString('title');
    description = ctx.getString('description');
  } else {
    for (const token of ctx.args.slice(1)) {
      const separator = token.indexOf('=');

      if (separator > 0) {
        const key = token.slice(0, separator).toLowerCase();
        const value = token.slice(separator + 1);

        if (key === 'title') title = value;
        else if (key === 'description') description = value;
        else {
          await ctx.fail({ embeds: [errorEmbed('Unknown complaint option', `\`${key}\` is not an option.`)] });
          return;
        }
      } else if (!channel) {
        channel = await resolveTextChannel(ctx.guild, token);
      }
    }
  }

  if (!channel) {
    channel = settings.complaintChannelId
      ? ctx.guild.channels.cache.get(settings.complaintChannelId) ??
        (await ctx.guild.channels.fetch(settings.complaintChannelId).catch(() => null))
      : ctx.channel;
  }

  if (!channel) {
    await ctx.fail({ embeds: [errorEmbed('No channel', 'Pick a channel for the complaint panel.')] });
    return;
  }

  try {
    const message = await publishComplaintPanel(ctx.guild, channel, { title, description });
    const unconfigured = listTicketTypes(ctx.guildId).filter(
      (type) => type.kind === 'complaint' && !type.categoryId,
    );

    await ctx.reply(
      ephemeral({
        embeds: [
          successEmbed(
            'Complaint panel posted',
            [
              `**Complaint Against Administration** is live in ${channel} ([jump](${message.url ?? '#'})).`,
              'The three buttons are separate ticket types, each with its own category and ping roles.',
              unconfigured.length
                ? `⚠️ Still missing a category: ${unconfigured.map((type) => `\`${type.key}\``).join(', ')}. Set them with \`/ticket setup\`.`
                : 'All complaint types have a category.',
            ].join('\n'),
          ),
        ],
      }),
    );
  } catch (error) {
    await ctx.fail({
      embeds: [
        errorEmbed(
          'Could not post the complaint panel',
          `Check that I can **View Channel**, **Send Messages** and **Embed Links** in ${channel}.`,
        ),
      ],
    });
  }
}

async function handleList(ctx) {
  if (!(await requireAdmin(ctx))) return;

  ensureDefaultTicketTypes(ctx.guildId);

  const types = listTicketTypes(ctx.guildId);
  const settings = getTicketSettings(ctx.guildId);
  const counts = ticketCounts(ctx.guildId);
  const fields = types.map((type) => ({
    name: `${type.label} · ${type.key}`,
    value: typeLine(type),
  }));

  await ctx.reply({
    embeds: [
      embed({
        title: 'Ticket setup',
        description: [
          `Types: **${types.length}** · open: **${counts.open}** · archived: **${counts.closed}** · deleted: **${counts.deleted}**`,
          `Log channel: ${channelLabel(ctx.guild, settings.logChannelId)}`,
          `Complaint panel: ${settings.complaintMessageId ? channelLabel(ctx.guild, settings.complaintChannelId) : 'not posted'}`,
        ].join('\n'),
        fields,
        footer: 'Buttons use one type each; the complaint panel is separate from the standard panel',
      }),
    ],
  });
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

async function handleReset(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const rawType = ctx.isSlash ? ctx.getString('type') : ctx.args[1];
  const key = normalizeTypeKey(rawType);
  const confirmed = ctx.isSlash ? ctx.getBoolean('confirm') : ctx.args.includes('confirm');
  const type = key ? getTicketType(ctx.guildId, key) : null;

  if (!type) {
    await ctx.fail({ embeds: [errorEmbed('Unknown ticket type', `No type called \`${key || '?'}\`.`)] });
    return;
  }

  if (!confirmed) {
    await ctx.fail({
      embeds: [
        warningEmbed(
          'Confirmation needed',
          `This deletes \`${type.key}\` and its panel. Run \`/ticket reset type:${type.key} confirm:true\`.`,
        ),
      ],
    });
    return;
  }

  const open = openTicketsFor(ctx.guildId, null, type.key).length;

  if (open > 0) {
    await ctx.fail({
      embeds: [
        warningEmbed(
          'Open tickets still exist',
          `Close the ${open} open ticket(s) of this type before deleting it.`,
        ),
      ],
    });
    return;
  }

  if (type.panelMessageId && type.panelChannelId) {
    const channel =
      ctx.guild.channels.cache.get(type.panelChannelId) ??
      (await ctx.guild.channels.fetch(type.panelChannelId).catch(() => null));
    const message = await channel?.messages?.fetch(type.panelMessageId).catch(() => null);
    if (message) await message.delete().catch(() => null);
  }

  deleteTicketType(ctx.guildId, type.key);

  await ctx.reply({
    embeds: [successEmbed('Ticket type deleted', `\`${type.key}\` and its panel were removed.`)],
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Ticket Tool-style panels, private ticket channels and transcripts')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('setup')
        .setDescription('Admin: create or edit a ticket type')
        .addStringOption((option) =>
          option.setName('type').setDescription('Type key, for example general or complaint-mod').setRequired(true).setAutocomplete(true),
        )
        .addChannelOption((option) =>
          option
            .setName('category')
            .setDescription('Category where this type creates channels')
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(false),
        )
        .addStringOption((option) =>
          option.setName('label').setDescription('Button and panel title').setRequired(false),
        )
        .addStringOption((option) =>
          option.setName('description').setDescription('Panel description').setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName('support_roles')
            .setDescription('Roles that can see and manage this type (comma-separated)')
            .setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName('ping_roles')
            .setDescription('Roles pinged when this type opens (comma-separated)')
            .setRequired(false),
        )
        .addChannelOption((option) =>
          option
            .setName('log_channel')
            .setDescription('Transcript and event log for this type')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(false),
        )
        .addChannelOption((option) =>
          option
            .setName('panel_channel')
            .setDescription('Default channel for this type panel')
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
          option.setName('emoji').setDescription('Button emoji, for example 🎫').setRequired(false),
        )
        .addStringOption((option) =>
          option.setName('color').setDescription('Panel color, for example #5865f2 or red').setRequired(false),
        )
        .addStringOption((option) =>
          option
            .setName('kind')
            .setDescription('standard or complaint')
            .addChoices(
              { name: 'Standard', value: 'standard' },
              { name: 'Complaint', value: 'complaint' },
            )
            .setRequired(false),
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
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('panel')
        .setDescription('Admin: post a type panel')
        .addStringOption((option) =>
          option.setName('type').setDescription('Type key (default general)').setRequired(false).setAutocomplete(true),
        )
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Where to post it (default: saved panel channel or this channel)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('complaint')
        .setDescription('Admin: post the separate Complaint Against Administration panel')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Where to post it (default: saved channel or this channel)')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(false),
        )
        .addStringOption((option) => option.setName('title').setDescription('Panel title').setRequired(false))
        .addStringOption((option) =>
          option.setName('description').setDescription('Panel description').setRequired(false),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Admin: show every ticket type and its setup'))
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
    .addSubcommand((sub) => sub.setName('transcript').setDescription('Save an HTML transcript of this ticket'))
    .addSubcommand((sub) =>
      sub
        .setName('reset')
        .setDescription('Admin: delete a ticket type and its panel')
        .addStringOption((option) =>
          option.setName('type').setDescription('Type key').setRequired(true).setAutocomplete(true),
        )
        .addBooleanOption((option) =>
          option.setName('confirm').setDescription('Set true to confirm deletion').setRequired(true),
        ),
    ),

  name: 'ticket',
  aliases: ['tickets', 'ticket-tool', 'support'],
  description: 'Ticket Tool-style panels, private ticket channels and transcripts',
  category: 'Community',
  usage: 'ticket [setup|panel|complaint|list|log|close|claim|add|remove|rename|transcript|reset]',
  cooldown: 3,
  guildOnly: true,

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);

    if (!['type'].includes(focused.name)) {
      await interaction.respond([]);
      return;
    }

    ensureDefaultTicketTypes(interaction.guildId);

    const query = String(focused.value ?? '').toLowerCase();
    const types = listTicketTypes(interaction.guildId)
      .filter((type) => !query || type.key.includes(query) || type.label.toLowerCase().includes(query))
      .slice(0, 25)
      .map((type) => ({ name: `${type.label} (${type.key})`, value: type.key }));

    await interaction.respond(types);
  },

  async execute(ctx) {
    const subcommand = ctx.isSlash ? (ctx.getSubcommand() ?? '') : (ctx.args[0] ?? '').toLowerCase();

    switch (subcommand) {
      case 'setup':
        return handleSetup(ctx);
      case 'panel':
        return handlePanel(ctx);
      case 'complaint':
      case 'complaints':
      case 'administration':
        return handleComplaint(ctx);
      case 'list':
      case 'status':
        return handleList(ctx);
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
      case 'reset':
        return handleReset(ctx);
      default:
        return ctx.reply({ embeds: [overviewEmbed()] });
    }
  },
};
