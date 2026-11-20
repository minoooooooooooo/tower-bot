import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { targetMember } from '../../lib/targets.js';
import { actorProblem, targetProblem } from '../../services/moderation.js';
import { apiProblem, defaultReason, done, fail, info, slashReason } from './_shared.js';

export default {
  data: new SlashCommandBuilder()
    .setName('untimeout')
    .setDescription('أنهِ تايم أوت عضو قبل وقته')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('العضو المطلوب إنهاء التايم أوت عنه').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('سبب إنهاء التايم أوت').setRequired(false),
    ),

  name: 'untimeout',
  aliases: ['untimedout'],
  description: 'أنهِ تايم أوت عضو قبل وقته',
  category: 'Moderation',
  usage: 'untimeout <@member> [reason]',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ModerateMembers'],

  async execute(ctx) {
    const member = await targetMember(ctx);

    if (!member) {
      await fail(
        ctx,
        'العضو غير موجود',
        `اذكر العضو أو الصق الآيدي، مثال: \`${ctx.isSlash ? '/untimeout user:@member' : ':-untimeout @member'}\`.`,
      );
      return;
    }

    const issue =
      targetProblem(ctx.guild, member, ctx.user.id) ??
      actorProblem(ctx.guild, ctx.member, member);

    if (issue) {
      await fail(ctx, 'ما أقدر أعدّل هذا التايم أوت', issue);
      return;
    }

    if (!member.isCommunicationDisabled?.()) {
      await info(ctx, 'ما عليه تايم أوت', `${member} ما عليه تايم أوت حاليًا.`);
      return;
    }

    const reason = defaultReason(
      ctx.isSlash ? slashReason(ctx) : ctx.args.slice(1).join(' ').trim(),
    );

    try {
      await member.timeout(null, `إنهاء تايم أوت بواسطة ${ctx.user.tag ?? ctx.user.username}: ${reason}`);
    } catch (error) {
      await fail(ctx, 'تعذر إنهاء التايم أوت', apiProblem(error));
      return;
    }

    await done(ctx, 'انتهى التايم أوت', `${member} يقدر يتكلم من جديد.\n**السبب:** ${reason}`);
  },
};
