import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { formatDuration, parseDuration } from '../../lib/durations.js';
import { resolveUser } from '../../lib/resolve.js';
import {
  actorProblem,
  botPermissionProblem,
  targetProblem,
} from '../../services/moderation.js';
import { deleteExpiry, setExpiry } from '../../services/moderation-store.js';
import { recordPunishment } from '../../services/profile-store.js';
import {
  apiProblem,
  defaultReason,
  done,
  fail,
  prefixTimedArgs,
  slashReason,
} from './_shared.js';

export default {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('احظر مستخدمًا، مع خيار الحظر المؤقت')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('المستخدم المطلوب حظره').setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('id')
        .setDescription('آيدي المستخدم، إذا مو موجود في السيرفر')
        .setRequired(false)
        .setMaxLength(20),
    )
    .addStringOption((option) =>
      option
        .setName('duration')
        .setDescription('حظر مؤقت، مثل 40s أو 10m أو 2h أو 7d — اتركه فاضي للحظر الدائم')
        .setRequired(false)
        .setMaxLength(20),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('سبب الحظر').setRequired(false),
    ),

  name: 'ban',
  description: 'احظر مستخدمًا بشكل دائم أو لمدة محددة',
  category: 'Moderation',
  usage: 'ban <@user> [40s|10m|2h|7d] [reason]',
  cooldown: 3,
  guildOnly: true,
  permissions: ['BanMembers'],

  async execute(ctx, client) {
    const picked = ctx.isSlash ? ctx.getUser('user') : null;
    const raw = picked?.id ?? (ctx.isSlash ? ctx.getString('id') : ctx.args[0]);
    const user = picked ?? (raw ? await resolveUser(client, raw, ctx.message) : null);
    const userId = user?.id ?? (/^\d{17,20}$/.test(String(raw ?? '')) ? String(raw) : null);

    if (!userId) {
      await fail(
        ctx,
        'المستخدم غير موجود',
        `اذكر المستخدم أو الصق الآيدي، مثال: \`${ctx.isSlash ? '/ban user:@name 7d raiding' : ':-ban 123456789012345678 7d raiding'}\`.`,
      );
      return;
    }

    if (userId === ctx.user.id) {
      await fail(ctx, 'ما تقدر تحظر نفسك', 'اختر مستخدمًا ثاني.');
      return;
    }

    if (userId === ctx.guild.ownerId) {
      await fail(
        ctx,
        'ما يمكن حظر المالك',
        'مالك السيرفر ما ينحظر — المالك يتجاوز كل الصلاحيات.',
      );
      return;
    }

    if (userId === client.user?.id) {
      await fail(ctx, 'ما تقدر تحظرني', 'اختر مستخدمًا ثاني.');
      return;
    }

    const member =
      ctx.guild.members.cache.get(userId) ??
      (await ctx.guild.members.fetch(userId).catch(() => null));

    if (member) {
      const issue =
        targetProblem(ctx.guild, member, ctx.user.id, { allowBot: true }) ??
        actorProblem(ctx.guild, ctx.member, member);

      if (issue) {
        await fail(ctx, 'ما أقدر أحظر هذا العضو', issue);
        return;
      }
    }

    const permissionIssue = botPermissionProblem(
      ctx.guild,
      PermissionFlagsBits.BanMembers,
      'Ban Members',
    );

    if (permissionIssue) {
      await fail(ctx, 'ما أقدر أحظر', permissionIssue);
      return;
    }

    let durationMs = null;
    let reasonText = '';

    if (ctx.isSlash) {
      const rawDuration = ctx.getString('duration');

      if (rawDuration) {
        durationMs = parseDuration(rawDuration);

        if (!durationMs) {
          await fail(
            ctx,
            'مدة غير صحيحة',
            `\`${String(rawDuration).slice(0, 30)}\` مو مدة. استخدم \`40s\` أو \`10m\` أو \`2h\` أو \`7d\`.`,
          );
          return;
        }
      }

      reasonText = slashReason(ctx);
    } else {
      const parsed = prefixTimedArgs(ctx);
      durationMs = parsed.durationMs;
      reasonText = parsed.reason;
    }

    const reason = defaultReason(reasonText);

    // Discord's ban endpoint is idempotent, so banning someone who is already
    // banned must not earn a second punishment point.
    const alreadyBanned = await ctx.guild.bans
      .fetch(userId)
      .then(() => true)
      .catch(() => false);

    try {
      await ctx.guild.members.ban(userId, {
        reason: `حظر بواسطة ${ctx.user.tag ?? ctx.user.username}: ${reason}`,
        deleteMessageSeconds: 0,
      });
    } catch (error) {
      await fail(ctx, 'تعذر الحظر', apiProblem(error));
      return;
    }

    if (!alreadyBanned) recordPunishment(ctx.guildId, userId, 'ban');

    if (durationMs) {
      setExpiry({
        guildId: ctx.guildId,
        userId,
        kind: 'ban',
        expiresAt: Date.now() + durationMs,
        createdBy: ctx.user.id,
        reason,
      });
    } else {
      deleteExpiry(ctx.guildId, userId, 'ban');
    }

    const lines = [
      `${user?.tag ?? `<@${userId}>`} انحظر ${
        durationMs ? `لمدة **${formatDuration(durationMs)}**` : 'دائمًا'
      }.`,
      `**السبب:** ${reason}`,
    ];

    if (durationMs) {
      lines.push('الحظر المؤقت ينرفع تلقائيًا خلال دقيقة من انتهائه.');
    }

    await done(ctx, 'تم الحظر', lines.join('\n'));
  },
};
