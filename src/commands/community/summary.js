import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from '../../config.js';
import { COLORS, embed, errorEmbed, infoEmbed, successEmbed } from '../../lib/embeds.js';
import { createLogger } from '../../lib/logger.js';
import { AiError, aiConfigured, aiProblemHint } from '../../lib/ai.js';
import { getGuildSettings } from '../../services/birthday-store.js';
import {
  getSummary,
  getSummaryChannel,
  listSummaries,
  saveSummary,
  setSummaryChannel,
} from '../../services/report-store.js';
import {
  exportPayload,
  produceSummary,
  reportPayload,
} from '../../services/report-runner.js';
import { KIND_KEYS, SUMMARY_KINDS, KIND_ALIASES } from '../../services/summary.js';

const logger = createLogger('summary');

const MAX_HOURS = 168;
const DEFAULT_HOURS = 24;

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

function kindChoices() {
  return KIND_KEYS.map((key) => ({ name: SUMMARY_KINDS[key].brief, value: key }));
}

function styleList() {
  return KIND_KEYS.map((key) => `\`${key}\``).join(', ');
}

function durationLabel(hours) {
  if (hours % 24 === 0) {
    const days = hours / 24;
    return `${days} day${days === 1 ? '' : 's'}`;
  }

  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

async function requireManageGuild(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await ctx.reply(
    ephemeral({
      embeds: [errorEmbed('Missing permissions', 'You need **Manage Server** to change this setting.')],
    }),
  );

  return false;
}

/** Resolves `#channel`, a raw id, or nothing (the current channel). */
async function resolveChannel(ctx, id) {
  if (!id) return ctx.channel;

  const cached = ctx.guild.channels.cache.get(id);

  if (cached) return cached;

  return ctx.guild.channels.fetch(id).catch(() => null);
}

function slashParams(ctx) {
  return {
    channelId: ctx.getChannel('channel')?.id ?? null,
    hours: ctx.getInteger('hours') ?? DEFAULT_HOURS,
    kind: ctx.getString('kind') ?? 'general',
    prompt: ctx.getString('prompt') ?? '',
    isPrivate: ctx.getBoolean('private') === true,
  };
}

/**
 * `:-summary [#channel] [hours|Nd] [general|tasks|ask] [private] [focus…]` in any
 * order. A leading `run` / `channel` / `export` / `history` picks the action.
 */
function parsePrefix(ctx) {
  const tokens = [...ctx.args];
  let channelId = null;
  let hours = DEFAULT_HOURS;
  let kind = 'general';
  let isPrivate = false;
  const prompt = [];

  for (const token of tokens) {
    const mention = /^<#(\d{17,20})>$/.exec(token);

    if (mention) {
      channelId ??= mention[1];
      continue;
    }

    if (/^\d{17,20}$/.test(token) && !channelId) {
      channelId = token;
      continue;
    }

    const duration = /^(\d{1,3})(h|d)?$/i.exec(token);

    if (duration) {
      const value = Number.parseInt(duration[1], 10);
      hours = duration[2]?.toLowerCase() === 'd' ? value * 24 : value;
      continue;
    }

    const alias = KIND_ALIASES[token.toLowerCase()];

    if (alias && kind === 'general') {
      kind = alias;
      continue;
    }

    if (/^(private|me|silent)$/i.test(token)) {
      isPrivate = true;
      continue;
    }

    prompt.push(token);
  }

  return { channelId, hours, kind, prompt: prompt.join(' ').trim(), isPrivate };
}

async function handleRun(ctx) {
  if (!aiConfigured()) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'AI is not configured',
            [
              'Add these to the server environment, then restart:',
              '```',
              'AI_API_KEY=your-key',
              'AI_MODEL=gemini-3.6-flash',
              '# optional, defaults to Google:',
              'AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai',
              '```',
              'Any OpenAI-compatible provider works (OpenAI, OpenRouter, Groq, DeepSeek, local).',
            ].join('\n'),
          ),
        ],
      }),
    );
    return;
  }

  const params = ctx.isSlash ? slashParams(ctx) : parsePrefix(ctx);
  const hours = params.hours;

  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed('Invalid time window', `Use 1 to ${MAX_HOURS} hours, for example \`24\` or \`2d\`.`),
        ],
      }),
    );
    return;
  }

  if (!KIND_KEYS.includes(params.kind)) {
    await ctx.reply(
      ephemeral({ embeds: [errorEmbed('Unknown summary type', `Pick one of: ${styleList()}.`)] }),
    );
    return;
  }

  if (params.kind === 'targeted' && !params.prompt?.trim()) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'What should I look for?',
            'A targeted summary needs a focus, e.g. `/summary run kind:Targeted prompt:the new spawn rules`.',
          ),
        ],
      }),
    );
    return;
  }

  const channel = await resolveChannel(ctx, params.channelId);

  if (!channel) {
    await ctx.reply(ephemeral({ embeds: [errorEmbed('Channel not found', 'Pick a channel I can see.')] }));
    return;
  }

  const me = ctx.guild.members.me;
  const permissions = channel.permissionsFor?.(me);

  if (
    !permissions?.has(PermissionFlagsBits.ViewChannel) ||
    !permissions?.has(PermissionFlagsBits.ReadMessageHistory)
  ) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Missing permissions',
            `I need **View Channel** and **Read Message History** in ${channel}.`,
          ),
        ],
      }),
    );
    return;
  }

  const now = Date.now();
  const since = now - hours * 60 * 60 * 1000;
  const timeZone = getGuildSettings(ctx.guildId).timezone ?? config.timezone;
  const working = { content: `🔎 Reading ${channel}…`, allowedMentions: { parse: [] } };

  if (ctx.isSlash) {
    await ctx.defer({ ephemeral: params.isPrivate });
    await ctx.editReply(working);
  } else {
    await ctx.reply(working);
  }

  let lastUpdate = Date.now();

  const onProgress = async (part, total) => {
    if (Date.now() - lastUpdate < 2500) return;
    lastUpdate = Date.now();
    await ctx
      .editReply({ content: `🧠 Summarizing part ${part}/${total}…`, allowedMentions: { parse: [] } })
      .catch(() => {});
  };

  let result;

  try {
    result = await produceSummary({
      guildId: ctx.guildId,
      channel,
      kind: params.kind,
      prompt: params.prompt || null,
      since,
      until: now,
      timeZone,
      requestedBy: ctx.user.username,
      onProgress,
    });
  } catch (error) {
    if (error instanceof AiError) {
      await ctx.editReply({ embeds: [errorEmbed('Summary failed', aiProblemHint(error))] });
      return;
    }

    logger.warn(`Could not read #${channel.name}: ${error.message}`);
    await ctx.editReply({
      embeds: [errorEmbed('Could not read messages', "I was unable to fetch that channel's history.")],
    });
    return;
  }

  if (!result.data) {
    await ctx.editReply({
      embeds: [
        errorEmbed(
          'Nothing to summarize',
          result.reason === 'empty-summary'
            ? `${channel} had messages, but the model found nothing worth reporting — no topics, decisions, requests or questions. Try a longer window, or a Targeted summary with a focus.`
            : `No messages in ${channel} in the last ${durationLabel(hours)}.`,
        ),
      ],
    });
    return;
  }

  const { data, collected, meta } = result;
  const id = saveSummary({
    guildId: ctx.guildId,
    channelId: channel.id,
    kind: params.kind,
    prompt: params.prompt || null,
    rangeStart: meta.rangeStart,
    rangeEnd: meta.rangeEnd,
    messageCount: meta.messageCount,
    body: data,
    createdBy: ctx.user.id,
  });

  const payload = reportPayload({ data, meta, id, collected });
  const destinationId = getSummaryChannel(ctx.guildId);
  const destination = destinationId ? await resolveChannel(ctx, destinationId) : ctx.channel;

  const showHere = params.isPrivate || !destination || destination.id === ctx.channel.id;

  try {
    if (showHere) {
      await ctx.editReply(payload);
      return;
    }

    await destination.send(payload);

    await ctx.editReply({
      embeds: [
        successEmbed(
          'Summary posted',
          `${SUMMARY_KINDS[params.kind].label} summary of ${channel} sent to ${destination}.`,
        ),
      ],
    });
  } catch (error) {
    logger.warn(`Could not deliver the summary: ${error.message}`);
    await ctx.editReply({
      embeds: [
        errorEmbed('Could not deliver the summary', 'I may be missing **Send Messages** in that channel.'),
      ],
    });
  }
}

