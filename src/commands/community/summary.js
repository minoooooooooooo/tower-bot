import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from '../../config.js';
import { COLORS, embed, errorEmbed, infoEmbed, successEmbed } from '../../lib/embeds.js';
import { createLogger } from '../../lib/logger.js';
import { aiConfigured, aiProblemHint } from '../../lib/ai.js';
import { getGuildSettings } from '../../services/birthday-store.js';
import {
  getSummary,
  getSummaryChannel,
  glossaryPrompt,
  listSummaries,
  saveSummary,
  setSummaryChannel,
} from '../../services/report-store.js';
import { buildSummaryHtml } from '../../services/report-export.js';
import {
  KIND_KEYS,
  SUMMARY_KINDS,
  renderSummary,
  summarizeTranscript,
} from '../../services/summary.js';
import { buildTranscript, collectRangeMessages } from '../../services/summary-source.js';

const logger = createLogger('summary');

const MAX_HOURS = 168;
const DEFAULT_HOURS = 24;
const LIST_TIMEOUT_MS = 5 * 60 * 1000;

const KIND_ALIASES = {
  general: 'general',
  g: 'general',
  topics: 'general',
  tasks: 'tasks',
  task: 'tasks',
  items: 'tasks',
  todo: 'tasks',
  targeted: 'targeted',
  ask: 'targeted',
  focus: 'targeted',
};

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
 * `:-summary [#channel] [hours|Nd] [general|tasks|ask] [private] [focusâ€¦]` in any
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

function exportButton(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`summary:export:${id}`)
      .setLabel('Export as HTML')
      .setEmoji('ðŸ“„')
      .setStyle(ButtonStyle.Secondary),
  );
}

function exportPayload(summary, timeZone) {
  const { buffer, filename } = buildSummaryHtml({
    data: summary.body,
    meta: {
      kind: summary.kind,
      channelId: summary.channelId,
      channelName: null,
      messageCount: summary.messageCount,
      rangeStart: summary.rangeStart,
      rangeEnd: summary.rangeEnd,
      model: config.ai.model,
      requestedBy: `<@${summary.createdBy}>`,
      prompt: summary.prompt,
      timeZone,
      generatedAt: summary.createdAt,
    },
  });

  return {
    embeds: [
      infoEmbed(
        'Report exported',
        `The HTML file opens in any browser. Use **Print â†’ Save as PDF** for a PDF copy.`,
      ),
    ],
    files: [new AttachmentBuilder(buffer, { name: filename })],
  };
}

function attachExportButton({ message, summary, timeZone, ownerId }) {
  if (!message?.createMessageComponentCollector) return;

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: LIST_TIMEOUT_MS,
  });

  collector.on('collect', async (interaction) => {
    const canExport = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages);

    if (!canExport && interaction.user.id !== ownerId) {
      await interaction
        .reply(ephemeral({ embeds: [errorEmbed('Not allowed', 'Only moderators can export this.')] }))
        .catch(() => {});
      return;
    }

    try {
      await interaction.reply(ephemeral(exportPayload(summary, timeZone)));
    } catch (error) {
      logger.warn(`Export failed: ${error.message}`);
    }
  });

  collector.on('end', () => {
    message.edit({ components: [] }).catch(() => {});
  });
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
              'AI_MODEL=gemini-2.5-flash',
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
  const working = { content: `ðŸ”Ž Reading ${channel}â€¦`, allowedMentions: { parse: [] } };

  if (ctx.isSlash) {
    await ctx.defer({ ephemeral: params.isPrivate });
    await ctx.editReply(working);
  } else {
    await ctx.reply(working);
  }

  let collected;

  try {
    collected = await collectRangeMessages(channel, { since });
  } catch (error) {
    logger.warn(`Could not read #${channel.name}: ${error.message}`);
    await ctx.editReply({
      embeds: [errorEmbed('Could not read messages', 'I was unable to fetch that channel\'s history.')],
    });
    return;
  }

  if (collected.messages.length === 0) {
    await ctx.editReply({
      embeds: [
        errorEmbed(
          'Nothing to summarize',
          `No messages in ${channel} in the last ${durationLabel(hours)}.`,
        ),
      ],
    });
    return;
  }

  const transcript = buildTranscript(collected.messages, { timeZone });
  const glossary = glossaryPrompt(ctx.guildId);
  let lastUpdate = Date.now();

  const onProgress = async (part, total) => {
    if (Date.now() - lastUpdate < 2500) return;
    lastUpdate = Date.now();
    await ctx
      .editReply({ content: `ðŸ§  Summarizing part ${part}/${total}â€¦`, allowedMentions: { parse: [] } })
      .catch(() => {});
  };

  let data;

  try {
    data = await summarizeTranscript({
      transcript,
      kind: params.kind,
      prompt: params.prompt,
      glossary,
      onProgress,
    });
  } catch (error) {
    await ctx.editReply({
      embeds: [errorEmbed('Summary failed', aiProblemHint(error))],
    });
    return;
  }

  const meta = {
    kind: params.kind,
    channelId: channel.id,
    channelName: channel.name,
    messageCount: collected.messages.length,
    rangeStart: since,
    rangeEnd: now,
    model: config.ai.model,
    requestedBy: ctx.user.username,
    prompt: params.prompt || null,
    timeZone,
  };

  const id = saveSummary({
    guildId: ctx.guildId,
    channelId: channel.id,
    kind: params.kind,
    prompt: params.prompt || null,
    rangeStart: since,
    rangeEnd: now,
    messageCount: collected.messages.length,
    body: data,
    createdBy: ctx.user.id,
  });

  const { embeds } = renderSummary({ data, meta });
  const notes = [];

  if (collected.truncated) {
    notes.push(`Scanned the newest ${collected.scanned} messages only â€” narrow the window for full coverage.`);
  }

  if (notes.length > 0) {
    embeds[embeds.length - 1].setFooter({ text: notes.join(' ').slice(0, 200) });
  }

  const payload = {
    embeds,
    components: [exportButton(id)],
    allowedMentions: { parse: [] },
  };

  const destinationId = getSummaryChannel(ctx.guildId);
  const destination = destinationId ? await resolveChannel(ctx, destinationId) : ctx.channel;

  try {
    if (params.isPrivate || !destination) {
      const message = await ctx.editReply(payload);

      attachExportButton({
        message,
        summary: getSummary(ctx.guildId, id),
        timeZone,
        ownerId: ctx.user.id,
      });
      return;
    }

    if (destination.id === ctx.channel.id) {
      const message = await ctx.editReply(payload);

      attachExportButton({
        message,
        summary: getSummary(ctx.guildId, id),
        timeZone,
        ownerId: ctx.user.id,
      });
      return;
    }

    const sent = await destination.send(payload);

    attachExportButton({
      message: sent,
      summary: getSummary(ctx.guildId, id),
      timeZone,
      ownerId: ctx.user.id,
    });

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
      `\`#${report.id}\` Â· ${SUMMARY_KINDS[report.kind]?.emoji ?? ''} ${SUMMARY_KINDS[report.kind]?.label ?? report.kind} Â· <#${report.channelId}> Â· ${report.messageCount} msg Â· <t:${Math.floor(report.createdAt / 1000)}:R>`,
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
