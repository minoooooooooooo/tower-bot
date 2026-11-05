import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import {
  formatDate,
  formatNumber,
  formatVoiceTime,
} from '../../lib/activity-format.js';
import { embed, warningEmbed } from '../../lib/embeds.js';
import {
  activityDay,
  periodStart,
  serverTotals,
  topChannels,
  topMembers,
  trackingSince,
} from '../../services/activity-store.js';

function channelLabel(guild, id) {
  return guild.channels?.cache?.get(id)?.toString?.() ?? '#deleted-channel';
}

function memberLine(row) {
  if (!row) return 'No messages yet';

  return `\u200E<@${row.userId}>\u200E — **${formatNumber(row.messages)}** messages · **${formatVoiceTime(row.voiceSeconds)}** in voice`;
}

export default {
  data: new SlashCommandBuilder()
    .setName('serverstats')
    .setDescription('Show this server’s activity totals and leaders')
    .setContexts(InteractionContextType.Guild),

  name: 'serverstats',
  aliases: ['activity', 'serveractivity', 'sstats'],
  description: 'Show this server’s activity totals and leaders',
  category: 'Activity',
  usage: 'serverstats',
  cooldown: 5,
  guildOnly: true,

  async execute(ctx) {
    const all = serverTotals(ctx.guildId, null);

    if (all.messages === 0 && all.voiceSeconds === 0) {
      await ctx.reply({
        embeds: [
          warningEmbed(
            'No activity yet',
            'I start counting the moment I see a message or someone joins voice. ' +
              'There is no backfill, so give it a little time and try again.',
          ),
        ],
      });
      return;
    }

    const today = serverTotals(ctx.guildId, activityDay(Date.now()));
    const week = serverTotals(ctx.guildId, periodStart('7d'));
    const topMember =
      topMembers(ctx.guildId, { metric: 'messages', limit: 1 })[0] ??
      topMembers(ctx.guildId, { metric: 'voice', limit: 1 })[0] ??
      null;
    const topChannel = topChannels(ctx.guildId, { limit: 1 })[0] ?? null;
    const since = trackingSince(ctx.guildId);
    const memberCount = ctx.guild.memberCount ?? ctx.guild.members?.cache?.size ?? 0;

    await ctx.reply({
      embeds: [
        embed({
          title: `${ctx.guild.name} · activity`,
          thumbnail: ctx.guild.iconURL?.({ size: 128 }) ?? null,
          fields: [
            {
              name: 'Members',
              value: `${formatNumber(memberCount)} in server · **${formatNumber(all.members)}** tracked`,
              inline: true,
            },
            {
              name: 'Channels',
              value: `**${formatNumber(all.channels)}** active`,
              inline: true,
            },
            {
              name: 'Tracking since',
              value: formatDate(since),
              inline: true,
            },
            {
              name: 'Messages',
              value: [
                `**${formatNumber(all.messages)}** total`,
                `${formatNumber(week.messages)} in the last 7 days`,
                `${formatNumber(today.messages)} today`,
              ].join('\n'),
              inline: true,
            },
            {
              name: 'Voice time',
              value: [
                `**${formatVoiceTime(all.voiceSeconds)}** total`,
                `${formatVoiceTime(week.voiceSeconds)} in the last 7 days`,
                `${formatVoiceTime(today.voiceSeconds)} today`,
              ].join('\n'),
              inline: true,
            },
            {
              name: 'Most active member',
              value: memberLine(topMember),
              inline: false,
            },
            {
              name: 'Most active channel',
              value: topChannel
                ? `\u200E${channelLabel(ctx.guild, topChannel.channelId)}\u200E — **${formatNumber(topChannel.messages)}** messages`
                : 'No messages yet',
              inline: false,
            },
          ],
          footer: 'Counted while the bot is online',
        }),
      ],
      allowedMentions: { parse: [] },
    });
  },
};
