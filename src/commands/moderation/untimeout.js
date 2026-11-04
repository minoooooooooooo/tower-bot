import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { targetMember } from '../../lib/targets.js';
import { actorProblem, targetProblem } from '../../services/moderation.js';
import { apiProblem, defaultReason, done, fail, info, slashReason } from './_shared.js';

export default {
  data: new SlashCommandBuilder()
    .setName('untimeout')
    .setDescription('End a member’s timeout early')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('Member whose timeout ends').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('Why the timeout is ending').setRequired(false),
    ),

  name: 'untimeout',
  aliases: ['untimedout'],
  description: 'End a member’s timeout early',
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
        'Unknown member',
        `Mention the member or paste their id, for example \`${ctx.isSlash ? '/untimeout user:@member' : ':-untimeout @member'}\`.`,
      );
      return;
    }

    const issue =
      targetProblem(ctx.guild, member, ctx.user.id) ??
      actorProblem(ctx.guild, ctx.member, member);

    if (issue) {
      await fail(ctx, 'Cannot change that timeout', issue);
      return;
    }

    if (!member.isCommunicationDisabled?.()) {
      await info(ctx, 'Not timed out', `${member} is not currently timed out.`);
      return;
    }

    const reason = defaultReason(
      ctx.isSlash ? slashReason(ctx) : ctx.args.slice(1).join(' ').trim(),
    );

    try {
      await member.timeout(null, `Timeout ended by ${ctx.user.tag ?? ctx.user.username}: ${reason}`);
    } catch (error) {
      await fail(ctx, 'Could not end the timeout', apiProblem(error));
      return;
    }

    await done(ctx, 'Timeout ended', `${member} can talk again.\n**Reason:** ${reason}`);
  },
};
