import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import {
  formatDate,
  formatNumber,
  formatVoiceTime,
} from '../../lib/activity-format.js';
import { embed } from '../../lib/embeds.js';
import { warnReply } from '../../lib/replies.js';
import {
  activityDay,
  messagesSince,
  periodStart,
  serverTotals,
  topChannels,
  topMembers,
  voiceSince,
} from '../../services/activity-store.js';

function channelLabel(guild, id) {
  return guild.channels?.cache?.get(id)?.toString?.() ?? '#قناة-محذوفة';
}

function memberLine(row) {
  if (!row) return 'ما فيه رسائل بعد';

  return `\u200E<@${row.userId}>\u200E — **${formatNumber(row.messages)}** رسالة · **${formatVoiceTime(row.voiceSeconds)}** في الصوت`;
}

export default {
  data: new SlashCommandBuilder()
    .setName('serverstats')
    .setDescription('اعرض نشاط السيرفر وأكثر الأعضاء والقنوات حركة')
    .setContexts(InteractionContextType.Guild),

  name: 'serverstats',
  aliases: ['activity', 'serveractivity', 'sstats'],
  description: 'اعرض نشاط السيرفر وأكثر الأعضاء والقنوات حركة',
  category: 'Activity',
  usage: 'serverstats',
  cooldown: 5,
  guildOnly: true,

  async execute(ctx) {
    const all = serverTotals(ctx.guildId, null);

    if (all.messages === 0 && all.voiceSeconds === 0) {
      await ctx.reply(
        warnReply(
          'ما فيه نشاط بعد',
          'أبدأ أحسب أول ما أشوف رسالة أو أحد يدخل الصوت. ' +
            'شغّل `/backfill start` عشان تستورد الرسائل القديمة.',
        ),
      );
      return;
    }

    const today = serverTotals(ctx.guildId, activityDay(Date.now()));
    const week = serverTotals(ctx.guildId, periodStart('7d'));
    const topMember =
      topMembers(ctx.guildId, { metric: 'messages', limit: 1 })[0] ??
      topMembers(ctx.guildId, { metric: 'voice', limit: 1 })[0] ??
      null;
    const topChannel = topChannels(ctx.guildId, { limit: 1 })[0] ?? null;
    const memberCount = ctx.guild.memberCount ?? ctx.guild.members?.cache?.size ?? 0;

    await ctx.reply({
      embeds: [
        embed({
          title: `${ctx.guild.name} · النشاط`,
          thumbnail: ctx.guild.iconURL?.({ size: 128 }) ?? null,
          fields: [
            {
              name: 'الأعضاء',
              value: `${formatNumber(memberCount)} في السيرفر · **${formatNumber(all.members)}** متابَع`,
              inline: true,
            },
            {
              name: 'القنوات',
              value: `**${formatNumber(all.channels)}** نشطة`,
              inline: true,
            },
            {
              name: 'الرسائل منذ',
              value: formatDate(messagesSince(ctx.guildId)),
              inline: true,
            },
            {
              name: 'الصوت منذ',
              value: formatDate(voiceSince(ctx.guildId)),
              inline: true,
            },
            {
              name: 'الرسائل',
              value: [
                `**${formatNumber(all.messages)}** الإجمالي`,
                `${formatNumber(week.messages)} في آخر 7 أيام`,
                `${formatNumber(today.messages)} اليوم`,
              ].join('\n'),
              inline: true,
            },
            {
              name: 'وقت الصوت',
              value: [
                `**${formatVoiceTime(all.voiceSeconds)}** الإجمالي`,
                `${formatVoiceTime(week.voiceSeconds)} في آخر 7 أيام`,
                `${formatVoiceTime(today.voiceSeconds)} اليوم`,
              ].join('\n'),
              inline: true,
            },
            {
              name: 'أكثر عضو نشاطًا',
              value: memberLine(topMember),
              inline: false,
            },
            {
              name: 'أكثر قناة نشاطًا',
              value: topChannel
                ? `\u200E${channelLabel(ctx.guild, topChannel.channelId)}\u200E — **${formatNumber(topChannel.messages)}** رسالة`
                : 'ما فيه رسائل بعد',
              inline: false,
            },
          ],
          footer: 'الرسائل تشمل السجل المستورد · الصوت يُحسب مباشرة',
        }),
      ],
      allowedMentions: { parse: [] },
    });
  },
};
