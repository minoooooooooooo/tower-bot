import {
  ActionRowBuilder,
  ChannelType,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { config } from '../../config.js';
import { COLORS, embed, errorEmbed, successEmbed } from '../../lib/embeds.js';
import { isClearValue, validateImageUrl } from '../../lib/media.js';
import { getGuildSettings } from '../../services/birthday-store.js';
import {
  STYLES,
  WELCOME_PLACEHOLDERS,
  buildWelcomePayload,
  chooseStyle,
  enabledStyles,
  getStyle,
  modalInputs,
  styleTexts,
  unknownWelcomePlaceholders,
} from '../../services/welcome-styles.js';
import {
  MODES,
  clearWelcomePiece,
  clearWelcomeTexts,
  getWelcomeGifs,
  getWelcomeSettings,
  getWelcomeTexts,
  setWelcomeGif,
  setWelcomePiece,
  updateWelcomeSettings,
} from '../../services/welcome-store.js';

const MODE_LABELS = {
  random: 'Random (never the same style twice in a row)',
  rotate: 'Rotate (in the order below)',
  single: 'Single style',
};

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

function isAdmin(ctx) {
  return Boolean(ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild));
}

function styleChoices() {
  return STYLES.map((style) => ({ name: style.name, value: style.key }));
}

function resolveStyle(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return null;

  return getStyle(value) ?? STYLES.find((style) => style.name.toLowerCase() === value) ?? null;
}

function styleList() {
  return STYLES.map((style) => `\`${style.key}\``).join(', ');
}

/** `<#123>`, a raw id, or `none` to clear. */
function channelIdFromArgs(ctx, index) {
  const raw = ctx.args[index];
  if (!raw) return undefined;

  if (['none', 'off', 'clear', '-'].includes(raw.toLowerCase())) return null;

  const mention = /^<#(\d{17,20})>$/.exec(raw);
  if (mention) return mention[1];

  return /^\d{17,20}$/.test(raw) ? raw : undefined;
}

function channelIdFrom(ctx, name, index) {
  if (ctx.isSlash) {
    const channel = ctx.getChannel(name);
    return channel ? channel.id : undefined;
  }

  return channelIdFromArgs(ctx, index);
}

function channelLabel(guild, id) {
  if (!id) return 'not set';
  return guild?.channels?.cache?.get(id)?.toString?.() ?? `<#${id}>`;
}

async function requireAdmin(ctx) {
  if (isAdmin(ctx)) return true;

  await ctx.reply(
    ephemeral({
      embeds: [errorEmbed('Missing permissions', 'You need the Manage Server permission.')],
    }),
  );

  return false;
}

function overviewEmbed(ctx) {
  const settings = getWelcomeSettings(ctx.guildId);

  return embed({
    title: 'Welcome cards',
    description: [
      'Six card styles, chosen automatically when someone joins.',
      '',
      `\`/welcome channel [#channel]\` — where cards are posted *(${channelLabel(ctx.guild, settings.channelId)})*`,
      '`/welcome mode <random|rotate|single> [style]` — how the style is picked',
      '`/welcome toggle <style>` — turn one style on or off',
      '`/welcome list` — current setup and which styles are on',
      '`/welcome test [style]` — preview one card, only you see it',
      '`/welcome gif [style] [url]` — GIF for one card (`none` removes it)',
      '`/welcome edit <style>` — rewrite that style\'s text (admin)',
      '`/welcome reset [style]` — restore the default text (admin)',
      '`/welcome links [rules] [general]` — channels used by the cards (admin)',
      '',
      `Placeholders: ${WELCOME_PLACEHOLDERS.map((placeholder) => `{${placeholder.key}}`).join(' ')}`,
      '',
      `Styles: ${styleList()}`,
    ].join('\n'),
  });
}

