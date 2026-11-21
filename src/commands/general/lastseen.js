import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import {
  formatDate,
  formatNumber,
  formatVoiceTime,
  relativeTime,
} from '../../lib/activity-format.js';
import { embed } from '../../lib/embeds.js';
import { warnReply } from '../../lib/replies.js';
import { resolveUser } from '../../lib/resolve.js';
import { memberStats, messagesSince, voiceSince } from '../../services/activity-store.js';

async function resolveTarget(ctx, client) {
  if (ctx.isSlash) {
    const user = ctx.getUser('user');

    if (!user) return { user: ctx.user, member: ctx.member };

    const member =
      ctx.getMember('user') ??
      (await ctx.guild.members?.fetch?.(user.id).catch(() => null)) ??
      null;

    return { user, member };
  }

  if (ctx.args.length === 0) {
    return { user: ctx.user, member: ctx.member };
  }

  const user = await resolveUser(client, ctx.args[0], ctx.message);

  if (!user) return { user: null, member: null };

  const member =
    ctx.guild.members?.cache?.get(user.id) ??
    (await ctx.guild.members?.fetch?.(user.id).catch(() => null)) ??
    null;

  return { user, member };
}

export default {
  data: new SlashCommandBuilder()
    .setName('lastseen')
    .setDescription('اعرض آخر نشاط لعضو')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('العضو المطلوب (الافتراضي: أنت)')
        .setRequired(false),
    ),

  name: 'lastseen',
  aliases: ['lastactive', 'lastactivity', 'seen', 'last'],
  description: 'اعرض آخر نشاط لعضو',
  category: 'Activity',
  usage: 'lastseen [@member]',
  cooldown: 3,
  guildOnly: true,

  async execute(ctx, client) {
    const { user, member } = await resolveTarget(ctx, client);

    if (!user) {
      await ctx.fail(
        warnReply('عضو غير معروف', 'منشن العضو أو الصق الآيدي، وجرّب مرة ثانية.'),
      );
      return;
    }

    const stats = memberStats(ctx.guildId, user.id);

    if (stats.messages === 0 && stats.voiceSeconds === 0) {
      await ctx.reply({
        content: warnReply(
          'ما فيه نشاط مسجّل',
          `\u200E<@${user.id}> ما عنده رسائل ولا وقت صوت بعد. أنا أحسب بس وأنا شغّال.`,
        ).content,
        allowedMentions: { parse: [] },
      });
      return;
    }

    // Values start with an LRM so an RTL client cannot flip a timestamp or a
    // number away from its label.
    await ctx.reply({
      embeds: [
        embed({
          title: 'نشاط العضو',
          description: `\u200E<@${user.id}>`,
          fields: [
            {
              name: 'آخر نشاط',
              value: `\u200E${relativeTime(stats.lastActiveAt)}`,
              inline: true,
            },
            {
              name: 'آخر رسالة',
              value: `\u200E${relativeTime(stats.lastMessageAt)}`,
              inline: true,
            },
            {
              name: 'الرسائل',
              value: `\u200E${formatNumber(stats.messages)}`,
              inline: true,
            },
            {
              name: 'وقت الصوت',
              value: `\u200E${formatVoiceTime(stats.voiceSeconds)}`,
              inline: true,
            },
            {
              name: 'أول رسالة',
              value: `\u200E${relativeTime(stats.firstMessageAt)}`,
              inline: true,
            },
            {
              name: 'عضو منذ',
              value: member?.joinedTimestamp
                ? `\u200E${relativeTime(member.joinedTimestamp)}`
                : 'غير معروف',
              inline: true,
            },
          ],
          footer:
            `الرسائل منذ ${formatDate(messagesSince(ctx.guildId))}` +
            ` · الصوت منذ ${formatDate(voiceSince(ctx.guildId))}`,
        }),
      ],
      allowedMentions: { parse: [] },
    });
  },
};
