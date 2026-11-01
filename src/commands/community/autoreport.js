import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from '../../config.js';
import { COLORS, embed, errorEmbed, infoEmbed, successEmbed } from '../../lib/embeds.js';
import { createLogger } from '../../lib/logger.js';
import { aiConfigured } from '../../lib/ai.js';
import { getGuildSettings } from '../../services/birthday-store.js';
import {
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  getSchedule,
  getSummaryChannel,
  listSchedules,
  removeSchedule,
  setScheduleEnabled,
  upsertSchedule,
} from '../../services/report-store.js';
import { KIND_ALIASES, KIND_KEYS, SUMMARY_KINDS } from '../../services/summary.js';
import {
  formatClock,
  formatInterval,
  nextRunAt,
  parseClock,
  parseInterval,
} from '../../services/summary-scheduler.js';

const logger = createLogger('autoreport');

const MAX_SCHEDULES = 10;
const MAX_PROMPT = 500;

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

async function requireManageGuild(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await ctx.reply(
    ephemeral({
      embeds: [errorEmbed('Missing permissions', 'You need **Manage Server** to schedule reports.')],
    }),
  );

  return false;
}

async function resolveChannel(ctx, id) {
  if (!id) return null;

  const cached = ctx.guild.channels.cache.get(id);

  if (cached) return cached;

  return ctx.guild.channels.fetch(id).catch(() => null);
}

function timeZoneFor(guildId) {
  return getGuildSettings(guildId).timezone ?? config.timezone;
}

function stamp(ms) {
  return `<t:${Math.floor(ms / 1000)}:F> (<t:${Math.floor(ms / 1000)}:R>)`;
}

function cadenceLabel(schedule) {
  return schedule.mode === 'daily'
    ? `every day at ${formatClock(schedule.minuteOfDay)}`
    : `every ${formatInterval(schedule.intervalMs)}`;
}

function kindLabel(kind) {
  return `${SUMMARY_KINDS[kind]?.emoji ?? ''} ${SUMMARY_KINDS[kind]?.label ?? kind}`.trim();
}

/**
 * `set #channel 6h [kind] [focus…]` or `set #channel 09:00 [kind] [focus…]`.
 * A token with a colon is a wall-clock time, otherwise a duration.
 */
function parsePrefixSet(ctx) {
  const tokens = [...ctx.args];
  let channelId = null;
  let intervalMs = null;
  let minuteOfDay = null;
  let kind = 'general';
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

    if (intervalMs === null && minuteOfDay === null) {
      const clock = parseClock(token);

      if (clock !== null) {
        minuteOfDay = clock;
        continue;
      }

      const interval = parseInterval(token);

      if (interval !== null) {
        intervalMs = interval;
        continue;
      }
    }

    const alias = KIND_ALIASES[token.toLowerCase()];

    if (alias && kind === 'general') {
      kind = alias;
      continue;
    }

    prompt.push(token);
  }

  return {
    channelId,
    intervalMs,
    minuteOfDay,
    kind,
    prompt: prompt.join(' ').trim(),
    rawEvery: null,
    rawTime: null,
  };
}

function setOptions(ctx) {
  if (ctx.isSlash) {
    const rawEvery = (ctx.getString('every') ?? '').trim();
    const rawTime = (ctx.getString('time') ?? '').trim();

    return {
      channelId: ctx.getChannel('channel')?.id ?? null,
      intervalMs: rawEvery ? parseInterval(rawEvery) : null,
      minuteOfDay: rawTime ? parseClock(rawTime) : null,
      kind: (ctx.getString('kind') ?? 'general').toLowerCase(),
      prompt: (ctx.getString('prompt') ?? '').trim(),
      rawEvery,
      rawTime,
    };
  }

  return parsePrefixSet(ctx);
}

