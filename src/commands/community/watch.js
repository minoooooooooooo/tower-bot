import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, embed, errorEmbed, infoEmbed, successEmbed } from '../../lib/embeds.js';
import { createLogger } from '../../lib/logger.js';
import {
  MAX_TERM_LENGTH,
  MAX_WATCH_TERMS,
  MIN_TERM_LENGTH,
  addIgnoredChannel,
  addWatchTerm,
  clearWatchTerms,
  countTerms,
  findTerm,
  getWatchChannelId,
  listIgnoredChannels,
  listWatchTerms,
  removeIgnoredChannel,
  removeWatchTerm,
  setWatchChannelId,
} from '../../services/watch-store.js';
import { invalidateWatchCache } from '../../services/watch.js';

const logger = createLogger('watch');

const MAX_SHOWN = 30;
const OFF_WORDS = ['off', 'none', 'clear', 'disable'];

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

async function requireModerator(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) return true;

  await ctx.reply(
    ephemeral({
      embeds: [
        errorEmbed('Missing permissions', 'You need **Manage Messages** to manage keyword alerts.'),
      ],
    }),
  );

  return false;
}

async function requireAdmin(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await ctx.reply(
    ephemeral({
      embeds: [
        errorEmbed(
          'Missing permissions',
          'You need **Manage Server** to choose where keyword alerts are posted.',
        ),
      ],
    }),
  );

  return false;
}

function extractTerm(ctx) {
  if (ctx.isSlash) return (ctx.getString('keyword') ?? '').trim();

  const [action, ...rest] = ctx.args;

  if (!['add', 'remove', 'delete', 'clear', 'list', 'test', 'channel', 'ignore', 'unignore', 'ignored'].includes(action)) {
    return [action, ...rest].join(' ').trim();
  }

  return rest.join(' ').trim();
}

function prefixChannelArg(ctx) {
  return ctx.args.slice(1).join(' ').trim();
}

/** Case-insensitive name lookup that works on a Collection or a plain Map. */
function findCachedChannel(guild, name, predicate = () => true) {
  const wanted = name.toLowerCase();

  for (const channel of guild.channels.cache.values()) {
    if (channel.name?.toLowerCase() === wanted && predicate(channel)) return channel;
  }

  return null;
}

/** Like resolvePrefixChannel, but categories and voice channels are allowed. */
async function resolvePrefixAnyChannel(ctx, raw) {
  const cleaned = raw.replace(/^<#/, '').replace(/>$/, '').trim();

  if (!cleaned) return null;

  if (/^\d{15,20}$/.test(cleaned)) {
    return (
      ctx.guild.channels.cache.get(cleaned) ??
      (await ctx.guild.channels.fetch(cleaned).catch(() => null))
    );
  }

  return findCachedChannel(ctx.guild, cleaned.replace(/^#/, ''));
}

async function resolvePrefixChannel(ctx, raw) {
  const cleaned = raw.replace(/^<#/, '').replace(/>$/, '').trim();

  if (!cleaned) return null;

  if (/^\d{15,20}$/.test(cleaned)) {
    return (
      ctx.guild.channels.cache.get(cleaned) ??
      (await ctx.guild.channels.fetch(cleaned).catch(() => null))
    );
  }

  return findCachedChannel(ctx.guild, cleaned.replace(/^#/, ''), (channel) =>
    channel.isTextBased?.(),
  );
}

async function requireSendableChannel(ctx, channel) {
  if (!channel?.isTextBased?.() || channel.isDMBased?.()) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Not a text channel',
            'Pick a normal server channel, for example `/watch channel #mod-log`.',
          ),
        ],
      }),
    );
    return false;
  }

  const me = ctx.guild?.members?.me;
  const permissions = me ? channel.permissionsFor(me) : null;

  if (
    permissions &&
    !permissions.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])
  ) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'I cannot post there',
            `I need **View Channel**, **Send Messages** and **Embed Links** in ${channel}.`,
          ),
        ],
      }),
    );
    return false;
  }

  return true;
}

function channelSummary(ctx) {
  const channelId = getWatchChannelId(ctx.guildId);

  return channelId
    ? { channelId, text: `Alerts post in <#${channelId}>.` }
    : { channelId: null, text: '⚠️ No alert channel set — run `/watch channel #channel`.' };
}

