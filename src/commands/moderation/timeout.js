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
    .setDescription('اعطِ عضوًا تايم أوت (ما يقدر يتكلم لين ينتهي)')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('العضو المطلوب').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('duration')
        .setDescription('المدة، مثل 40s أو 10m أو 2h أو 7d (أقصاها 28 يومًا). الافتراضي 10m')
        .setRequired(false)
        .setMaxLength(20),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('سبب التايم أوت').setRequired(false),
    ),

  name: 'timeout',
  aliases: ['to'],
  description: 'اعطِ عضوًا تايم أوت لمدة محددة (أقصاها 28 يومًا)',
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
        'العضو غير موجود',
        `اذكر العضو أو الصق الآيدي، مثال: \`${ctx.isSlash ? '/timeout user:@member duration:10m' : ':-timeout @member 10m spam'}\`.`,
      );
      return;
    }

    const issue =
      targetProblem(ctx.guild, member, ctx.user.id) ??
      actorProblem(ctx.guild, ctx.member, member) ??
      botPermissionProblem(ctx.guild, PermissionFlagsBits.ModerateMembers, 'Moderate Members');

    if (issue) {
      await fail(ctx, 'ما أقدر أعطي هذا العضو تايم أوت', issue);
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
          'مدة غير صحيحة',
          `\`${String(rawDuration).slice(0, 30)}\` مو مدة. استخدم \`40s\` أو \`10m\` أو \`2h\` أو \`7d\`.`,
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
      await fail(ctx, 'المدة طويلة', 'ديسكورد يحدد التايم أوت بـ **28 يومًا** كحد أقصى. اختر مدة أقصر.');
      return;
    }

    const reason = defaultReason(reasonText);
    // Extending a timeout that is still running is the same punishment, not a
    // second one; only a timeout applied after it ended counts again.
    const wasTimedOut = member.isCommunicationDisabled?.() ?? false;

    try {
      await member.timeout(durationMs, `تايم أوت بواسطة ${ctx.user.tag ?? ctx.user.username}: ${reason}`);
    } catch (error) {
      await fail(ctx, 'تعذر التايم أوت', apiProblem(error));
      return;
    }

    if (!wasTimedOut) recordPunishment(ctx.guildId, member.id, 'timeout');

    await done(
      ctx,
      'تم التايم أوت',
      `${member} ما يقدر يتكلم لمدة **${formatDuration(durationMs)}**.\n**السبب:** ${reason}`,
    );
  },
};