async function handleChannel(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const channelId = channelIdFrom(ctx, 'channel', 1);

  if (channelId === undefined) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed('No channel given', 'Mention a channel, or use `none` to stop welcome cards.'),
        ],
      }),
    );
    return;
  }

  if (channelId !== null) {
    const channel =
      ctx.guild.channels.cache.get(channelId) ??
      (await ctx.guild.channels.fetch(channelId).catch(() => null));

    if (!channel || channel.isTextBased?.() === false) {
      await ctx.reply(
        ephemeral({ embeds: [errorEmbed('Invalid channel', 'That is not a text channel.')] }),
      );
      return;
    }

    const me = ctx.guild.members.me;
    const permissions = me ? channel.permissionsFor?.(me) : null;

    if (
      permissions &&
      !(
        permissions.has(PermissionFlagsBits.SendMessages) &&
        permissions.has(PermissionFlagsBits.EmbedLinks)
      )
    ) {
      await ctx.reply(
        ephemeral({
          embeds: [
            errorEmbed(
              'Missing permissions',
              `I need **Send Messages** and **Embed Links** in ${channel}.`,
            ),
          ],
        }),
      );
      return;
    }
  }

  updateWelcomeSettings(ctx.guildId, { channelId });

  await ctx.reply(
    ephemeral({
      embeds: [
        successEmbed(
          channelId ? 'Welcome channel set' : 'Welcome cards disabled',
          channelId
            ? `New members are greeted in ${channelLabel(ctx.guild, channelId)}. Preview with \`/welcome test\`.`
            : 'No channel is configured, so nobody will be greeted.',
        ),
      ],
    }),
  );
}

