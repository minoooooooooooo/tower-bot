import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import {
  PERIOD_CHOICES,
  formatDate,
  formatNumber,
  formatPeriod,
  rankBadge,
} from '../../lib/activity-format.js';
import { embed } from '../../lib/embeds.js';
import { warnReply } from '../../lib/replies.js';
import { normalizeForMatch } from '../../lib/text.js';
import {
  messagesSince,
  periodStart,
  topChannels,
} from '../../services/activity-store.js';

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
  let period = 'all';
  let limit = 10;

  for (const token of args) {
    const key = normalizeForMatch(token);

    if (PERIODS.has(key)) {
      period = PERIODS.get(key);
      continue;
    }

    if (/^\d+$/.test(token)) {
      limit = Math.max(1, Math.min(25, Number(token)));
      continue;
    }

    return { error: token };
  }

  return { period, limit };
}

function channelLabel(guild, id) {
  const channel = guild.channels?.cache?.get(id);
  return channel?.toString?.() ?? '#قناة-محذوفة';
}

export default {
  data: new SlashCommandBuilder()
    .setName('topchannels')
    .setDescription('رتّب القنوات النصية حسب عدد الرسائل')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('period')
        .setDescription('المدة (الافتراضي: كل الوقت)')
        .setRequired(false)
        .addChoices(...PERIOD_CHOICES),
    )
    .addIntegerOption((option) =>
      option
        .setName('limit')
        .setDescription('كم قناة تعرض (1–25، الافتراضي 10)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(25),
    ),

  name: 'topchannels',
  aliases: ['channels', 'top-channels'],
  description: 'رتّب القنوات النصية حسب عدد الرسائل',
  category: 'Activity',
  usage: 'topchannels [all|7d|30d] [limit]',
  cooldown: 5,
  guildOnly: true,

  async execute(ctx) {
    const parsed = ctx.isSlash ? null : parsePrefix(ctx.args);

    if (parsed?.error) {
      await ctx.fail(
        warnReply(
          'خيار غير معروف',
          `\`${parsed.error}\` مو مدة ولا رقم.\n` +
            `استخدم \`${ctx.isSlash ? '/topchannels' : ':-topchannels'} [all|7d|30d] [limit]\`.`,
        ),
      );
      return;
    }

    const period = ctx.isSlash ? ctx.getString('period') ?? 'all' : parsed.period;
    const limit = ctx.isSlash
      ? Math.max(1, Math.min(25, ctx.getInteger('limit') ?? 10))
      : parsed.limit;

    const since = periodStart(period);
    const rows = topChannels(ctx.guildId, { since, limit });

    if (rows.length === 0) {
      const anyTime = topChannels(ctx.guildId, { since: null, limit: 1 });

      await ctx.reply(
        warnReply(
          'ما فيه نشاط في القنوات بعد',
          since && anyTime.length > 0
            ? `ما فيه شي في ${formatPeriod(period)}. جرّب \`${ctx.isSlash ? '/topchannels period:كل الوقت' : ':-topchannels all'}\` لقائمة كل الوقت.`
            : 'القنوات تطلع هنا أول ما يرسلون الأعضاء وأنا شغّال. الثريدات تنحسب على قناتها الأم، و`/backfill start` يستورد الرسائل القديمة.',
        ),
      );
      return;
    }

    // Same LTR pin as `/top`: channel names and Arabic categories must not
    // reorder the rank column.
    const lines = rows.map(
      (row, index) =>
        `\u200E${rankBadge(index)} ${channelLabel(ctx.guild, row.channelId)}\u200E — **${formatNumber(row.messages)}** رسالة`,
    );

    await ctx.reply({
      embeds: [
        embed({
          title: 'أكثر القنوات نشاطًا · الرسائل',
          description: lines.join('\n'),
          footer: `${formatPeriod(period)} · الرسائل منذ ${formatDate(messagesSince(ctx.guildId))}`,
          timestamp: false,
        }),
      ],
      allowedMentions: { parse: [] },
    });
  },
};
