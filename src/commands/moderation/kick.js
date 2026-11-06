import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { targetMember } from '../../lib/targets.js';
import {
  actorProblem,
  botPermissionProblem,
  targetProblem,
} from '../../services/moderation.js';
import { apiProblem, defaultReason, done, fail, slashReason } from './_shared.js';
import { recordPunishment } from '../../services/profile-store.js';

export default {
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a member from the server')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('Member to kick').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('Why they are being kicked').setRequired(false),
    ),

  name: 'kick',
  description: 'Kick a member from the server',
  category: 'Moderation',
  usage: 'kick <@member> [reason]',
  cooldown: 3,
  guildOnly: true,
  permissions: ['KickMembers'],

  async execute(ctx) {
    const member = await targetMember(ctx);

    if (!member) {
      await fail(
        ctx,
        'Unknown member',
        `Mention the member or paste their id, for example \`${ctx.isSlash ? '/kick user:@member' : ':-kick @member spam'}\`.`,
      );
      return;
    }

    const issue =
      targetProblem(ctx.guild, member, ctx.user.id, { allowBot: true }) ??
      actorProblem(ctx.guild, ctx.member, member) ??
      botPermissionProblem(ctx.guild, PermissionFlagsBits.KickMembers, 'Kick Members');

    if (issue) {
      await fail(ctx, 'Cannot kick that member', issue);
      return;
    }

    const reason = defaultReason(
      ctx.isSlash ? slashReason(ctx) : ctx.args.slice(1).join(' ').trim(),
    );

    try {
      await member.kick(`Kicked by ${ctx.user.tag ?? ctx.user.username}: ${reason}`);
    } catch (error) {
      await fail(ctx, 'Could not kick that member', apiProblem(error));
      return;
    }

    recordPunishment(ctx.guildId, member.id, 'kick');

    await done(ctx, 'Member kicked', `${member.user?.tag ?? member.id} was kicked.\n**Reason:** ${reason}`);
  },
};
