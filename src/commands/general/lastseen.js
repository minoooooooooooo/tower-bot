import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import {
  formatDate,
  formatNumber,
  formatVoiceTime,
  relativeTime,
} from '../../lib/activity-format.js';
import { embed, warningEmbed } from '../../lib/embeds.js';
import { resolveUser } from '../../lib/resolve.js';
import { memberStats, trackingSince } from '../../services/activity-store.js';

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
    .setDescription('Show when a member was last active')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('Member to look up (default: you)')
        .setRequired(false),
    ),

  name: 'lastseen',
  aliases: ['lastactive', 'lastactivity', 'seen', 'last'],
  description: 'Show when a member was last active',
  category: 'Activity',
  usage: 'lastseen [@member]',
  cooldown: 3,
  guildOnly: true,

  async execute(ctx, client) {
    const { user, member } = await resolveTarget(ctx, client);

    if (!user) {
      await ctx.fail({
        embeds: [
          warningEmbed(
            'Unknown member',
            'Mention a member or paste their id, then try again.',
          ),
        ],
      });
      return;
    }

    const stats = memberStats(ctx.guildId, user.id);

    if (stats.messages === 0 && stats.voiceSeconds === 0) {
      await ctx.reply({
        embeds: [
          warningEmbed(
            'No activity recorded',
            `\u200E<@${user.id}> has no messages or voice time yet. I only count while I am online.`,
          ),
        ],
        allowedMentions: { parse: [] },
      });
      return;
    }

    // Values start with an LRM so an RTL client cannot flip a timestamp or a
    // number away from its label.
    await ctx.reply({
      embeds: [
        embed({
          title: 'Member activity',
          description: `\u200E<@${user.id}>`,
          fields: [
            {
              name: 'Last active',
              value: `\u200E${relativeTime(stats.lastActiveAt)}`,
              inline: true,
            },
            {
              name: 'Last message',
              value: `\u200E${relativeTime(stats.lastMessageAt)}`,
              inline: true,
            },
            {
              name: 'Messages',
              value: `\u200E${formatNumber(stats.messages)}`,
              inline: true,
            },
            {
              name: 'Voice time',
              value: `\u200E${formatVoiceTime(stats.voiceSeconds)}`,
              inline: true,
            },
            {
              name: 'First message',
              value: `\u200E${relativeTime(stats.firstMessageAt)}`,
              inline: true,
            },
            {
              name: 'Member since',
              value: member?.joinedTimestamp
                ? `\u200E${relativeTime(member.joinedTimestamp)}`
                : 'Unknown',
              inline: true,
            },
          ],
          footer: `All time · tracking since ${formatDate(trackingSince(ctx.guildId))}`,
        }),
      ],
      allowedMentions: { parse: [] },
    });
  },
};