function listPayload(ctx) {
  const terms = listWatchTerms(ctx.guildId);
  const { channelId, text } = channelSummary(ctx);

  if (terms.length === 0) {
    return embed({
      title: 'No keywords yet',
      description: [
        `Add one with \`${ctx.isSlash ? '/watch add keyword:leak' : ':-watch add leak'}\`.`,
        'The list is shared: any moderator can add or remove a word, and every alert goes to one channel.',
        '',
        channelId ? text : `⚠️ No alert channel set yet — run \`${ctx.isSlash ? '/watch channel' : ':-watch channel'} #channel\`.`,
      ].join('\n'),
      color: COLORS.muted,
    });
  }

  const shown = terms.slice(0, MAX_SHOWN);
  const lines = shown.map(
    (entry) => `\u200E- \`${entry.term}\` — added by <@${entry.createdBy}>`,
  );

  if (terms.length > shown.length) lines.push(`…and ${terms.length - shown.length} more`);

  return embed({
    title: `Watched keywords (${terms.length}/${MAX_WATCH_TERMS})`,
    description: lines.join('\n'),
    footer: channelId
      ? `${text} Every alert includes a jump link.`
      : 'No alert channel set — alerts will not be posted until one is chosen.',
    color: channelId ? COLORS.primary : COLORS.warning,
  });
}

async function handleAdd(ctx) {
  if (!(await requireModerator(ctx))) return;

  const term = extractTerm(ctx);

  if (term.length < MIN_TERM_LENGTH || term.length > MAX_TERM_LENGTH) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Invalid keyword',
            `Use ${MIN_TERM_LENGTH}–${MAX_TERM_LENGTH} characters, for example \`/watch add keyword:leak\`.`,
          ),
        ],
      }),
    );
    return;
  }

  const result = addWatchTerm(ctx.guildId, ctx.user.id, term);

  if (!result.added && result.reason === 'limit') {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Keyword list is full',
            `The server already watches ${countTerms(ctx.guildId)} words (max ${MAX_WATCH_TERMS}). Remove one first.`,
          ),
        ],
      }),
    );
    return;
  }

  if (!result.added && result.reason === 'duplicate') {
    await ctx.reply(
      ephemeral({
        embeds: [infoEmbed('Already watching', `\`${result.term}\` is already on the list.`)],
      }),
    );
    return;
  }

  invalidateWatchCache(ctx.guildId);

  const channelId = getWatchChannelId(ctx.guildId);

  await ctx.reply(
    ephemeral({
      embeds: [
        successEmbed(
          'Keyword added',
          channelId
            ? `I will post an alert in <#${channelId}> whenever \`${term}\` appears anywhere in this server.`
            : `\`${term}\` is now watched, but no alert channel is set yet — run \`/watch channel #channel\` or alerts will not be posted.`,
        ),
      ],
    }),
  );
}

async function handleRemove(ctx) {
  if (!(await requireModerator(ctx))) return;

  const term = extractTerm(ctx);

  if (!term) {
    await ctx.reply(
      ephemeral({
        embeds: [errorEmbed('Which keyword?', 'Use `/watch remove keyword:word` or `:-watch remove word`.')],
      }),
    );
    return;
  }

  const existing = findTerm(ctx.guildId, term);
  const removed = existing ? removeWatchTerm(ctx.guildId, term) : 0;

  invalidateWatchCache(ctx.guildId);

  await ctx.reply(
    ephemeral({
      embeds: [
        removed > 0
          ? successEmbed('Keyword removed', `\`${existing.term}\` is no longer watched.`)
          : infoEmbed('Not on the list', `\`${term}\` was not being watched.`),
      ],
    }),
  );
}

async function handleClear(ctx) {
  if (!(await requireModerator(ctx))) return;

  const removed = clearWatchTerms(ctx.guildId);

  invalidateWatchCache(ctx.guildId);

  await ctx.reply(
    ephemeral({
      embeds: [
        removed > 0
          ? successEmbed('Keywords cleared', `Removed ${removed} keyword${removed === 1 ? '' : 's'}.`)
          : infoEmbed('Nothing to clear', 'The keyword list was already empty.'),
      ],
    }),
  );
}

