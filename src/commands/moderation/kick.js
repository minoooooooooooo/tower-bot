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
    .setDescription('اطرد عضوًا من السيرفر')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('العضو المطلوب طرده').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('سبب الطرد').setRequired(false),
    ),

  name: 'kick',
  description: 'اطرد عضوًا من السيرفر',
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
        'العضو غير موجود',
        `اذكر العضو أو الصق الآيدي، مثال: \`${ctx.isSlash ? '/kick user:@member' : ':-kick @member spam'}\`.`,
      );
      return;
    }

    const issue =
      targetProblem(ctx.guild, member, ctx.user.id, { allowBot: true }) ??
      actorProblem(ctx.guild, ctx.member, member) ??
      botPermissionProblem(ctx.guild, PermissionFlagsBits.KickMembers, 'Kick Members');

    if (issue) {
      await fail(ctx, 'ما أقدر أطرد هذا العضو', issue);
      return;
    }

    const reason = defaultReason(
      ctx.isSlash ? slashReason(ctx) : ctx.args.slice(1).join(' ').trim(),
    );

    try {
      await member.kick(`طرد بواسطة ${ctx.user.tag ?? ctx.user.username}: ${reason}`);
    } catch (error) {
      await fail(ctx, 'تعذر طرد العضو', apiProblem(error));
      return;
    }

    recordPunishment(ctx.guildId, member.id, 'kick');

    await done(ctx, 'تم الطرد', `${member.user?.tag ?? member.id} انطرد.\n**السبب:** ${reason}`);
  },
};