async function handleChannel(ctx) {
  if (!(await requireManageGuild(ctx))) return;

  const id = ctx.isSlash ? (ctx.getChannel('channel')?.id ?? null) : (ctx.args[0] ?? null);
  const mention = id ? (/^<#(\d{17,20})>$/.exec(id)?.[1] ?? id) : null;

  if (!mention) {
    const current = getSummaryChannel(ctx.guildId);

    await ctx.reply(
      ephemeral({
        embeds: [
          infoEmbed(
            'Summary channel',
            current
              ? `Reports are delivered to <#${current}>.\nChange it with \`/summary channel channel:#room\` or clear it with \`/summary channel\`.`
              : 'No summary channel is set, so each report is posted where the command was run.\nSet one with `/summary channel channel:#management`.',
          ),
        ],
      }),
    );
    return;
  }

  const channel = await resolveChannel(ctx, mention);

  if (!channel) {
    await ctx.reply(ephemeral({ embeds: [errorEmbed('Channel not found', 'Pick a text channel.')] }));
    return;
  }

  setSummaryChannel(ctx.guildId, channel.id);

  await ctx.reply(
    ephemeral({
      embeds: [successEmbed('Summary channel set', `Reports are now delivered to ${channel}.`)],
    }),
  );
}

async function handleExport(ctx) {
  const raw = ctx.isSlash ? ctx.getString('id') : ctx.args[0];
  const id = raw ? Number.parseInt(raw, 10) : null;
  const summary = id
    ? getSummary(ctx.guildId, id)
    : listSummaries(ctx.guildId, 1)[0] ?? null;

  if (!summary) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'No report found',
            id
              ? `There is no report #${id} in this server.`
              : 'Run `/summary run` first, then export it.',
          ),
        ],
      }),
    );
    return;
  }

  const timeZone = getGuildSettings(ctx.guildId).timezone ?? config.timezone;
  const payload = exportPayload(summary, timeZone);

  await ctx.reply(ctx.isSlash ? ephemeral(payload) : payload);
}

