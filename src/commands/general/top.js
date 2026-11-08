import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  InteractionContextType,
  SlashCommandBuilder,
} from 'discord.js';
import {
  PERIOD_CHOICES,
  formatDate,
  formatNumber,
  formatPeriod,
  formatVoiceTime,
  rankBadge,
} from '../../lib/activity-format.js';
import { embed, warningEmbed } from '../../lib/embeds.js';
import { createLogger } from '../../lib/logger.js';
import { normalizeForMatch } from '../../lib/text.js';
import {
  countTopMembers,
  messagesSince,
  periodStart,
  topMembers,
  voiceSince,
} from '../../services/activity-store.js';

const logger = createLogger('top');

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 25;
const PAGER_TIMEOUT_MS = 10 * 60 * 1000;

const METRICS = new Map([
  ['messages', 'messages'],
  ['message', 'messages'],
  ['msg', 'messages'],
  ['msgs', 'messages'],
  ['رسائل', 'messages'],
  ['رسالة', 'messages'],
  ['voice', 'voice'],
  ['vc', 'voice'],
  ['صوت', 'voice'],
  ['فويس', 'voice'],
]);

const PERIODS = new Map([
  ['all', 'all'],
  ['كل', 'all'],
  ['7d', '7d'],
  ['7', '7d'],
  ['week', '7d'],
  ['اسبوع', '7d'],
  ['30d', '30d'],
  ['30', '30d'],
  ['month', '30d'],
  ['شهر', '30d'],
]);

function parsePrefix(args) {
  let metric = 'messages';
  let period = 'all';
  let pageSize = DEFAULT_PAGE_SIZE;

  for (const token of args) {
    const key = normalizeForMatch(token);

    if (METRICS.has(key)) {
      metric = METRICS.get(key);
      continue;
    }

    if (PERIODS.has(key)) {
      period = PERIODS.get(key);
      continue;
    }

    if (/^\d+$/.test(token)) {
      pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(token)));
      continue;
    }

    return { error: token };
  }

  return { metric, period, pageSize };
}

function rowValue(row, metric) {
  return metric === 'voice'
    ? `**${formatVoiceTime(row.voiceSeconds)}** in voice`
    : `**${formatNumber(row.messages)}** messages`;
}

/**
 * Reads one page. The total drives the page count, so the buttons know where
 * the list ends without fetching every row.
 */
function readPage(ctx, state) {
  const since = periodStart(state.period);
  const total = countTopMembers(ctx.guildId, { metric: state.metric, since });
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  const page = Math.min(Math.max(1, state.page), pages);
  const offset = (page - 1) * state.pageSize;
  const rows =
    total > 0
      ? topMembers(ctx.guildId, {
          metric: state.metric,
          since,
          limit: state.pageSize,
          offset,
        })
      : [];

  return { total, pages, page, rows };
}

