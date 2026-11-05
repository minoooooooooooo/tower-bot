import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import {
  PERIOD_CHOICES,
  formatDate,
  formatNumber,
  formatPeriod,
  rankBadge,
} from '../../lib/activity-format.js';
import { embed, warningEmbed } from '../../lib/embeds.js';
import { normalizeForMatch } from '../../lib/text.js';
import {
  periodStart,
  topChannels,
  trackingSince,
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
  return channel?.toString?.() ?? `#deleted-channel`;
}

export default {
  data: new SlashCommandBuilder()
    .setName('topchannels')
    .setDescription('Rank text channels by messages sent')
    .setContexts(InteractionContextType.Guild)
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
        .setDescription('How many channels to show (1–25, default 10)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(25),
    ),

  name: 'topchannels',
  aliases: ['channels', 'top-channels'],
  description: 'Rank text channels by messages sent',
  category: 'Activity',
  usage: 'topchannels [all|7d|30d] [limit]',
  cooldown: 5,
  guildOnly: true,

  async execute(ctx) {
    const parsed = ctx.isSlash ? null : parsePrefix(ctx.args);

    if (parsed?.error) {
      await ctx.fail({
        embeds: [
          warningEmbed(
            'Unknown option',
            `\`${parsed.error}\` is not a period or number.\n` +
              `Use \`${ctx.isSlash ? '/topchannels' : ':-topchannels'} [all|7d|30d] [limit]\`.`,
          ),
        ],
      });
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

      await ctx.reply({
        embeds: [
          warningEmbed(
            'No channel activity yet',
            since && anyTime.length > 0
              ? `Nothing in the ${formatPeriod(period).toLowerCase()}. Try \`${ctx.isSlash ? '/topchannels period:All time' : ':-topchannels all'}\` for the all-time list.`
              : 'Channels appear here once people send messages while I am online. Threads count toward their parent channel.',
          ),
        ],
      });
      return;
    }

    // Same LTR pin as `/top`: channel names and Arabic categories must not
    // reorder the rank column.
    const lines = rows.map(
      (row, index) =>
        `\u200E${rankBadge(index)} ${channelLabel(ctx.guild, row.channelId)}\u200E — **${formatNumber(row.messages)}** messages`,
    );

    await ctx.reply({
      embeds: [
        embed({
          title: 'Most active channels · messages',
          description: lines.join('\n'),
          footer: `${formatPeriod(period)} · messages since ${formatDate(trackingSince(ctx.guildId))}`,
          timestamp: false,
        }),
      ],
      allowedMentions: { parse: [] },
    });
  },
};