async function handleMode(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const raw = ctx.isSlash ? ctx.getString('mode') : ctx.args[1]?.toLowerCase();
  const mode = raw === 'random' || raw === 'rotate' || raw === 'single' ? raw : null;

  if (!mode) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed('Invalid mode', `Use one of: ${MODES.map((item) => `\`${item}\``).join(', ')}.`),
        ],
      }),
    );
    return;
  }

  let forcedStyle = null;

  if (mode === 'single') {
    const style = resolveStyle(ctx.isSlash ? ctx.getString('style') : ctx.args[2]);

    if (!style) {
      await ctx.reply(
        ephemeral({
          embeds: [
            errorEmbed(
              'Pick a style',
              'Single mode needs one style, for example `/welcome mode single style:Ledger`.',
            ),
          ],
        }),
      );
      return;
    }

    forcedStyle = style.key;
  }

  updateWelcomeSettings(ctx.guildId, { mode, forcedStyle });

  await ctx.reply(
    ephemeral({
      embeds: [
        successEmbed(
          'Welcome mode updated',
          forcedStyle
            ? `Every new member gets the **${getStyle(forcedStyle).name}** card.`
            : `Style is now chosen by **${MODE_LABELS[mode]}**.`,
        ),
      ],
    }),
  );
}

async function handleToggle(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const style = resolveStyle(ctx.isSlash ? ctx.getString('style') : ctx.args[1]);

  if (!style) {
    await ctx.reply(
      ephemeral({
        embeds: [errorEmbed('Unknown style', `Pick one of: ${styleList()}.`)],
      }),
    );
    return;
  }

  const settings = getWelcomeSettings(ctx.guildId);
  const current = enabledStyles(settings);
  const isOn = current.includes(style.key);
  const next = isOn ? current.filter((key) => key !== style.key) : [...current, style.key];

  if (next.length === 0) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Keep one style',
            'Every style would be off. Turn another one on first, or use `/welcome mode single`.',
          ),
        ],
      }),
    );
    return;
  }

  updateWelcomeSettings(ctx.guildId, { enabled: next });

  await ctx.reply(
    ephemeral({
      embeds: [
        successEmbed(
          isOn ? `${style.name} disabled` : `${style.name} enabled`,
          `${next.length} of ${STYLES.length} styles are in the rotation.`,
        ),
      ],
    }),
  );
}

async function handleList(ctx) {
  const settings = getWelcomeSettings(ctx.guildId);
  const texts = getWelcomeTexts(ctx.guildId);
  const gifs = getWelcomeGifs(ctx.guildId);
  const enabled = enabledStyles(settings);

  const lines = STYLES.map((style) => {
    const on = enabled.includes(style.key);
    const edited = Object.keys(texts[style.key] ?? {}).length;
    const marker = on ? '✅' : '⬜';
    const parts = [];

    if (edited > 0) parts.push(`${edited} edited`);
    if (gifs[style.key]) parts.push('GIF');
    const suffix = parts.length > 0 ? ` · ${parts.join(' · ')}` : '';

    return `${marker} **${style.name}** — ${style.summary}${suffix}`;
  });

  const description = [
    `Channel: ${channelLabel(ctx.guild, settings.channelId)}`,
    `Mode: ${MODE_LABELS[settings.mode] ?? settings.mode}${settings.forcedStyle ? ` (${getStyle(settings.forcedStyle)?.name ?? settings.forcedStyle})` : ''}`,
    `Links: rules ${channelLabel(ctx.guild, settings.rulesChannelId)} · general ${channelLabel(ctx.guild, settings.generalChannelId)}`,
    '',
    `**Styles (${enabled.length} of ${STYLES.length} active)**`,
    ...lines,
  ];

  if (!settings.channelId) description.unshift('⚠️ No welcome channel is set.', '');

  await ctx.reply({
    embeds: [
      embed({
        title: 'Welcome cards',
        description: description.join('\n'),
        footer: 'Edit the text of a style with /welcome edit',
      }),
    ],
  });
}

async function handleTest(ctx) {
  const settings = getWelcomeSettings(ctx.guildId);
  const style = resolveStyle(ctx.isSlash ? ctx.getString('style') : ctx.args[1]);
  const styleKey = style?.key ?? chooseStyle(settings);
  const texts = getWelcomeTexts(ctx.guildId);
  const timeZone = getGuildSettings(ctx.guildId).timezone ?? config.timezone;

  const payload = buildWelcomePayload({
    guild: ctx.guild,
    member: ctx.member,
    settings,
    gifs: getWelcomeGifs(ctx.guildId),
    styleKey,
    overrides: texts[styleKey] ?? {},
    timeZone,
  });

  await ctx.reply(
    ephemeral({
      ...payload,
      content: payload.content
        ? `${payload.content} — preview of the **${getStyle(styleKey).name}** card (nobody was pinged)`
        : `Preview of the **${getStyle(styleKey).name}** card.`,
    }),
  );
}

async function handleGif(ctx) {
  if (!(await requireAdmin(ctx))) return;

  let styleArg = ctx.isSlash ? ctx.getString('style') : null;
  let raw = ctx.isSlash ? (ctx.getString('url') ?? '') : '';

  if (!ctx.isSlash) {
    const first = ctx.args[1];
    const second = ctx.args[2];
    const looksLikeStyle = Boolean(resolveStyle(first));

    // `:-welcome gif <url>` still means Classic; a real style name selects that card.
    if (first && (isClearValue(first) || !looksLikeStyle)) {
      styleArg = 'classic';
      raw = first;
    } else {
      styleArg = first ?? 'classic';
      raw = second ?? '';
    }
  }

  const style = resolveStyle(styleArg ?? 'classic');

  if (!style) {
    await ctx.reply(
      ephemeral({
        embeds: [errorEmbed('Unknown style', `Pick one of: ${styleList()}.`)],
      }),
    );
    return;
  }

  const current = getWelcomeGifs(ctx.guildId)[style.key] ?? null;

  if (!String(raw).trim()) {
    await ctx.reply(
      ephemeral({
        embeds: [
          embed({
            title: `${style.name} GIF`,
            description: current
              ? `${current}\n\nRemove it with \`/welcome gif style:${style.name} url:none\`, or edit it in \`/welcome edit\`.`
              : `No GIF is set for ${style.name}. Add one with \`/welcome gif style:${style.name} url:https://media.example.com/wave.gif\`, or edit it in \`/welcome edit\`.`,
            image: current ?? undefined,
            color: current ? COLORS.primary : COLORS.muted,
          }),
        ],
      }),
    );
    return;
  }

  if (isClearValue(raw)) {
    setWelcomeGif(ctx.guildId, style.key, null);

    await ctx.reply(
      ephemeral({
        embeds: [successEmbed(`${style.name} GIF removed`, 'That card no longer has an image.')],
      }),
    );
    return;
  }

  const problem = validateImageUrl(raw, 'GIF');

  if (problem) {
    await ctx.reply(ephemeral({ embeds: [errorEmbed('Invalid GIF', problem)] }));
    return;
  }

  setWelcomeGif(ctx.guildId, style.key, String(raw).trim());

  await ctx.reply(
    ephemeral({
      embeds: [
        embed({
          title: `${style.name} GIF set`,
          description: `It now appears on the ${style.name} card. Preview with \`/welcome test style:${style.name}\`.`,
          image: String(raw).trim(),
          color: COLORS.success,
        }),
      ],
    }),
  );
}

async function handleEdit(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const style = resolveStyle(ctx.isSlash ? ctx.getString('style') : ctx.args[1]);

  if (!style) {
    await ctx.reply(
      ephemeral({
        embeds: [errorEmbed('Unknown style', `Pick one of: ${styleList()}.`)],
      }),
    );
    return;
  }

  if (!ctx.isSlash) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Use the slash command',
            `Discord only opens edit forms from slash commands. Run \`/welcome edit style:${style.name}\`.`,
          ),
        ],
      }),
    );
    return;
  }

  const gifs = getWelcomeGifs(ctx.guildId);
  const current = styleTexts(style, getWelcomeTexts(ctx.guildId)[style.key] ?? {});
  current.gifUrl = gifs[style.key] ?? '';

  const modal = new ModalBuilder()
    .setCustomId(`welcome:edit:${style.key}`)
    .setTitle(`Edit the ${style.name} card`.slice(0, 45));

  for (const input of modalInputs(style)) {
    const field = new TextInputBuilder()
      .setCustomId(input.key)
      .setLabel(input.label.slice(0, 45))
      .setStyle(input.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setMaxLength(input.max)
      .setRequired(false)
      .setValue(String(current[input.key] ?? '').slice(0, input.max));

    if (input.placeholder) field.setPlaceholder(input.placeholder);

    modal.addComponents(new ActionRowBuilder().addComponents(field));
  }

  await ctx.interaction.showModal(modal);
}

