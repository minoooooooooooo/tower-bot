import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import {
  PERIOD_CHOICES,
  formatDate,
  formatNumber,
  formatPeriod,
  formatVoiceTime,
  rankBadge,
} from '../../lib/activity-format.js';
import { embed, warningEmbed } from '../../lib/embeds.js';
import { normalizeForMatch } from '../../lib/text.js';
import {
  periodStart,
  topMembers,
  trackingSince,
} from '../../services/activity-store.js';

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
  let limit = 10;

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
      limit = Math.max(1, Math.min(25, Number(token)));
      continue;
    }

    return { error: token };
  }

  return { metric, period, limit };
}

function rowValue(row, metric) {
  return metric === 'voice'
    ? `**${formatVoiceTime(row.voiceSeconds)}** in voice`
    : `**${formatNumber(row.messages)}** messages`;
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
        .setName('limit')
        .setDescription('How many members to show (1–25, default 10)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(25),
    ),

  name: 'top',
  aliases: ['leaderboard', 'ranking', 'rank'],
  description: 'Rank members by messages or voice time',
  category: 'Activity',
  usage: 'top [messages|voice] [all|7d|30d] [limit]',
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
              `Use \`${ctx.isSlash ? '/top' : ':-top'} [messages|voice] [all|7d|30d] [limit]\`.`,
          ),
        ],
      });
      return;
    }

    const metric =
      (ctx.isSlash ? ctx.getString('metric') : parsed.metric) === 'voice'
        ? 'voice'
        : 'messages';
    const period = ctx.isSlash ? ctx.getString('period') ?? 'all' : parsed.period;
    const limit = ctx.isSlash
      ? Math.max(1, Math.min(25, ctx.getInteger('limit') ?? 10))
      : parsed.limit;

    const since = periodStart(period);
    const rows = topMembers(ctx.guildId, { metric, since, limit });

    if (rows.length === 0) {
      const anyTime = topMembers(ctx.guildId, { metric, since: null, limit: 1 });

      await ctx.reply({
        embeds: [
          warningEmbed(
            'No activity yet',
            since && anyTime.length > 0
              ? `Nothing in the ${formatPeriod(period).toLowerCase()}. Try \`${ctx.isSlash ? '/top period:All time' : ':-top all'}\` for the all-time ranking.`
              : 'I count messages and voice time while I am online. Once people chat or join voice, the ranking appears here.',
          ),
        ],
        allowedMentions: { parse: [] },
      });
      return;
    }

    // Leading LRM pins the paragraph to LTR so an Arabic display name cannot
    // flip the rank column to the right edge; the LRM after the mention keeps
    // the dash and the value in the same visual order for every name.
    const lines = rows.map(
      (row, index) =>
        `\u200E${rankBadge(index)} <@${row.userId}>\u200E — ${rowValue(row, metric)}`,
    );

    await ctx.reply({
      embeds: [
        embed({
          title: `Most active members · ${metric === 'voice' ? 'voice time' : 'messages'}`,
          description: lines.join('\n'),
          footer: `${formatPeriod(period)} · ${metric === 'voice' ? 'voice' : 'messages'} since ${formatDate(trackingSince(ctx.guildId))}`,
          timestamp: false,
        }),
      ],
      allowedMentions: { parse: [] },
    });
  },
};
