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
  DEFAULT_PANEL_KEY,
  MAX_NUMBER_START,
  MAX_PANELS,
  claimTicket,
  countPanelButtons,
  deleteTicketPanel,
  deleteTicketType,
  ensureTicketPanel,
  getTicketByChannel,
  getTicketPanel,
  getTicketSettings,
  getTicketType,
  listTicketPanels,
  listTicketTypes,
  nextTicketNumber,
  normalizePanelKey,
  normalizeTypeKey,
  openTicketsFor,
  ticketCounts,
  updateTicketSettings,
  upsertTicketPanel,
  upsertTicketType,
} from '../../services/ticket-store.js';
import {
  TicketError,
  closeTicketChannel,
  ephemeral,
  isStaffMember,
  padTicketNumber,
  publishPanel,
  refreshPanels,
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
    `Panel: \`${button.panelKey}\` · Category: ${button.categoryId ? `<#${button.categoryId}>` : '⚠️ not set'}`,
    `Closed tickets: ${button.closedCategoryId ? `moved to <#${button.closedCategoryId}>` : 'stay in the ticket category'}`,
    `Style: ${button.buttonStyle ?? 'primary'} · Max open: ${button.maxOpen} · Close: ${button.closeAction}`,
    `Numbering: ${button.numberStart ? `starts at ${button.numberStart}` : 'from 1'}`,
    `Support: ${roleList(button.supportRoleIds)} · Ping: ${roleList(button.pingRoleIds)}`,
  ].join('\n');
}