async function handleChannel(ctx) {
  if (!(await requireAdmin(ctx))) return;

  if (ctx.isSlash) {
    const channel = ctx.getChannel('channel');

    if (!channel) {
      setWatchChannelId(ctx.guildId, null);
      invalidateWatchCache(ctx.guildId);

      await ctx.reply(
        ephemeral({
          embeds: [
            successEmbed('Alerts are off', 'No channel will receive keyword alerts until one is set.'),
          ],
        }),
      );
      return;
    }

    if (!(await requireSendableChannel(ctx, channel))) return;

    setWatchChannelId(ctx.guildId, channel.id);
    invalidateWatchCache(ctx.guildId);

    await ctx.reply(
      ephemeral({
        embeds: [
          successEmbed('Alert channel saved', `Keyword alerts will be posted in ${channel}.`),
        ],
      }),
    );
    return;
  }

  const raw = prefixChannelArg(ctx);

  if (!raw || OFF_WORDS.includes(raw.toLowerCase())) {
    setWatchChannelId(ctx.guildId, null);
    invalidateWatchCache(ctx.guildId);

    await ctx.reply(
      ephemeral({
        embeds: [
          successEmbed('Alerts are off', 'No channel will receive keyword alerts until one is set.'),
        ],
      }),
    );
    return;
  }

  const channel = await resolvePrefixChannel(ctx, raw).catch(() => null);

  if (!channel) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Unknown channel',
            `I could not find \`${raw}\`. Mention it as \`#channel\` or paste the channel id.`,
          ),
        ],
      }),
    );
    return;
  }

  if (!(await requireSendableChannel(ctx, channel))) return;

  setWatchChannelId(ctx.guildId, channel.id);
  invalidateWatchCache(ctx.guildId);

  await ctx.reply(
    ephemeral({
      embeds: [
        successEmbed('Alert channel saved', `Keyword alerts will be posted in ${channel}.`),
      ],
    }),
  );
}

async function handleTest(ctx) {
  if (!(await requireModerator(ctx))) return;

  const channelId = getWatchChannelId(ctx.guildId);

  if (!channelId) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'No alert channel',
            'Run `/watch channel #channel` first, then test again.',
          ),
        ],
      }),
    );
    return;
  }

  let channel;

  try {
    channel = await ctx.guild.channels.fetch(channelId);
  } catch (error) {
    logger.warn(`Watch test could not load channel ${channelId}: ${error.message}`);
    channel = null;
  }

  if (!channel?.isTextBased?.()) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Channel is missing',
            'The saved alert channel no longer exists. Choose another with `/watch channel #channel`.',
          ),
        ],
      }),
    );
    return;
  }

  try {
    await channel.send({
      allowedMentions: { parse: [] },
      embeds: [
        embed({
          title: 'Keyword alerts are working',
          description: [
            'This is where a moderator will see a watched word being mentioned.',
            'Every alert includes the keyword, the author, a quote and a jump link.',
          ].join('\n'),
          color: COLORS.success,
        }),
      ],
    });

    await ctx.reply(
      ephemeral({
        embeds: [successEmbed('Test sent', `Check ${channel} — the alert layout is posted there.`)],
      }),
    );
  } catch (error) {
    logger.warn(`Watch test to channel ${channelId} failed: ${error.message}`);

    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Could not post there',
            'I need **View Channel**, **Send Messages** and **Embed Links** in the alert channel.',
          ),
        ],
      }),
    );
  }
}

function ignoredPayload(ctx) {
  const rows = listIgnoredChannels(ctx.guildId);

  if (rows.length === 0) {
    return embed({
      title: 'No ignored channels',
      description: [
        'Watched words trigger alerts in every channel.',
        `Ignore one with \`${ctx.isSlash ? '/watch ignore channel:#channel' : ':-watch ignore #channel'}\`.`,
        'Ignoring a category covers every channel inside it.',
      ].join('\n'),
      color: COLORS.muted,
    });
  }

  const shown = rows.slice(0, MAX_SHOWN);
  const lines = shown.map((row) => {
    const channel = ctx.guild.channels.cache.get(row.channelId);

    return channel
      ? `\u200E- <#${row.channelId}> — added by <@${row.createdBy}>`
      : `\u200E- ⚠️ \`${row.channelId}\` — channel deleted`;
  });

  if (rows.length > shown.length) lines.push(`…and ${rows.length - shown.length} more`);

  return embed({
    title: `Ignored channels (${rows.length})`,
    description: lines.join('\n'),
    footer: 'Watched words in these channels never trigger an alert.',
    color: COLORS.primary,
  });
}

async function resolveIgnoreTarget(ctx) {
  if (ctx.isSlash) {
    return { channel: ctx.getChannel('channel'), raw: '' };
  }

  const raw = prefixChannelArg(ctx);

  if (!raw) return { channel: null, raw };

  return { channel: await resolvePrefixAnyChannel(ctx, raw).catch(() => null), raw };
}

