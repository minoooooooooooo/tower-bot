import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { targetMember } from '../../lib/targets.js';
import { actorProblem, targetProblem } from '../../services/moderation.js';
import { deleteExpiry, getMuteRoleId } from '../../services/moderation-store.js';
import { apiProblem, defaultReason, done, fail, info, slashReason } from './_shared.js';

export default {
  data: new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('شِل رتبة الكتم عن عضو')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('العضو المطلوب إلغاء كتمه').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('سبب إلغاء الكتم').setRequired(false),
    ),

  name: 'unmute',
  description: 'شِل رتبة الكتم عن عضو',
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
        'العضو غير موجود',
        `اذكر العضو أو الصق الآيدي، مثال: \`${ctx.isSlash ? '/unmute user:@member' : ':-unmute @member'}\`.`,
      );
      return;
    }

    const issue =
      targetProblem(ctx.guild, member, ctx.user.id) ??
      actorProblem(ctx.guild, ctx.member, member);

    if (issue) {
      await fail(ctx, 'ما أقدر ألغي كتم هذا العضو', issue);
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
      await info(ctx, 'غير مكتوم', `${member} ما عنده رتبة الكتم.`);
      return;
    }

    const reason = defaultReason(
      ctx.isSlash ? slashReason(ctx) : ctx.args.slice(1).join(' ').trim(),
    );

    try {
      await member.roles.remove(
        role,
        `إلغاء كتم بواسطة ${ctx.user.tag ?? ctx.user.username}: ${reason}`,
      );
    } catch (error) {
      await fail(ctx, 'تعذر إلغاء الكتم', apiProblem(error));
      return;
    }

    deleteExpiry(ctx.guildId, member.id, 'mute');

    await done(
      ctx,
      'تم إلغاء الكتم',
      `${member} ما عاد عليه ${role}.\n**السبب:** ${reason}`,
    );
  },
};
