import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  InteractionContextType,
  SlashCommandBuilder,
} from 'discord.js';
import { formatDate, formatNumber, rankBadge } from '../../lib/activity-format.js';
import { embed } from '../../lib/embeds.js';
import { createLogger } from '../../lib/logger.js';
import { warnReply } from '../../lib/replies.js';
import { normalizeForMatch } from '../../lib/text.js';
import {
  emojiCoverageSince,
  emojiPeriodLabel,
  emojiPeriodStart,
  rankedEmojiUsage,
} from '../../services/emoji-store.js';

const logger = createLogger('topemojis');

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 25;
const PAGER_TIMEOUT_MS = 10 * 60 * 1000;

const PERIODS = new Map(
  [
    ['1d', '1d'],
    ['day', '1d'],
    ['today', '1d'],
    ['24h', '1d'],
    ['اليوم', '1d'],
    ['7d', '7d'],
    ['7', '7d'],
    ['week', '7d'],
    ['اسبوع', '7d'],
    ['30d', '30d'],
    ['30', '30d'],
    ['month', '30d'],
    ['شهر', '30d'],
    ['all', 'all'],
    ['كل', 'all'],
  ].map(([key, value]) => [normalizeForMatch(key), value]),
);

const ORDERS = new Map(
  [
    ['most', 'most'],
    ['top', 'most'],
    ['used', 'most'],
    ['اكثر', 'most'],
    ['الأكثر', 'most'],
    ['least', 'least'],
    ['bottom', 'least'],
    ['lowest', 'least'],
    ['اقل', 'least'],
    ['الأقل', 'least'],
  ].map(([key, value]) => [normalizeForMatch(key), value]),
);

const PERIOD_CHOICES = [
  { name: 'اليوم', value: '1d' },
  { name: 'آخر 7 أيام', value: '7d' },
  { name: 'آخر 30 يوم', value: '30d' },
  { name: 'كل الوقت', value: 'all' },
];

const ORDER_CHOICES = [
  { name: 'الأكثر استخدامًا', value: 'most' },
  { name: 'الأقل استخدامًا', value: 'least' },
];