async function handleSet(ctx) {
  if (!(await requireManageGuild(ctx))) return;

  if (!aiConfigured()) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'AI is not configured',
            'A schedule needs the summarizer. Add `AI_API_KEY` to the server environment and restart.',
          ),
        ],
      }),
    );
    return;
  }

  const options = setOptions(ctx);

  if (!options.channelId) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Which channel?',
            ctx.isSlash
              ? 'Pick the channel to summarize.'
              : 'Mention the channel, e.g. `:-autoreport set #general 6h`.',
          ),
        ],
      }),
    );
    return;
  }

  if (options.rawEvery && options.intervalMs === null) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Invalid interval',
            `Use minutes, hours or days from ${formatInterval(MIN_INTERVAL_MS)} to ${formatInterval(MAX_INTERVAL_MS)}: \`90m\`, \`6h\`, \`2d\`.`,
          ),
        ],
      }),
    );
    return;
  }

  if (options.rawTime && options.minuteOfDay === null) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed('Invalid time', 'Use 24-hour `HH:MM`, for example `09:00` or `21:30`.'),
        ],
      }),
    );
    return;
  }

  const hasInterval = options.intervalMs !== null && options.intervalMs !== undefined;
  const hasDaily = options.minuteOfDay !== null && options.minuteOfDay !== undefined;

  if (hasInterval === hasDaily) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Pick one cadence',
            [
              'Give **either** an interval **or** a time of day:',
              '`:-autoreport set #general 6h` — every six hours',
              '`:-autoreport set #general 09:00` — every day at 09:00 server time',
              `Intervals run from ${formatInterval(MIN_INTERVAL_MS)} to ${formatInterval(MAX_INTERVAL_MS)}.`,
            ].join('\n'),
          ),
        ],
      }),
    );
    return;
  }

  const kind = KIND_ALIASES[options.kind] ?? options.kind;

  if (!KIND_KEYS.includes(kind)) {
    await ctx.reply(
      ephemeral({
        embeds: [errorEmbed('Unknown summary type', `Pick one of: ${KIND_KEYS.join(', ')}.`)],
      }),
    );
    return;
  }

  if (kind === 'targeted' && !options.prompt) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'A targeted schedule needs a focus',
            'For example `:-autoreport set #general 09:00 ask the event schedule`.',
          ),
        ],
      }),
    );
    return;
  }

  if (options.prompt.length > MAX_PROMPT) {
    await ctx.reply(
      ephemeral({ embeds: [errorEmbed('Focus is too long', `Keep it under ${MAX_PROMPT} characters.`)] }),
    );
    return;
  }

  const destinationId = getSummaryChannel(ctx.guildId);

  if (!destinationId) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'No summary channel yet',
            'Set where reports are delivered first: `/summary channel channel:#management`, then schedule. Otherwise a scheduled report would land in the channel it reads.',
          ),
        ],
      }),
    );
    return;
  }

  const source = await resolveChannel(ctx, options.channelId);
  const destination = await resolveChannel(ctx, destinationId);

  if (!source || !destination) {
    await ctx.reply(
      ephemeral({ embeds: [errorEmbed('Channel not found', 'Pick channels I can see.')] }),
    );
    return;
  }

  const me = ctx.guild.members.me;
  const sourcePermissions = me ? source.permissionsFor?.(me) : null;

  if (
    !sourcePermissions?.has(PermissionFlagsBits.ViewChannel) ||
    !sourcePermissions?.has(PermissionFlagsBits.ReadMessageHistory)
  ) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Missing permissions',
            `I need **View Channel** and **Read Message History** in ${source}.`,
          ),
        ],
      }),
    );
    return;
  }

  const existing = getSchedule(ctx.guildId, source.id);

  if (!existing && listSchedules(ctx.guildId).length >= MAX_SCHEDULES) {
    await ctx.reply(
      ephemeral({
        embeds: [errorEmbed('Too many schedules', `Remove one first (max ${MAX_SCHEDULES}).`)],
      }),
    );
    return;
  }

  const mode = hasDaily ? 'daily' : 'interval';

  const schedule = upsertSchedule({
    guildId: ctx.guildId,
    channelId: source.id,
    kind,
    prompt: kind === 'targeted' ? options.prompt : null,
    mode,
    intervalMs: mode === 'interval' ? options.intervalMs : null,
    minuteOfDay: mode === 'daily' ? options.minuteOfDay : null,
    createdBy: ctx.user.id,
  });

  const next = nextRunAt(schedule, timeZoneFor(ctx.guildId));

  await ctx.reply(
    ephemeral({
      embeds: [
        successEmbed(
          existing ? 'Schedule updated' : 'Schedule created',
          [
            `**${kindLabel(kind)}** summary of ${source}, ${cadenceLabel(schedule)}.`,
            `Reports go to ${destination}.`,
            next ? `First run: ${stamp(next)}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      ],
    }),
  );
}

async function handleRemove(ctx) {
  if (!(await requireManageGuild(ctx))) return;

  const channelId = ctx.isSlash ? (ctx.getChannel('channel')?.id ?? null) : (ctx.args[0] ?? null);
  const source = await resolveChannel(ctx, channelId?.replace?.(/^<#|>$/g, '') ?? null);

  if (!source) {
    await ctx.reply(ephemeral({ embeds: [errorEmbed('Which channel?', 'Name the scheduled channel.')] }));
    return;
  }

  const removed = removeSchedule(ctx.guildId, source.id);

  await ctx.reply(
    ephemeral({
      embeds: [
        removed > 0
          ? successEmbed('Schedule removed', `No more automatic reports for ${source}.`)
          : infoEmbed('No schedule', `${source} had no automatic report.`),
      ],
    }),
  );
}

async function handleToggle(ctx, enabled) {
  if (!(await requireManageGuild(ctx))) return;

  const channelId = ctx.isSlash ? (ctx.getChannel('channel')?.id ?? null) : (ctx.args[0] ?? null);
  const source = await resolveChannel(ctx, channelId?.replace?.(/^<#|>$/g, '') ?? null);

  if (!source) {
    await ctx.reply(ephemeral({ embeds: [errorEmbed('Which channel?', 'Name the scheduled channel.')] }));
    return;
  }

  const changed = setScheduleEnabled(ctx.guildId, source.id, enabled);

  await ctx.reply(
    ephemeral({
      embeds: [
        changed > 0
          ? successEmbed(
              enabled ? 'Schedule resumed' : 'Schedule paused',
              `${source} — automatic reports are now ${enabled ? 'on' : 'off'}.`,
            )
          : infoEmbed('No schedule', `${source} has no automatic report to ${enabled ? 'resume' : 'pause'}.`),
      ],
    }),
  );
}

async function handleList(ctx) {
  const schedules = listSchedules(ctx.guildId);

  if (schedules.length === 0) {
    await ctx.reply(
      ephemeral({
        embeds: [
          infoEmbed(
            'No automatic reports',
            [
              'Create one with:',
              '`:-autoreport set #general 6h` — every six hours',
              '`:-autoreport set #general 09:00 tasks` — daily action items at 09:00',
            ].join('\n'),
          ),
        ],
      }),
    );
    return;
  }

  const timeZone = timeZoneFor(ctx.guildId);
  const lines = schedules.map((schedule) => {
    const channel = ctx.guild.channels.cache.get(schedule.channelId);
    const name = channel ? `${channel}` : `\`${schedule.channelId}\``;
    const when = schedule.enabled
      ? `next ${stamp(nextRunAt(schedule, timeZone))}`
      : '⏸ paused';

    return `${schedule.enabled ? '▶️' : '⏸️'} ${name} · ${kindLabel(schedule.kind)} · ${cadenceLabel(schedule)} · ${when}`;
  });

  await ctx.reply(
    ephemeral({
      embeds: [
        embed({
          title: `Automatic reports (${schedules.length})`,
          description: lines.join('\n').slice(0, 4000),
          footer: `Times use ${timeZone} · /autoreport remove channel:<#channel>`,
          color: COLORS.primary,
        }),
      ],
    }),
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('autoreport')
    .setDescription('Post a channel summary automatically, on an interval or at a fixed time')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Create or change the schedule for a channel')
        .addChannelOption((option) =>
          option.setName('channel').setDescription('Channel to summarize').setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('every')
            .setDescription('Interval between reports: 90m, 6h, 2d')
            .setRequired(false)
            .setMaxLength(10),
        )
        .addStringOption((option) =>
          option
            .setName('time')
            .setDescription('Daily at this server time, 24h format: 09:00')
            .setRequired(false)
            .setMaxLength(5),
        )
        .addStringOption((option) =>
          option
            .setName('kind')
            .setDescription('What kind of summary (default: General)')
            .setRequired(false)
            .addChoices(...KIND_KEYS.map((key) => ({ name: SUMMARY_KINDS[key].brief, value: key }))),
        )
        .addStringOption((option) =>
          option
            .setName('prompt')
            .setDescription('For Targeted schedules: what to look for')
            .setRequired(false)
            .setMaxLength(MAX_PROMPT),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Stop the automatic report for a channel')
        .addChannelOption((option) =>
          option.setName('channel').setDescription('Scheduled channel').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('pause')
        .setDescription('Pause a schedule without deleting it')
        .addChannelOption((option) =>
          option.setName('channel').setDescription('Scheduled channel').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('resume')
        .setDescription('Resume a paused schedule')
        .addChannelOption((option) =>
          option.setName('channel').setDescription('Scheduled channel').setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Show every automatic report')),

  name: 'autoreport',
  aliases: ['schedule', 'digest'],
  description: 'Automatically post a channel summary on an interval or at a fixed time',
  category: 'Community',
  usage: 'autoreport set <#channel> <6h|09:00> [general|tasks|ask <focus>] | remove <#channel> | list',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ManageGuild'],

  async execute(ctx) {
    let sub = 'list';

    if (ctx.isSlash) {
      sub = ctx.getSubcommand() ?? 'list';
    } else if (['set', 'remove', 'pause', 'resume', 'list'].includes(ctx.args[0])) {
      sub = ctx.args.shift();
    }

    try {
      if (sub === 'set') return await handleSet(ctx);
      if (sub === 'remove') return await handleRemove(ctx);
      if (sub === 'pause') return await handleToggle(ctx, false);
      if (sub === 'resume') return await handleToggle(ctx, true);

      return await handleList(ctx);
    } catch (error) {
      logger.warn(`autoreport ${sub} failed: ${error.message}`);
      throw error;
    }
  },
};