async function handleHistory(ctx) {
  const reports = listSummaries(ctx.guildId, 10);

  if (reports.length === 0) {
    await ctx.reply(ephemeral({ embeds: [infoEmbed('No reports yet', 'Run `/summary run` to make one.')] }));
    return;
  }

  const lines = reports.map(
    (report) =>
      `\`#${report.id}\` · ${SUMMARY_KINDS[report.kind]?.emoji ?? ''} ${SUMMARY_KINDS[report.kind]?.label ?? report.kind} · <#${report.channelId}> · ${report.messageCount} msg · <t:${Math.floor(report.createdAt / 1000)}:R>`,
  );

  await ctx.reply(
    ephemeral({
      embeds: [
        embed({
          title: 'Recent reports',
          description: lines.join('\n'),
          footer: 'Export any of them with /summary export id:<n>',
          color: COLORS.primary,
        }),
      ],
    }),
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('summary')
    .setDescription('Summarize a channel with AI and post the report to your management channel')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((sub) =>
      sub
        .setName('run')
        .setDescription('Summarize a window of a channel')
        .addChannelOption((option) =>
          option.setName('channel').setDescription('Channel to summarize').setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName('hours')
            .setDescription(`How far back to look (1-${MAX_HOURS}, default ${DEFAULT_HOURS})`)
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(MAX_HOURS),
        )
        .addStringOption((option) =>
          option
            .setName('kind')
            .setDescription('What kind of summary (default: General)')
            .setRequired(false)
            .addChoices(...kindChoices()),
        )
        .addStringOption((option) =>
          option
            .setName('prompt')
            .setDescription('For Targeted summaries: what should I look for?')
            .setRequired(false)
            .setMaxLength(500),
        )
        .addBooleanOption((option) =>
          option.setName('private').setDescription('Only show the report to me').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('channel')
        .setDescription('Pick the channel that receives reports (empty shows the current one)')
        .addChannelOption((option) =>
          option.setName('channel').setDescription('Where reports are delivered').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('export')
        .setDescription('Download a report as an HTML file (print it to PDF)')
        .addIntegerOption((option) =>
          option.setName('id').setDescription('Report id (default: the latest)').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('history').setDescription('List the most recent reports'),
    ),

  name: 'summary',
  aliases: ['summarize', 'report'],
  description: 'Summarize a channel and deliver the report to your management channel',
  category: 'Community',
  usage: 'summary [#channel] [24h] [general|tasks|ask <focus>] [private]',
  cooldown: 5,
  guildOnly: true,
  permissions: ['ManageMessages'],

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);

    if (focused.name !== 'kind') return;

    const matches = kindChoices().filter((choice) =>
      choice.name.toLowerCase().includes(String(focused.value).toLowerCase()),
    );

    await interaction.respond(matches.slice(0, 25));
  },

  async execute(ctx) {
    let sub = 'run';

    if (ctx.isSlash) {
      sub = ctx.getSubcommand();
    } else if (ctx.args[0] === 'run') {
      ctx.args.shift();
    } else if (['channel', 'export', 'history'].includes(ctx.args[0])) {
      sub = ctx.args.shift();
    }

    if (sub === 'channel') return handleChannel(ctx);
    if (sub === 'export') return handleExport(ctx);
    if (sub === 'history') return handleHistory(ctx);

    return handleRun(ctx);
  },
};
