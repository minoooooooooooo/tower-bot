import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { targetMember } from '../../lib/targets.js';
import { actorProblem, targetProblem } from '../../services/moderation.js';
import { deleteExpiry, getMuteRoleId } from '../../services/moderation-store.js';
import { apiProblem, defaultReason, done, fail, info, slashReason } from './_shared.js';

export default {
  data: new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('Remove the Muted role from a member')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('Member to unmute').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('Why they are being unmuted').setRequired(false),
    ),

  name: 'unmute',
  description: 'Remove the Muted role from a member',
  category: 'Moderation',
  usage: 'unmute <@member> [reason]',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ManageRoles'],

  async execute(ctx) {
    const member = await targetMember(ctx);

    if (!member) {
      await fail(
        ctx,
        'Unknown member',
        `Mention the member or paste their id, for example \`${ctx.isSlash ? '/unmute user:@member' : ':-unmute @member'}\`.`,
      );
      return;
    }

    const issue =
      targetProblem(ctx.guild, member, ctx.user.id) ??
      actorProblem(ctx.guild, ctx.member, member);

    if (issue) {
      await fail(ctx, 'Cannot unmute that member', issue);
      return;
    }

    const roleId = getMuteRoleId(ctx.guildId);
    const role =
      (roleId &&
        (ctx.guild.roles.cache.get(roleId) ??
          (await ctx.guild.roles.fetch(roleId).catch(() => null)))) ||
      ctx.guild.roles.cache.find(
        (candidate) => !candidate.managed && candidate.name.toLowerCase() === 'muted',
      ) ||
      null;

    if (!role || !member.roles.cache.has(role.id)) {
      deleteExpiry(ctx.guildId, member.id, 'mute');
      await info(ctx, 'Not muted', `${member} does not have the muted role.`);
      return;
    }

    const reason = defaultReason(
      ctx.isSlash ? slashReason(ctx) : ctx.args.slice(1).join(' ').trim(),
    );

    try {
      await member.roles.remove(
        role,
        `Unmuted by ${ctx.user.tag ?? ctx.user.username}: ${reason}`,
      );
    } catch (error) {
      await fail(ctx, 'Could not unmute that member', apiProblem(error));
      return;
    }

    deleteExpiry(ctx.guildId, member.id, 'mute');

    await done(
      ctx,
      'Member unmuted',
      `${member} no longer has ${role}.\n**Reason:** ${reason}`,
    );
  },
};