async function handleReset(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const style = resolveStyle(ctx.isSlash ? ctx.getString('style') : ctx.args[1]);

  if ((ctx.isSlash ? ctx.getString('style') : ctx.args[1]) && !style) {
    await ctx.reply(
      ephemeral({
        embeds: [errorEmbed('Unknown style', `Pick one of: ${styleList()}.`)],
      }),
    );
    return;
  }

  clearWelcomeTexts(ctx.guildId, style?.key ?? null);

  await ctx.reply(
    ephemeral({
      embeds: [
        successEmbed(
          style ? `${style.name} restored` : 'All welcome text restored',
          style
            ? 'Every piece is back to its default. Other styles were not touched.'
            : 'Every style is back to its default text.',
        ),
      ],
    }),
  );
}

async function handleLinks(ctx) {
  if (!(await requireAdmin(ctx))) return;

  const rules = channelIdFrom(ctx, 'rules', 1);
  const general = channelIdFrom(ctx, 'general', 2);

  if (rules === undefined && general === undefined) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Nothing to change',
            'Mention the channels to link, for example `/welcome links rules:#rules general:#general`.',
          ),
        ],
      }),
    );
    return;
  }

  const patch = {};
  if (rules !== undefined) patch.rulesChannelId = rules;
  if (general !== undefined) patch.generalChannelId = general;

  const settings = updateWelcomeSettings(ctx.guildId, patch);

  await ctx.reply(
    ephemeral({
      embeds: [
        successEmbed(
          'Welcome links updated',
          `Rules: ${channelLabel(ctx.guild, settings.rulesChannelId)} · General: ${channelLabel(ctx.guild, settings.generalChannelId)}`,
        ),
      ],
    }),
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('welcome')
    .setDescription('Welcome cards for new members')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('channel')
        .setDescription('Admin: set the welcome channel (empty or "none" disables cards)')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Where welcome cards are posted')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('mode')
        .setDescription('Admin: choose how the card style is picked')
        .addStringOption((option) =>
          option
            .setName('mode')
            .setDescription('random, rotate, or a single style')
            .setRequired(true)
            .addChoices(
              { name: 'Random (no repeat)', value: 'random' },
              { name: 'Rotate in order', value: 'rotate' },
              { name: 'Single style', value: 'single' },
            ),
        )
        .addStringOption((option) =>
          option
            .setName('style')
            .setDescription('The style to pin when mode is "single"')
            .setRequired(false)
            .addChoices(...styleChoices()),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('toggle')
        .setDescription('Admin: turn one card style on or off')
        .addStringOption((option) =>
          option
            .setName('style')
            .setDescription('The style to toggle')
            .setRequired(true)
            .addChoices(...styleChoices()),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Show the welcome setup'))
    .addSubcommand((sub) =>
      sub
        .setName('test')
        .setDescription('Preview a card, only you can see it')
        .addStringOption((option) =>
          option
            .setName('style')
            .setDescription('Leave empty for the next style in the rotation')
            .setRequired(false)
            .addChoices(...styleChoices()),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('gif')
        .setDescription('Admin: GIF for one card (empty shows the current one)')
        .addStringOption((option) =>
          option
            .setName('style')
            .setDescription('Which card (defaults to Classic)')
            .setRequired(false)
            .addChoices(...styleChoices()),
        )
        .addStringOption((option) =>
          option
            .setName('url')
            .setDescription('Direct image/GIF URL, or "none" to remove it')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('edit')
        .setDescription('Admin: rewrite the text of one style')
        .addStringOption((option) =>
          option
            .setName('style')
            .setDescription('Which style to edit')
            .setRequired(true)
            .addChoices(...styleChoices()),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reset')
        .setDescription('Admin: restore the default text')
        .addStringOption((option) =>
          option
            .setName('style')
            .setDescription('Restore one style (empty restores all)')
            .setRequired(false)
            .addChoices(...styleChoices()),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('links')
        .setDescription('Admin: channels used by the cards')
        .addChannelOption((option) =>
          option
            .setName('rules')
            .setDescription('Rules channel, used by {rules}')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum)
            .setRequired(false),
        )
        .addChannelOption((option) =>
          option
            .setName('general')
            .setDescription('General channel, used by {general}')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(false),
        ),
    ),

  name: 'welcome',
  aliases: ['greet'],
  description: 'Welcome cards for new members: six styles, editable text',
  category: 'Community',
  usage: 'welcome <channel|mode|toggle|list|test|gif|edit|reset|links>',
  cooldown: 3,
  guildOnly: true,

  async execute(ctx) {
    const subcommand = ctx.isSlash
      ? (ctx.getSubcommand() ?? '')
      : (ctx.args[0] ?? '').toLowerCase();

    switch (subcommand) {
      case 'channel':
        return handleChannel(ctx);
      case 'mode':
        return handleMode(ctx);
      case 'toggle':
        return handleToggle(ctx);
      case 'list':
        return handleList(ctx);
      case 'test':
        return handleTest(ctx);
      case 'gif':
        return handleGif(ctx);
      case 'edit':
        return handleEdit(ctx);
      case 'reset':
        return handleReset(ctx);
      case 'links':
        return handleLinks(ctx);
      default:
        return ctx.reply({ embeds: [overviewEmbed(ctx)] });
    }
  },

  /**
   * Modal submission for `/welcome edit`. Routed by `interactionCreate` using
   * the `welcome:edit:<style>` custom id.
   */
  async modal(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply(
        ephemeral({
          embeds: [errorEmbed('Missing permissions', 'You need the Manage Server permission.')],
        }),
      );
      return;
    }

    const [, action, styleKey] = interaction.customId.split(':');
    const style = action === 'edit' ? getStyle(styleKey) : null;

    if (!style) {
      await interaction.reply(
        ephemeral({ embeds: [errorEmbed('Unknown style', 'That style no longer exists.')] }),
      );
      return;
    }

    const guildId = interaction.guildId;
    const defaults = styleTexts(style, {});
    const values = {};
    const unknown = new Set();
    const problems = [];

    for (const input of modalInputs(style)) {
      const value = String(interaction.fields.getTextInputValue(input.key) ?? '').trim();
      values[input.key] = value;

      if (input.target === 'setting') {
        if (value && !isClearValue(value)) {
          const problem = validateImageUrl(value, 'GIF');
          if (problem) problems.push(`**${input.label}**: ${problem}`);
        }
      } else {
        for (const placeholder of unknownWelcomePlaceholders(value)) unknown.add(placeholder);
      }
    }

    // Validate before writing anything, so a bad GIF URL cannot half-save a card.
    if (problems.length > 0) {
      await interaction.reply(
        ephemeral({ embeds: [errorEmbed('Nothing saved', problems.join('\n'))] }),
      );
      return;
    }

    for (const piece of style.pieces) {
      const value = values[piece.key];

      // Empty or unchanged pieces fall back to the default, so the database only
      // ever holds real edits.
      if (!value || value === defaults[piece.key]) {
        clearWelcomePiece(guildId, style.key, piece.key);
      } else {
        setWelcomePiece(guildId, style.key, piece.key, value);
      }
    }

    setWelcomeGif(guildId, style.key, !values.gifUrl || isClearValue(values.gifUrl) ? null : values.gifUrl);

    const notes = [];
    if (unknown.size > 0) {
      notes.push(
        `⚠️ Unknown placeholder${unknown.size === 1 ? '' : 's'}: ${[...unknown]
          .map((key) => `\`{${key}}\``)
          .join(', ')}. They will be printed literally.`,
      );
    }

    // Discord parses mentions only in the description and field values.
    const unrendered = style.pieces
      .filter((piece) => piece.key === 'title' || piece.key === 'footer')
      .filter((piece) => /\{(user|rules|general)\}/.test(values[piece.key] ?? ''))
      .map((piece) => `**${piece.label}**`);

    if (unrendered.length > 0) {
      notes.push(
        `⚠️ Discord does not render mentions in ${unrendered.join(' or ')}. \`{user}\`, \`{rules}\` and \`{general}\` will appear as raw text there — use \`{name}\` instead, or move the mention into the description.`,
      );
    }

    notes.push(`Preview it with \`/welcome test style:${style.name}\`.`);

    await interaction.reply(
      ephemeral({
        embeds: [successEmbed(`${style.name} card saved`, notes.join('\n\n'))],
      }),
    );
  },
};