function parsePrefix(args) {
  let order = 'most';
  let period = 'all';
  let pageSize = DEFAULT_PAGE_SIZE;

  for (const token of args) {
    const key = normalizeForMatch(token);

    if (ORDERS.has(key)) {
      order = ORDERS.get(key);
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

  return { order, period, pageSize };
}

function liveEmoji(guild, id) {
  return guild?.emojis?.cache?.get?.(id) ?? null;
}

/** Current emojis render as real emoji; deleted/foreign ones keep a readable name. */
function emojiLabel(guild, row) {
  const live = liveEmoji(guild, row.emojiId);

  if (live) return live.toString();

  const name = row.emojiName || row.emojiId;
  return `\`${name}\` *(مو في السيرفر)*`;
}

/**
 * Rows for the current page. The store returns used emojis; the least view also
 * merges in every current server emoji so unused ones appear with zero.
 */
function collectRows(ctx, state) {
  const since = emojiPeriodStart(state.period);
  const rows = rankedEmojiUsage(ctx.guildId, { since });
  const byId = new Map(rows.map((row) => [row.emojiId, row]));

  if (state.order === 'least') {
    for (const emoji of ctx.guild?.emojis?.cache?.values?.() ?? []) {
      if (byId.has(emoji.id)) continue;

      byId.set(emoji.id, {
        emojiId: emoji.id,
        emojiName: emoji.name,
        animated: emoji.animated ? 1 : 0,
        inlineCount: 0,
        standaloneCount: 0,
        total: 0,
        lastUsedAt: null,
      });
    }
  }

  const list = [...byId.values()].filter((row) => state.order === 'least' || row.total > 0);

  list.sort((a, b) => {
    if (state.order === 'least') {
      return (
        a.total - b.total ||
        a.emojiName.localeCompare(b.emojiName) ||
        a.emojiId.localeCompare(b.emojiId)
      );
    }

    return (
      b.total - a.total ||
      (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) ||
      a.emojiName.localeCompare(b.emojiName) ||
      a.emojiId.localeCompare(b.emojiId)
    );
  });

  return list;
}

function readPage(ctx, state) {
  const rows = collectRows(ctx, state);
  const pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
  const page = Math.min(Math.max(1, state.page), pages);
  const offset = (page - 1) * state.pageSize;

  return {
    total: rows.length,
    pages,
    page,
    rows: rows.slice(offset, offset + state.pageSize),
  };
}

function pagerRow(page, pages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('topemojis:first')
      .setLabel('« الأول')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId('topemojis:prev')
      .setLabel('‹ السابق')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId('topemojis:page')
      .setLabel(`صفحة ${page} / ${pages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId('topemojis:next')
      .setLabel('التالي ›')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pages),
    new ButtonBuilder()
      .setCustomId('topemojis:last')
      .setLabel('الأخير »')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pages),
  );
}

function buildPage(ctx, state) {
  const { total, pages, page, rows } = readPage(ctx, state);

  // A least-used list with zero-use server emojis is still useful, so only a
  // genuinely empty result is treated as "no data".
  if (total === 0) return null;

  const start = (page - 1) * state.pageSize;
  const lines = rows.map((row, index) => {
    const detail =
      row.total > 0
        ? `**${formatNumber(row.total)}** استخدام (${formatNumber(row.inlineCount)} داخل رسالة · ` +
          `${formatNumber(row.standaloneCount)} لحاله)`
        : '**0** استخدام · ما انستخدم في هذي المدة';

    return `\u200E${rankBadge(start + index)} ${emojiLabel(ctx.guild, row)}\u200E — ${detail}`;
  });

  const coverageSince = emojiCoverageSince(ctx.guildId);
  const footer = [
    emojiPeriodLabel(state.period),
    pages > 1 ? `صفحة ${page} / ${pages}` : null,
    coverageSince ? `منذ ${formatDate(coverageSince)}` : 'العدّ المباشر ما بدأ',
  ]
    .filter(Boolean)
    .join(' · ');

  const payload = {
    embeds: [
      embed({
        title: `${state.order === 'least' ? 'أقل' : 'أكثر'} الإيموجيات استخدامًا · ${emojiPeriodLabel(state.period)}`,
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
      logger.warn(`Could not update the emoji leaderboard page: ${error.message}`);
    });
  });

  collector.on('end', () => {
    message.edit({ components: [] }).catch(() => {});
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('topemojis')
    .setDescription('رتّب إيموجيات السيرفر المخصصة حسب الاستخدام')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('order')
        .setDescription('الأكثر أو الأقل استخدامًا (الافتراضي: الأكثر)')
        .setRequired(false)
        .addChoices(...ORDER_CHOICES),
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
        .setDescription('عدد الإيموجيات في الصفحة (1–25، الافتراضي 10)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(MAX_PAGE_SIZE),
    ),

  name: 'topemojis',
  aliases: ['emojis', 'emoji', 'emojistats', 'topemoji'],
  description: 'رتّب إيموجيات السيرفر المخصصة حسب الاستخدام',
  category: 'Activity',
  usage: 'topemojis [most|least] [today|7d|30d|all] [per page]',
  cooldown: 5,
  guildOnly: true,

  async execute(ctx) {
    const parsed = ctx.isSlash ? null : parsePrefix(ctx.args);

    if (parsed?.error) {
      await ctx.fail(
        warnReply(
          'خيار غير معروف',
          `\`${parsed.error}\` مو ترتيب ولا مدة ولا رقم.\n` +
            `استخدم \`${ctx.isSlash ? '/topemojis' : ':-topemojis'} [most|least] [today|7d|30d|all] [per page]\`.`,
        ),
      );
      return;
    }

    const state = {
      order:
        (ctx.isSlash ? ctx.getString('order') : parsed.order) === 'least'
          ? 'least'
          : 'most',
      period: ctx.isSlash ? ctx.getString('period') ?? 'all' : parsed.period,
      pageSize: ctx.isSlash
        ? Math.max(1, Math.min(MAX_PAGE_SIZE, ctx.getInteger('per_page') ?? DEFAULT_PAGE_SIZE))
        : parsed.pageSize,
      page: 1,
    };

    const payload = buildPage(ctx, state);

    if (!payload) {
      const anyTime = rankedEmojiUsage(ctx.guildId, { since: null });

      await ctx.reply(
        warnReply(
          'ما فيه استخدام للإيموجيات بعد',
          state.period !== 'all' && anyTime.length > 0
            ? `ما انستخدم أي إيموجي مخصص في ${emojiPeriodLabel(state.period)}. جرّب \`${ctx.isSlash ? '/topemojis period:كل الوقت' : ':-topemojis all'}\` لترتيب كل الوقت.`
            : 'أنا أحسب الإيموجيات المخصصة في الرسائل وأنا شغّال. أول ما يستخدمونها يطلع الترتيب، و`/emojibackfill start` يستورد الرسائل القديمة.',
        ),
      );
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
