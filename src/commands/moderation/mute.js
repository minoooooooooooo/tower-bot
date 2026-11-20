import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { formatDuration, parseDuration } from '../../lib/durations.js';
import { targetMember } from '../../lib/targets.js';
import { targetProblem, actorProblem, ensureMuteRole, muteRoleProblem } from '../../services/moderation.js';
import { deleteExpiry, setExpiry } from '../../services/moderation-store.js';
import { recordPunishment } from '../../services/profile-store.js';
import {
  apiProblem,
  defaultReason,
  done,
  fail,
  info,
  prefixTimedArgs,
  slashReason,
} from './_shared.js';

export default {
  data: new SlashCommandBuilder()
    .setName('mute')
    .setDescription('اكتم عضوًا برتبة الكتم')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('العضو المطلوب كتمه').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('duration')
        .setDescription('المدة، مثل 40s أو 10m أو 2h أو 7d — اتركها فاضية لين ينرفع الكتم')
        .setRequired(false)
        .setMaxLength(20),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('سبب الكتم').setRequired(false),
    ),

  name: 'mute',
  aliases: ['mute-member'],
  description: 'اكتم عضوًا برتبة الكتم، مع خيار المدة',
  category: 'Moderation',
  usage: 'mute <@member> [40s|10m|2h|7d] [reason]',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ManageRoles'],

  async execute(ctx) {
    const member = await targetMember(ctx);

    if (!member) {
      await fail(
        ctx,
        'العضو غير موجود',
        `اذكر العضو أو الصق الآيدي، مثال: \`${ctx.isSlash ? '/mute user:@member 10m spam' : ':-mute @member 10m spam'}\`.`,
      );
      return;
    }

    const issue =
      targetProblem(ctx.guild, member, ctx.user.id) ??
      actorProblem(ctx.guild, ctx.member, member);

    if (issue) {
      await fail(ctx, 'ما أقدر أكتم هذا العضو', issue);
      return;
    }

    if (member.permissions?.has(PermissionFlagsBits.Administrator)) {
      await fail(
        ctx,
        'ما يمكن كتم هذا العضو',
        'عنده **Administrator**، وهذا يتجاوز صلاحيات القنوات فالكتم ما راح يأثر. شِل Administrator أول.',
      );
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

    // Creating the role and its overwrites can take a few seconds on a busy
    // server, so acknowledge before touching Discord.
    await ctx.defer({ ephemeral: true });

    const setup = await ensureMuteRole(ctx.guild);

    if (setup.problem) {
      await fail(ctx, 'تعذر تجهيز رتبة الكتم', setup.problem);
      return;
    }

    const roleIssue = muteRoleProblem(ctx.guild, setup.role);

    if (roleIssue) {
      await fail(ctx, 'تعذر إعطاء رتبة الكتم', roleIssue);
      return;
    }

    if (member.roles.cache.has(setup.role.id)) {
      if (durationMs) {
        setExpiry({
          guildId: ctx.guildId,
          userId: member.id,
          kind: 'mute',
          roleId: setup.role.id,
          expiresAt: Date.now() + durationMs,
          createdBy: ctx.user.id,
          reason,
        });
      } else {
        deleteExpiry(ctx.guildId, member.id, 'mute');
      }

      await info(
        ctx,
        'مكتوم أصلًا',
        `${member} عنده ${setup.role} من قبل.${
          durationMs
            ? ` صارت المدة الآن **${formatDuration(durationMs)}**.`
            : ' صار الكتم مفتوح لين أحد يلغيه.'
        }`,
      );
      return;
    }

    try {
      await member.roles.add(setup.role, `كتم بواسطة ${ctx.user.tag ?? ctx.user.username}: ${reason}`);
    } catch (error) {
      await fail(ctx, 'تعذر كتم العضو', apiProblem(error));
      return;
    }

    // The branch above already handled "already muted", so reaching this point
    // always means a fresh punishment.
    recordPunishment(ctx.guildId, member.id, 'mute');

    if (durationMs) {
      setExpiry({
        guildId: ctx.guildId,
        userId: member.id,
        kind: 'mute',
        roleId: setup.role.id,
        expiresAt: Date.now() + durationMs,
        createdBy: ctx.user.id,
        reason,
      });
    } else {
      deleteExpiry(ctx.guildId, member.id, 'mute');
    }

    const lines = [
      `${member} انكتم بـ ${setup.role} ${
        durationMs ? `لمدة **${formatDuration(durationMs)}**` : 'لين أحد يلغي الكتم'
      }.`,
      `**السبب:** ${reason}`,
    ];

    if (setup.created) {
      lines.push(
        '',
        `أنشأت رتبة **${setup.role.name}** وطبّقت الكتم في ${setup.updated} قناة.`,
      );
    }

    if (setup.failed?.length) {
      lines.push(
        '',
        `⚠️ ${setup.failed.length} قناة ما انكتمت. تأكد من صلاحية **إدارة الرتب** ومن ترتيب رتبتي.`,
      );
    }

    await done(ctx, 'تم الكتم', lines.join('\n'));
  },
};