function pagerRow(page, pages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('top:first')
      .setLabel('« First')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId('top:prev')
      .setLabel('‹ Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId('top:page')
      .setLabel(`Page ${page} / ${pages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId('top:next')
      .setLabel('Next ›')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pages),
    new ButtonBuilder()
      .setCustomId('top:last')
      .setLabel('Last »')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pages),
  );
}

/** The embed for the current page, or null when there is no activity at all. */
function buildPage(ctx, state) {
  const { total, pages, page, rows } = readPage(ctx, state);

  if (total === 0) return null;

  // Leading LRM pins the paragraph to LTR so an Arabic display name cannot
  // flip the rank column to the right edge; the LRM after the mention keeps
  // the dash and the value in the same visual order for every name.
  const start = (page - 1) * state.pageSize;
  const lines = rows.map(
    (row, index) =>
      `\u200E${rankBadge(start + index)} <@${row.userId}>\u200E — ${rowValue(row, state.metric)}`,
  );
  const coverage =
    state.metric === 'voice'
      ? `voice since ${formatDate(voiceSince(ctx.guildId))}`
      : `messages since ${formatDate(messagesSince(ctx.guildId))}`;
  const footer = [
    formatPeriod(state.period),
    pages > 1 ? `Page ${page} / ${pages}` : null,
    coverage,
  ]
    .filter(Boolean)
    .join(' · ');

  const payload = {
    embeds: [
      embed({
        title: `Most active members · ${state.metric === 'voice' ? 'voice time' : 'messages'}`,
        description: lines.join('\n'),
        footer,
        timestamp: false,
      }),
    ],
    allowedMentions: { parse: [] },
  };

  if (pages > 1) payload.components = [pagerRow(page, pages)];

  return payload;
}

function attachPager({ ctx, message, state }) {
  if (!message?.createMessageComponentCollector) return;

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: PAGER_TIMEOUT_MS,
  });

  collector.on('collect', async (interaction) => {
    const action = String(interaction.customId).split(':')[1];
    const { pages, page } = readPage(ctx, state);

    if (action === 'first') state.page = 1;
    else if (action === 'last') state.page = pages;
    else if (action === 'next') state.page = page + 1;
    else if (action === 'prev') state.page = page - 1;

    const payload = buildPage(ctx, state);

    if (!payload) {
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    await interaction.update(payload).catch((error) => {
      logger.warn(`Could not update the leaderboard page: ${error.message}`);
    });
  });

  collector.on('end', () => {
    message.edit({ components: [] }).catch(() => {});
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('top')
    .setDescription('Rank members by messages or voice time')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('metric')
        .setDescription('What to rank by (default: messages)')
        .setRequired(false)
        .addChoices(
          { name: 'Messages', value: 'messages' },
          { name: 'Voice time', value: 'voice' },
        ),
    )
    .addStringOption((option) =>
      option
        .setName('period')
        .setDescription('Time window (default: all time)')
        .setRequired(false)
        .addChoices(...PERIOD_CHOICES),
    )
    .addIntegerOption((option) =>
      option
        .setName('per_page')
        .setDescription('Members per page (1–25, default 10)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(25),
    ),

  name: 'top',
  aliases: ['leaderboard', 'ranking', 'rank'],
  description: 'Rank members by messages or voice time',
  category: 'Activity',
  usage: 'top [messages|voice] [all|7d|30d] [per page]',
  cooldown: 5,
  guildOnly: true,

  async execute(ctx) {
    const parsed = ctx.isSlash ? null : parsePrefix(ctx.args);

    if (parsed?.error) {
      await ctx.fail({
        embeds: [
          warningEmbed(
            'Unknown option',
            `\`${parsed.error}\` is not a metric, period or number.\n` +
              `Use \`${ctx.isSlash ? '/top' : ':-top'} [messages|voice] [all|7d|30d] [per page]\`.`,
          ),
        ],
      });
      return;
    }

    const state = {
      metric:
        (ctx.isSlash ? ctx.getString('metric') : parsed.metric) === 'voice'
          ? 'voice'
          : 'messages',
      period: ctx.isSlash ? ctx.getString('period') ?? 'all' : parsed.period,
      pageSize: ctx.isSlash
        ? Math.max(1, Math.min(MAX_PAGE_SIZE, ctx.getInteger('per_page') ?? DEFAULT_PAGE_SIZE))
        : parsed.pageSize,
      page: 1,
    };

    const payload = buildPage(ctx, state);

    if (!payload) {
      const anyTime = topMembers(ctx.guildId, { metric: state.metric, since: null, limit: 1 });

      await ctx.reply({
        embeds: [
          warningEmbed(
            'No activity yet',
            periodStart(state.period) && anyTime.length > 0
              ? `Nothing in the ${formatPeriod(state.period).toLowerCase()}. Try \`${ctx.isSlash ? '/top period:All time' : ':-top all'}\` for the all-time ranking.`
              : 'I count messages and voice time while I am online. Once people chat or join voice, the ranking appears here, and `/backfill start` imports older messages.',
          ),
        ],
        allowedMentions: { parse: [] },
      });
      return;
    }

    const sent = await ctx.reply(payload);

    if (!payload.components) return;

    let message = ctx.isSlash ? null : sent;

    if (ctx.isSlash && ctx.interaction?.fetchReply) {
      message = await ctx.interaction.fetchReply().catch(() => null);
    }

    attachPager({ ctx, message, state });
  },
};
