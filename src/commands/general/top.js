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
import { embed } from '../../lib/embeds.js';
import { createLogger } from '../../lib/logger.js';
import { warnReply } from '../../lib/replies.js';
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
    ? `**${formatVoiceTime(row.voiceSeconds)}** في الصوت`
    : `**${formatNumber(row.messages)}** رسالة`;
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
      .setLabel('« الأول')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId('top:prev')
      .setLabel('‹ السابق')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId('top:page')
      .setLabel(`صفحة ${page} / ${pages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId('top:next')
      .setLabel('التالي ›')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pages),
    new ButtonBuilder()
      .setCustomId('top:last')
      .setLabel('الأخير »')
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
      ? `الصوت منذ ${formatDate(voiceSince(ctx.guildId))}`
      : `الرسائل منذ ${formatDate(messagesSince(ctx.guildId))}`;
  const footer = [
    formatPeriod(state.period),
    pages > 1 ? `صفحة ${page} / ${pages}` : null,
    coverage,
  ]
    .filter(Boolean)
    .join(' · ');

  const payload = {
    embeds: [
      embed({
        title: `أكثر الأعضاء نشاطًا · ${state.metric === 'voice' ? 'وقت الصوت' : 'الرسائل'}`,
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
    .setDescription('رتّب الأعضاء حسب الرسائل أو وقت الصوت')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('metric')
        .setDescription('الترتيب حسب (الافتراضي: الرسائل)')
        .setRequired(false)
        .addChoices(
          { name: 'الرسائل', value: 'messages' },
          { name: 'وقت الصوت', value: 'voice' },
        ),
    )
    .addStringOption((option) =>
      option
        .setName('period')
        .setDescription('المدة (الافتراضي: كل الوقت)')
        .setRequired(false)
        .addChoices(...PERIOD_CHOICES),
    )
    .addIntegerOption((option) =>
      option
        .setName('per_page')
        .setDescription('عدد الأعضاء في الصفحة (1–25، الافتراضي 10)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(25),
    ),

  name: 'top',
  aliases: ['leaderboard', 'ranking', 'rank'],
  description: 'رتّب الأعضاء حسب الرسائل أو وقت الصوت',
  category: 'Activity',
  usage: 'top [messages|voice] [all|7d|30d] [per page]',
  cooldown: 5,
  guildOnly: true,

  async execute(ctx) {
    const parsed = ctx.isSlash ? null : parsePrefix(ctx.args);

    if (parsed?.error) {
      await ctx.fail(
        warnReply(
          'خيار غير معروف',
          `\`${parsed.error}\` مو نوع ترتيب ولا مدة ولا رقم.\n` +
            `استخدم \`${ctx.isSlash ? '/top' : ':-top'} [messages|voice] [all|7d|30d] [per page]\`.`,
        ),
      );
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
        content: warnReply(
          'ما فيه نشاط بعد',
          periodStart(state.period) && anyTime.length > 0
            ? `ما فيه شي في ${formatPeriod(state.period)}. جرّب \`${ctx.isSlash ? '/top period:كل الوقت' : ':-top all'}\` لترتيب كل الوقت.`
            : 'أنا أحسب الرسائل ووقت الصوت وأنا شغّال. أول ما يتكلمون الأعضاء أو يدخلون الصوت يطلع الترتيب، و`/backfill start` يستورد الرسائل القديمة.',
        ).content,
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
