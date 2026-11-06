import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { formatDuration, parseDuration } from '../../lib/durations.js';
import { targetMember } from '../../lib/targets.js';
import {
  MAX_TIMEOUT_MS,
  actorProblem,
  botPermissionProblem,
  targetProblem,
} from '../../services/moderation.js';
import { recordPunishment } from '../../services/profile-store.js';
import {
  apiProblem,
  defaultReason,
  done,
  fail,
  prefixTimedArgs,
  slashReason,
} from './_shared.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export default {
  data: new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Time a member out (they cannot talk until it ends)')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('Member to time out').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('duration')
        .setDescription('How long, e.g. 40s, 10m, 2h, 7d (max 28d). Default 10m')
        .setRequired(false)
        .setMaxLength(20),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('Why they are being timed out').setRequired(false),
    ),

  name: 'timeout',
  aliases: ['to'],
  description: 'Time a member out for a fixed duration (max 28 days)',
  category: 'Moderation',
  usage: 'timeout <@member> [duration] [reason]',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ModerateMembers'],

  async execute(ctx) {
    const member = await targetMember(ctx);

    if (!member) {
      await fail(
        ctx,
        'Unknown member',
        `Mention the member or paste their id, for example \`${ctx.isSlash ? '/timeout user:@member duration:10m' : ':-timeout @member 10m spam'}\`.`,
      );
      return;
    }

    const issue =
      targetProblem(ctx.guild, member, ctx.user.id) ??
      actorProblem(ctx.guild, ctx.member, member) ??
      botPermissionProblem(ctx.guild, PermissionFlagsBits.ModerateMembers, 'Moderate Members');

    if (issue) {
      await fail(ctx, 'Cannot time that member out', issue);
      return;
    }

    let durationMs;
    let reasonText = '';

    if (ctx.isSlash) {
      const rawDuration = ctx.getString('duration');
      durationMs = rawDuration ? parseDuration(rawDuration) : DEFAULT_TIMEOUT_MS;

      if (!durationMs) {
        await fail(
          ctx,
          'Invalid duration',
          `\`${String(rawDuration).slice(0, 30)}\` is not a duration. Use \`40s\`, \`10m\`, \`2h\` or \`7d\`.`,
        );
        return;
      }

      reasonText = slashReason(ctx);
    } else {
      const parsed = prefixTimedArgs(ctx);
      durationMs = parsed.durationMs ?? DEFAULT_TIMEOUT_MS;
      reasonText = parsed.reason;
    }

    if (durationMs > MAX_TIMEOUT_MS) {
      await fail(ctx, 'Too long', 'Discord caps timeouts at **28 days**. Pick a shorter duration.');
      return;
    }

    const reason = defaultReason(reasonText);
    // Extending a timeout that is still running is the same punishment, not a
    // second one; only a timeout applied after it ended counts again.
    const wasTimedOut = member.isCommunicationDisabled?.() ?? false;

    try {
      await member.timeout(durationMs, `Timed out by ${ctx.user.tag ?? ctx.user.username}: ${reason}`);
    } catch (error) {
      await fail(ctx, 'Could not time that member out', apiProblem(error));
      return;
    }

    if (!wasTimedOut) recordPunishment(ctx.guildId, member.id, 'timeout');

    await done(
      ctx,
      'Member timed out',
      `${member} cannot talk for **${formatDuration(durationMs)}**.\n**Reason:** ${reason}`,
    );
  },
};