async function handleIgnore(ctx) {
  if (!(await requireModerator(ctx))) return;

  const { channel, raw } = await resolveIgnoreTarget(ctx);

  // Slash without the option lists the current ignores, so `/watch ignore`
  // doubles as the read command.
  if (!channel) {
    if (!raw) {
      await ctx.reply(ephemeral({ embeds: [ignoredPayload(ctx)] }));
      return;
    }

    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Unknown channel',
            `I could not find \`${raw}\`. Mention it as \`#channel\` or paste the channel id.`,
          ),
        ],
      }),
    );
    return;
  }

  if ((channel.guildId ?? channel.guild?.id) !== ctx.guildId) {
    await ctx.reply(
      ephemeral({
        embeds: [errorEmbed('Wrong server', 'Pick a channel from this server.')],
      }),
    );
    return;
  }

  if (!addIgnoredChannel(ctx.guildId, channel.id, ctx.user.id)) {
    await ctx.reply(
      ephemeral({
        embeds: [infoEmbed('Already ignored', `${channel} never triggers a keyword alert.`)],
      }),
    );
    return;
  }

  invalidateWatchCache(ctx.guildId);

  const isCategory = channel.type === ChannelType.GuildCategory;

  await ctx.reply(
    ephemeral({
      embeds: [
        successEmbed(
          'Channel ignored',
          isCategory
            ? `Watched words in ${channel} and every channel inside it no longer trigger an alert.`
            : `Watched words in ${channel} no longer trigger an alert.`,
        ),
      ],
    }),
  );
}

async function handleUnignore(ctx) {
  if (!(await requireModerator(ctx))) return;

  const { channel, raw } = await resolveIgnoreTarget(ctx);

  if (!channel) {
    await ctx.reply(
      ephemeral({
        embeds: [
          raw
            ? errorEmbed(
                'Unknown channel',
                `I could not find \`${raw}\`. Mention it as \`#channel\` or paste the channel id.`,
              )
            : errorEmbed(
                'Which channel?',
                `Use \`${ctx.isSlash ? '/watch unignore channel:#channel' : ':-watch unignore #channel'}\`.`,
              ),
        ],
      }),
    );
    return;
  }

  if (removeIgnoredChannel(ctx.guildId, channel.id) === 0) {
    await ctx.reply(
      ephemeral({
        embeds: [infoEmbed('Not ignored', `${channel} already triggers alerts.`)],
      }),
    );
    return;
  }

  invalidateWatchCache(ctx.guildId);

  await ctx.reply(
    ephemeral({
      embeds: [
        successEmbed('Channel watched again', `${channel} will trigger keyword alerts again.`),
      ],
    }),
  );
}

async function handleIgnored(ctx) {
  if (!(await requireModerator(ctx))) return;

  await ctx.reply(ephemeral({ embeds: [ignoredPayload(ctx)] }));
}

export default {
  data: new SlashCommandBuilder()
    .setName('watch')
    .setDescription('Post an alert in a channel when a keyword is mentioned')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Watch a word or phrase')
        .addStringOption((option) =>
          option
            .setName('keyword')
            .setDescription('Word or short phrase')
            .setRequired(true)
            .setMinLength(MIN_TERM_LENGTH)
            .setMaxLength(MAX_TERM_LENGTH),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Stop watching a word')
        .addStringOption((option) =>
          option.setName('keyword').setDescription('Word to stop watching').setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Show the shared keyword list'))
    .addSubcommand((sub) => sub.setName('clear').setDescription('Remove every keyword'))
    .addSubcommand((sub) =>
      sub
        .setName('channel')
        .setDescription('Choose where alerts are posted (leave empty to turn alerts off)')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Alert channel')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((sub) => sub.setName('test').setDescription('Post a test alert in the channel'))
    .addSubcommand((sub) =>
      sub
        .setName('ignore')
        .setDescription('Never alert on words in a channel or category')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Channel or category to ignore (leave empty to list them)'),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('unignore')
        .setDescription('Alert on words in a channel again')
        .addChannelOption((option) =>
          option
            .setName('channel')
            .setDescription('Channel or category to watch again')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('ignored').setDescription('Show ignored channels')),

  name: 'watch',
  aliases: ['alert', 'keywords'],
  description: 'Post an alert in a channel when a keyword is mentioned',
  category: 'Community',
  usage:
    'watch add <keyword> | remove <keyword> | list | clear | channel <#channel|off> | test | ignore [#channel] | unignore #channel | ignored',
  cooldown: 3,
  guildOnly: true,

  async execute(ctx) {
    const sub = ctx.isSlash
      ? ctx.getSubcommand()
      : ['add', 'remove', 'delete', 'list', 'clear', 'test', 'channel', 'ignore', 'unignore', 'ignored'].includes(ctx.args[0])
        ? ctx.args[0]
        : 'add';

    if (sub === 'add') return handleAdd(ctx);
    if (sub === 'remove' || sub === 'delete') return handleRemove(ctx);
    if (sub === 'clear') return handleClear(ctx);
    if (sub === 'channel') return handleChannel(ctx);
    if (sub === 'test') return handleTest(ctx);
    if (sub === 'ignore') return handleIgnore(ctx);
    if (sub === 'unignore') return handleUnignore(ctx);
    if (sub === 'ignored') return handleIgnored(ctx);

    await ctx.reply(ephemeral({ embeds: [listPayload(ctx)] }));
  },
};