function panelLine(guild, panel) {
  const buttons = countPanelButtons(guild.id, panel.key);

  return [
    `Buttons: **${buttons}**`,
    `Message: ${panel.messageId ? `${channelLabel(guild, panel.channelId)} ([jump](https://discord.com/channels/${guild.id}/${panel.channelId}/${panel.messageId}))` : 'not posted'}`,
    `Title: ${panel.title || 'default'}`,
  ].join('\n');
}

function overviewEmbed() {
  return embed({
    title: 'Tickets',
    description: [
      'Fully customizable ticket panels. Each panel has its own embed, and you choose which buttons belong to it.',
      '',
      '**Member commands**',
      '`/ticket close [reason]` — close the ticket you are in',
      '`/ticket claim` — claim or unclaim a ticket (support team)',
      '`/ticket transcript` — save the transcript (opener or support team)',
      '',
      '**Panels**',
      '`/ticket panel add key:support label:Support channel:#support` — create a panel',
      '`/ticket panel edit key:support title:"Need help?"` — change its embed',
      '`/ticket panel post key:support` — post or refresh it',
      '`/ticket panel list` — show every panel',
      '',
      '**Buttons**',
      '`/ticket button add key:help label:Help panel:support category:#tickets closed_category:#closed` — create a button',
      '`/ticket button edit key:help panel:support ...` — change it or move it',
      '`/ticket button remove key:help confirm:true` — delete it',
      '`/ticket number key:help start:100` — start that button’s tickets at 100',
      '',
      '**Shared setup**',
      '`/ticket list` — show every panel and button',
      '`/ticket log #channel` — where transcripts and ticket events go',
      '',
      'Every value can be changed later. Nothing is predefined.',
    ].join('\n'),
    footer: 'Each panel supports up to 25 buttons, five per row',
  });
}

async function refreshPostedPanels(ctx) {
  await refreshPanels(ctx.guild).catch(() => null);
}

async function readButtonOptions(ctx, startIndex) {
  const patch = {};
  let key;
  let label;

  if (ctx.isSlash) {
    key = ctx.getString('key');
    label = ctx.getString('label');

    const panel = ctx.getString('panel');
    if (panel !== undefined) patch.panelKey = panel;

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

    const closedCategory = ctx.getChannel('closed_category');
    if (closedCategory) {
      if (closedCategory.type !== ChannelType.GuildCategory) {
        throw new TicketError('Pick a Discord category for closed tickets.');
      }

      patch.closedCategoryId = closedCategory.id;
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

    if (flags.panel !== undefined || flags.panel_key !== undefined) {
      patch.panelKey = flags.panel ?? flags.panel_key;
    }
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
    if (flags.closed_category !== undefined || flags.closed !== undefined) {
      const category = await resolveCategory(
        ctx.guild,
        flags.closed_category ?? flags.closed,
      );
      patch.closedCategoryId = category?.id ?? null;
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

/** Resolves the panel a button belongs to, creating the default one if needed. */
function resolvePanelForButton(guildId, rawKey, { create = true } = {}) {
  if (rawKey !== undefined && !normalizePanelKey(rawKey)) {
    throw new TicketError('A panel key needs letters, numbers, `-` or `_`.');
  }

  const normalized = normalizePanelKey(rawKey ?? '') || DEFAULT_PANEL_KEY;
  const before = getTicketPanel(guildId, normalized);

  if (before) return { panel: before, created: false };
  if (!create) return { panel: null, created: false };

  return { panel: ensureTicketPanel(guildId, normalized), created: true };
}

async function handleButtonAdd(ctx) {
  if (!(await requireAdmin(ctx))) return;

  try {
    const { key, label, patch } = await readButtonOptions(ctx, 2);
    const normalized = normalizeTypeKey(key);

    if (!normalized) {
      await ctx.fail({ embeds: [errorEmbed('No key given', 'Use `/ticket button add key:general label:Support panel:main category:#tickets`.')] });
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

    const { panel, created } = resolvePanelForButton(ctx.guildId, patch.panelKey);
    patch.panelKey = panel.key;

    const button = upsertTicketType(ctx.guildId, normalized, { ...patch, label });
    await refreshPostedPanels(ctx);

    await ctx.reply(
      ephemeral({
        embeds: [
          successEmbed(
            `Button added · ${button.buttonLabel || button.label}`,
            [
              buttonLine(button),
              '',
              created
                ? `Panel \`${panel.key}\` was created for it. Style it with \`/ticket panel edit key:${panel.key} title:"..."\` and post it with \`/ticket panel post key:${panel.key} channel:#channel\`.`
                : 'The posted panel was refreshed automatically. Edit the button with `/ticket button edit`.',
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

    if (patch.panelKey !== undefined) {
      patch.panelKey = resolvePanelForButton(ctx.guildId, patch.panelKey).panel.key;
    }

    const button = upsertTicketType(ctx.guildId, normalized, patch);
    await refreshPostedPanels(ctx);

    await ctx.reply(
      ephemeral({
        embeds: [
          successEmbed(
            `Button saved · ${button.buttonLabel || button.label}`,
            `${buttonLine(button)}\n\nThe posted panels were refreshed automatically.`,
          ),
        ],
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
  await refreshPostedPanels(ctx);

  await ctx.reply({
    embeds: [successEmbed('Button deleted', `\`${button.key}\` was removed from panel \`${button.panelKey}\`.`)],
  });
}

async function handleNumber(ctx) {
  if (!(await requireAdmin(ctx))) return;

  let rawKey;
  let rawStart;

  if (ctx.isSlash) {
    rawKey = ctx.getString('key') ?? '';
    rawStart = ctx.getInteger('start');
  } else {
    const { flags, rest } = parseFlagTokens(ctx.args.slice(1));

    rawKey = flags.key ?? flags.button ?? flags.type ?? rest[0] ?? '';
    rawStart = flags.start ?? flags.number ?? rest[1];
  }

  const key = normalizeTypeKey(rawKey);

  if (!key) {
    const buttons = listTicketTypes(ctx.guildId);

    await ctx.reply({
      embeds: [
        embed({
          title: 'Button ticket numbers',
          description: buttons.length
            ? 'Each button counts on its own. Pick one with `/ticket number key:<key> start:<n>`.'
            : 'No buttons yet. Add one with `/ticket button add ...`.',
          fields: buttons.slice(0, 25).map((button) => ({
            name: `${button.buttonLabel || button.label} · ${button.key}`,
            value: `Starts at **${button.numberStart}** · next ticket **#${padTicketNumber(nextTicketNumber(ctx.guildId, button.key))}**`,
          })),
          color: COLORS.primary,
          footer: `Start numbers go from 0 to ${MAX_NUMBER_START}; 0 means counting from 1`,
        }),
      ],
    });
    return;
  }

  const button = getTicketType(ctx.guildId, key);

  if (!button) {
    await ctx.fail({
      embeds: [
        errorEmbed(
          'Unknown button',
          `No button called \`${rawKey || '?'}\`. Add it with \`/ticket button add key:${key} label:... category:#category\`.`,
        ),
      ],
    });
    return;
  }

  if (rawStart === undefined || rawStart === null || rawStart === '') {
    await ctx.reply({
      embeds: [
        embed({
          title: `Ticket numbers · ${button.buttonLabel || button.label}`,
          description: [
            `Key: \`${button.key}\``,
            `Starts at: **${button.numberStart}**${button.numberStart ? '' : ' (counts from 1)'}`,
            `Next ticket: **#${padTicketNumber(nextTicketNumber(ctx.guildId, button.key))}**`,
            '',
            `Change it with \`/ticket number key:${button.key} start:100\`.`,
          ].join('\n'),
          color: COLORS.primary,
        }),
      ],
    });
    return;
  }

  const start = Number(rawStart);

  if (!Number.isInteger(start) || start < 0 || start > MAX_NUMBER_START) {
    await ctx.fail({
      embeds: [
        errorEmbed(
          'Invalid number',
          `Use a whole number from 0 to ${MAX_NUMBER_START}. \`0\` counts from 1.`,
        ),
      ],
    });
    return;
  }

  const updated = upsertTicketType(ctx.guildId, key, { numberStart: start });
  const next = nextTicketNumber(ctx.guildId, updated.key);

  await ctx.reply({
    embeds: [
      successEmbed(
        `Numbering set · ${updated.buttonLabel || updated.label}`,
        [
          start === 0
            ? `\`${updated.key}\` now counts from 1.`
            : `\`${updated.key}\` now starts at **${start}**.`,
          `The next ticket from this button will be **#${padTicketNumber(next)}**.`,
          `Existing tickets keep their numbers. Run \`/ticket number key:${updated.key}\` to check it.`,
        ].join('\n'),
      ),
    ],
  });
}

async function handleButtonList(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const buttons = listTicketTypes(ctx.guildId);
  const panels = listTicketPanels(ctx.guildId);

  await ctx.reply({
    embeds: [
      embed({
        title: 'Panel buttons',
        description: buttons.length
          ? `**${buttons.length}** button(s) across **${panels.length}** panel(s). Each button appears only on its own panel.`
          : 'No buttons yet. Add one with `/ticket button add key:general label:Support panel:main category:#tickets`.',
        fields: buttons.map((button) => ({
          name: `${button.emoji ? `${button.emoji} ` : ''}${button.buttonLabel || button.label} · ${button.key}`,
          value: buttonLine(button),
        })),
        color: COLORS.primary,
        footer: `Up to ${MAX_PANELS} panels, 25 buttons per panel`,
      }),
    ],
  });
}

function readPanelDesign(ctx, startIndex) {
  const patch = {};

  if (ctx.isSlash) {
    const label = ctx.getString('label');
    if (label !== undefined) patch.label = isClearValue(label) ? null : label;

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

    const position = ctx.getInteger('position');
    if (position !== undefined) patch.position = position;
  } else {
    const { flags } = parseFlagTokens(ctx.args.slice(startIndex));

    for (const [key, field] of [
      ['label', 'label'],
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

    if (flags.position !== undefined) {
      const value = Number(flags.position);

      if (!Number.isFinite(value)) {
        throw new TicketError('position must be a number from 0 to 99.');
      }

      patch.position = Math.max(0, Math.min(99, Math.trunc(value)));
    }
  }

  for (const field of ['image', 'thumbnail']) {
    if (patch[field] && !isHttpUrl(patch[field])) {
      throw new TicketError(`The ${field} must be an http(s) image URL.`);
    }
  }

  return patch;
}

/** Reads the panel key from a slash option or a prefix flag/argument. */
function readPanelKey(ctx, startIndex, fallback = null) {
  if (ctx.isSlash) return ctx.getString('key') ?? fallback;

  const { flags, rest } = parseFlagTokens(ctx.args.slice(startIndex));

  return flags.key ?? flags.panel ?? rest[0] ?? fallback;
}

async function readPanelChannel(ctx, { startIndex = 2, positional = null } = {}) {
  if (ctx.isSlash) return ctx.getChannel('channel') ?? null;

  const { flags, rest } = parseFlagTokens(ctx.args.slice(startIndex));
  let raw = flags.channel ?? flags.ch;

  if (raw === undefined && positional !== null) raw = rest[positional];
  if (!raw) return null;

  return resolveTextChannel(ctx.guild, raw);
}

async function panelChannelById(guild, channelId) {
  if (!channelId) return null;

  return (
    guild.channels.cache.get(channelId) ??
    (await guild.channels.fetch(channelId).catch(() => null))
  );
}

async function handlePanelAdd(ctx) {
  if (!(await requireAdmin(ctx))) return;

  try {
    const rawKey = readPanelKey(ctx, 2);
    const key = normalizePanelKey(rawKey);

    if (!key) {
      await ctx.fail({
        embeds: [errorEmbed('No key given', 'Use `/ticket panel add key:support label:Support`.')],
      });
      return;
    }

    if (getTicketPanel(ctx.guildId, key)) {
      await ctx.fail({
        embeds: [
          errorEmbed(
            'That panel already exists',
            `Change it with \`/ticket panel edit key:${key} ...\`.`,
          ),
        ],
      });
      return;
    }

    if (listTicketPanels(ctx.guildId).length >= MAX_PANELS) {
      await ctx.fail({
        embeds: [errorEmbed('Too many panels', `A server can have at most ${MAX_PANELS} panels.`)],
      });
      return;
    }

    const patch = readPanelDesign(ctx, 2);
    const channel = await readPanelChannel(ctx, { startIndex: 2 });
    const panel = upsertTicketPanel(ctx.guildId, key, patch);
    let message = null;

    if (channel) message = await publishPanel(ctx.guild, channel, key);

    await ctx.reply(
      ephemeral({
        embeds: [
          successEmbed(
            `Panel created · ${panel.label}`,
            [
              `Key: \`${panel.key}\` · Buttons: **${countPanelButtons(ctx.guildId, key)}**`,
              message
                ? `It is live in ${channel} ([jump](${message.url ?? '#'})).`
                : `Post it with \`/ticket panel post key:${panel.key} channel:#channel\`.`,
              `Add buttons with \`/ticket button add key:help label:Help panel:${panel.key} category:#tickets\`.`,
            ].join('\n'),
          ),
        ],
      }),
    );
  } catch (error) {
    await ctx.fail({
      embeds: [
        errorEmbed(
          'Could not create the panel',
          error instanceof TicketError ? error.message : error.message,
        ),
      ],
    });
  }
}

async function handlePanelEdit(ctx) {
  if (!(await requireAdmin(ctx))) return;

  try {
    const rawKey = readPanelKey(ctx, 2);
    const key = normalizePanelKey(rawKey);

    if (!key) {
      await ctx.fail({
        embeds: [errorEmbed('No panel given', 'Use `/ticket panel edit key:support title:"..."`.')],
      });
      return;
    }

    const existing = getTicketPanel(ctx.guildId, key);

    if (!existing) {
      await ctx.fail({
        embeds: [
          errorEmbed(
            'Unknown panel',
            `No panel called \`${rawKey || '?'}\`. Create it with \`/ticket panel add key:${key || 'key'}\`.`,
          ),
        ],
      });
      return;
    }

    const patch = readPanelDesign(ctx, 2);
    const channel = await readPanelChannel(ctx, { startIndex: 2 });
    const panel = upsertTicketPanel(ctx.guildId, key, patch);
    let message = null;

    if (channel) {
      message = await publishPanel(ctx.guild, channel, key);
    } else {
      const saved = await panelChannelById(ctx.guild, panel.channelId);

      if (saved) message = await publishPanel(ctx.guild, saved, key).catch(() => null);
    }

    await ctx.reply(
      ephemeral({
        embeds: [
          successEmbed(
            `Panel saved · ${panel.label}`,
            [
              `Key: \`${panel.key}\` · Buttons: **${countPanelButtons(ctx.guildId, key)}**`,
              message
                ? `The posted panel was refreshed ([jump](${message.url ?? '#'})).`
                : `Post it with \`/ticket panel post key:${panel.key} channel:#channel\`.`,
            ].join('\n'),
          ),
        ],
      }),
    );
  } catch (error) {
    await ctx.fail({
      embeds: [
        errorEmbed(
          'Could not save the panel',
          error instanceof TicketError ? error.message : error.message,
        ),
      ],
    });
  }
}

async function handlePanelPost(ctx) {
  if (!(await requireAdmin(ctx))) return;

  try {
    const actionKnown = ['post', 'publish'].includes(String(ctx.args[1] ?? '').toLowerCase());
    const startIndex = ctx.isSlash ? 0 : actionKnown ? 2 : 1;
    const patch = readPanelDesign(ctx, startIndex);

    let rawKey;

    if (ctx.isSlash) {
      rawKey = ctx.getString('key') ?? DEFAULT_PANEL_KEY;
    } else {
      const { flags, rest } = parseFlagTokens(ctx.args.slice(startIndex));

      rawKey = flags.key ?? flags.panel ?? (actionKnown ? rest[0] : null) ?? DEFAULT_PANEL_KEY;
    }

    const key = normalizePanelKey(rawKey) || DEFAULT_PANEL_KEY;

    if (!getTicketPanel(ctx.guildId, key)) upsertTicketPanel(ctx.guildId, key, {});
    if (Object.keys(patch).length > 0) upsertTicketPanel(ctx.guildId, key, patch);

    const panel = getTicketPanel(ctx.guildId, key);
    let channel = await readPanelChannel(ctx, {
      startIndex,
      positional: actionKnown ? null : 0,
    });

    if (!channel) channel = await panelChannelById(ctx.guild, panel.channelId);
    if (!channel) channel = ctx.channel;

    if (!channel?.isTextBased?.()) {
      await ctx.fail({ embeds: [errorEmbed('No channel', 'Pick a text channel for the panel.')] });
      return;
    }

    const buttons = listTicketTypes(ctx.guildId, key);
    const message = await publishPanel(ctx.guild, channel, key);

    await ctx.reply(
      ephemeral({
        embeds: [
          successEmbed(
            `Panel posted · ${panel.label}`,
            [
              `It is live in ${channel} ([jump](${message.url ?? '#'})).`,
              buttons.length
                ? `It has **${buttons.length}** button(s) and uses your custom embed.`
                : `It has no buttons yet. Add one with \`/ticket button add ... panel:${key}\`.`,
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

async function handlePanelList(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const panels = listTicketPanels(ctx.guildId);
  const buttons = listTicketTypes(ctx.guildId);

  await ctx.reply({
    embeds: [
      embed({
        title: 'Ticket panels',
        description: panels.length
          ? [
              `**${panels.length}** panel(s) · **${buttons.length}** button(s).`,
              `Log channel: ${channelLabel(ctx.guild, getTicketSettings(ctx.guildId).logChannelId)}`,
            ].join('\n')
          : 'No panels yet. Create one with `/ticket panel add key:main label:Main`.',
        fields: panels.map((panel) => {
          const members = buttons.filter((button) => button.panelKey === panel.key);

          return {
            name: `${panel.label} · ${panel.key}`,
            value: [
              panelLine(ctx.guild, panel),
              members.length
                ? members
                    .map((button) => `• ${button.buttonLabel || button.label} (\`${button.key}\`)`)
                    .join('\n')
                : '• no buttons yet',
            ]
              .join('\n')
              .slice(0, 1024),
          };
        }),
        color: COLORS.primary,
        footer: 'Edit a panel with /ticket panel edit, or a button with /ticket button edit',
      }),
    ],
  });
}

async function handlePanelRemove(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const rawKey = readPanelKey(ctx, 2);
  const key = normalizePanelKey(rawKey);
  const panel = key ? getTicketPanel(ctx.guildId, key) : null;
  const { flags } = ctx.isSlash ? { flags: {} } : parseFlagTokens(ctx.args.slice(2));
  const confirmed = ctx.isSlash
    ? ctx.getBoolean('confirm')
    : flags.confirm !== undefined || ctx.args.includes('confirm');

  if (!panel) {
    await ctx.fail({
      embeds: [errorEmbed('Unknown panel', `No panel called \`${rawKey || '?'}\`.` )],
    });
    return;
  }

  const buttons = listTicketTypes(ctx.guildId, panel.key);
  const open = buttons
    .map((button) => ({ button, count: openTicketsFor(ctx.guildId, null, button.key).length }))
    .filter((entry) => entry.count > 0);

  if (open.length > 0) {
    await ctx.fail({
      embeds: [
        warningEmbed(
          'Open tickets still exist',
          `Close the open tickets before deleting this panel:\n${open
            .map((entry) => `• \`${entry.button.key}\` (${entry.count})`)
            .join('\n')}`,
        ),
      ],
    });
    return;
  }

  if (!confirmed) {
    await ctx.fail({
      embeds: [
        warningEmbed(
          'Confirmation needed',
          `This deletes panel \`${panel.key}\` and its **${buttons.length}** button(s). Run \`/ticket panel remove key:${panel.key} confirm:true\`.`,
        ),
      ],
    });
    return;
  }

  if (panel.channelId && panel.messageId) {
    const channel = await panelChannelById(ctx.guild, panel.channelId);
    const message = channel?.messages?.fetch
      ? await channel.messages.fetch(panel.messageId).catch(() => null)
      : null;

    if (message) await message.delete().catch(() => null);
  }

  for (const button of buttons) deleteTicketType(ctx.guildId, button.key);
  deleteTicketPanel(ctx.guildId, panel.key);

  await ctx.reply({
    embeds: [
      successEmbed(
        'Panel deleted',
        `\`${panel.key}\` and its **${buttons.length}** button(s) were removed.`,
      ),
    ],
  });
}

async function handleList(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const panels = listTicketPanels(ctx.guildId);
  const buttons = listTicketTypes(ctx.guildId);
  const settings = getTicketSettings(ctx.guildId);
  const counts = ticketCounts(ctx.guildId);

  await ctx.reply({
    embeds: [
      embed({
        title: 'Ticket setup',
        description: [
          `Panels: **${panels.length}** · buttons: **${buttons.length}** · open: **${counts.open}** · archived: **${counts.closed}** · deleted: **${counts.deleted}**`,
          `Log channel: ${channelLabel(ctx.guild, settings.logChannelId)}`,
        ].join('\n'),
        fields: panels.map((panel) => {
          const members = buttons.filter((button) => button.panelKey === panel.key);

          return {
            name: `${panel.label} · ${panel.key} · ${members.length} button(s)`,
            value: [
              panelLine(ctx.guild, panel),
              ...members.map(
                (button) =>
                  `• ${button.emoji ? `${button.emoji} ` : ''}${button.buttonLabel || button.label} (\`${button.key}\`) → ${button.categoryId ? `<#${button.categoryId}>` : '⚠️ no category'}`,
              ),
            ]
              .join('\n')
              .slice(0, 1024),
          };
        }),
        footer:
          'Edit a panel with /ticket panel edit, or a button with /ticket button edit. Up to 25 buttons per panel.',
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
      option.setName('key').setDescription('Short id used in the button, for example help').setRequired(true).setAutocomplete(true),
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
    .addChannelOption((option) =>
      option
        .setName('closed_category')
        .setDescription('Category that closed tickets are moved to (default: stay)')
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('panel')
        .setDescription('Panel this button belongs to (default: main)')
        .setAutocomplete(true)
        .setRequired(false),
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

function addPanelOptions(sub, { requireKey = false } = {}) {
  return sub
    .addStringOption((option) =>
      option
        .setName('key')
        .setDescription('Panel id, for example support')
        .setRequired(requireKey)
        .setAutocomplete(true),
    )
    .addStringOption((option) =>
      option.setName('label').setDescription('Name shown in /ticket panel list').setRequired(false),
    )
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Where to post it (default: saved channel or this channel)')
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
    )
    .addIntegerOption((option) =>
      option.setName('position').setDescription('Order in /ticket panel list (lower first)').setMinValue(0).setMaxValue(99).setRequired(false),
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
    .addSubcommandGroup((group) =>
      group
        .setName('panel')
        .setDescription('Admin: create, edit or post named ticket panels')
        .addSubcommand((sub) =>
          addPanelOptions(
            sub.setName('add').setDescription('Admin: create a named panel with its own embed'),
            { requireKey: true },
          ),
        )
        .addSubcommand((sub) =>
          addPanelOptions(
            sub.setName('edit').setDescription('Admin: change a panel embed or move it'),
            { requireKey: true },
          ),
        )
        .addSubcommand((sub) =>
          addPanelOptions(sub.setName('post').setDescription('Admin: post or refresh one panel')),
        )
        .addSubcommand((sub) =>
          sub.setName('list').setDescription('Admin: show every panel and its buttons'),
        )
        .addSubcommand((sub) =>
          sub
            .setName('remove')
            .setDescription('Admin: delete a panel and its buttons')
            .addStringOption((option) =>
              option.setName('key').setDescription('Panel key').setRequired(true).setAutocomplete(true),
            )
            .addBooleanOption((option) =>
              option.setName('confirm').setDescription('Set true to confirm deletion').setRequired(true),
            ),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Admin: show every panel and button'))
    .addSubcommand((sub) => sub.setName('buttons').setDescription('Admin: list every panel button'))
    .addSubcommand((sub) =>
      sub
        .setName('number')
        .setDescription('Admin: set the starting ticket number for one button')
        .addStringOption((option) =>
          option
            .setName('key')
            .setDescription('Button key (empty shows every button)')
            .setAutocomplete(true)
            .setRequired(false),
        )
        .addIntegerOption((option) =>
          option
            .setName('start')
            .setDescription('First ticket number (0–999999; 0 counts from 1)')
            .setMinValue(0)
            .setMaxValue(MAX_NUMBER_START)
            .setRequired(false),
        ),
    )
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
  usage: 'ticket [button add|edit|remove | panel add|edit|post|list|remove | number|list|buttons|log|close|claim|add|remove|rename|transcript]',
  cooldown: 3,
  guildOnly: true,

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const group = interaction.options.getSubcommandGroup(false);
    const query = String(focused.value ?? '').toLowerCase();

    if (focused.name === 'panel') {
      const panels = listTicketPanels(interaction.guildId)
        .filter(
          (panel) =>
            !query || panel.key.includes(query) || panel.label.toLowerCase().includes(query),
        )
        .slice(0, 25)
        .map((panel) => ({
          name: `${panel.label} (${panel.key})`,
          value: panel.key,
        }));

      await interaction.respond(panels);
      return;
    }

    if (focused.name !== 'key') {
      await interaction.respond([]);
      return;
    }

    if (group === 'panel') {
      const panels = listTicketPanels(interaction.guildId)
        .filter(
          (panel) =>
            !query || panel.key.includes(query) || panel.label.toLowerCase().includes(query),
        )
        .slice(0, 25)
        .map((panel) => ({
          name: `${panel.label} (${panel.key})`,
          value: panel.key,
        }));

      await interaction.respond(panels);
      return;
    }

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

      if (group === 'panel') {
        const action = ctx.getSubcommand(false);

        if (action === 'add') return handlePanelAdd(ctx);
        if (action === 'edit') return handlePanelEdit(ctx);
        if (action === 'post') return handlePanelPost(ctx);
        if (action === 'list') return handlePanelList(ctx);
        if (action === 'remove') return handlePanelRemove(ctx);

        return ctx.reply({ embeds: [overviewEmbed()] });
      }

      const subcommand = ctx.getSubcommand(false) ?? '';

      switch (subcommand) {
        case 'list':
          return handleList(ctx);
        case 'buttons':
          return handleButtonList(ctx);
        case 'number':
          return handleNumber(ctx);
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

    if (subcommand === 'panel') {
      const action = (ctx.args[1] ?? '').toLowerCase();

      if (action === 'add' || action === 'create') return handlePanelAdd(ctx);
      if (action === 'edit' || action === 'set') return handlePanelEdit(ctx);
      if (action === 'post' || action === 'publish') return handlePanelPost(ctx);
      if (action === 'list') return handlePanelList(ctx);
      if (action === 'remove' || action === 'delete') return handlePanelRemove(ctx);

      // `:-ticket panel title=...` keeps working as "edit and post the main panel".
      return handlePanelPost(ctx);
    }

    switch (subcommand) {
      case 'list':
      case 'status':
        return handleList(ctx);
      case 'buttons':
        return handleButtonList(ctx);
      case 'number':
      case 'numbers':
      case 'numbering':
        return handleNumber(ctx);
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
