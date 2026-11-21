import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { formatDurationArabic } from '../../lib/durations.js';
import { resolveMember } from '../../lib/resolve.js';
import {
  EXILE_ACCESS_ROLE_ID,
  manageableRoleProblem,
  removeExileRoles,
  resolveAccessRole,
  sendExileLog,
} from '../../services/exile.js';
import {
  MAX_REASON_LENGTH,
  allExileRoleIds,
  getActiveExile,
  levelLabel,
  releaseActiveExile,
} from '../../services/exile-store.js';
import { done, fail, info } from './_shared.js';

async function requireManageServer(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await fail(ctx, 'صلاحيات ناقصة', 'تحتاج **إدارة السيرفر** عشان تفك العزل.');

  return false;
}

/**
 * Gives back the server-wide all-access role that `/exile` removed. A failure
 * is reported but never blocks the release: the exile role is already gone.
 */
async function restoreAccessRole(guild, member, actor) {
  const isExileRole = allExileRoleIds(guild.id).includes(EXILE_ACCESS_ROLE_ID);

  if (isExileRole) return { restored: false, failed: null };

  const role = await resolveAccessRole(guild);

  if (!role || member.roles.cache.has(role.id)) {
    return { restored: false, failed: null };
  }

  const issue = manageableRoleProblem(guild, role);

  if (issue) return { restored: false, failed: issue };

  try {
    await member.roles.add(role.id, `فك العزل بواسطة ${actor}`);
    return { restored: true, failed: null };
  } catch (error) {
    return { restored: false, failed: error.message };
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName('exile-release')
    .setDescription('اشل رتبة العزل عن عضو وخلّه يشوف السيرفر من جديد')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('العضو اللي تبي تفك عزله').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('سبب فك العزل (ينكتب في السجل)')
        .setRequired(false)
        .setMaxLength(MAX_REASON_LENGTH),
    ),

  name: 'exile-release',
  aliases: ['unjail', 'unexile'],
  description: 'اشل رتبة العزل عن عضو وخلّه يشوف السيرفر من جديد',
  category: 'Moderation',
  usage: 'exile-release <@member> [reason]',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ManageGuild'],

  async execute(ctx) {
    if (!(await requireManageServer(ctx))) return;

    let member;

    if (ctx.isSlash) {
      member = ctx.getMember('user') ?? null;

      if (!member) {
        const user = ctx.getUser('user');

        if (user) {
          member =
            ctx.guild.members.cache.get(user.id) ??
            (await ctx.guild.members.fetch(user.id).catch(() => null));
        }
      }
    } else {
      member = await resolveMember(ctx.guild, ctx.args[0], ctx.message);
    }

    if (!member) {
      await fail(
        ctx,
        'عضو غير معروف',
        `منشن العضو أو الصق الآيدي، مثل \`${ctx.isSlash ? '/exile-release user:@member' : ':-exile-release @member قبلت الاستئناف'}\`.`,
      );
      return;
    }

    const reason = ((ctx.isSlash ? ctx.getString('reason') : ctx.args.slice(1).join(' '))?.trim() ?? '').slice(
      0,
      MAX_REASON_LENGTH,
    );
    const active = getActiveExile(ctx.guildId, member.id);

    if (!active) {
      const cleanup = await removeExileRoles(member, null, `تنظيف عزل بواسطة ${ctx.user.tag ?? ctx.user.username}`);

      if (cleanup.removed.length === 0) {
        await info(ctx, 'مو معزول', `${member} ما عنده عزل شغّال.`);
        return;
      }

      const access = await restoreAccessRole(
        ctx.guild,
        member,
        ctx.user.tag ?? ctx.user.username,
      );
      const lines = [
        `${member} كان عنده رتبة عزل بدون سجل. شلت **${cleanup.removed.length}** من رتب العزل؛ الحين يقدر يشوف السيرفر.`,
      ];

      if (access.restored) lines.push(`رجّعت <@&${EXILE_ACCESS_ROLE_ID}>.`);
      if (access.failed) {
        lines.push('', `⚠️ ما قدرت أرجّع <@&${EXILE_ACCESS_ROLE_ID}>: ${access.failed}`);
      }

      await done(ctx, 'شلت رتبة عزل قديمة', lines.join('\n'));
      return;
    }

    let result;

    try {
      result = await removeExileRoles(
        member,
        active.roleId,
        `فك العزل بواسطة ${ctx.user.tag ?? ctx.user.username}`,
      );
    } catch (error) {
      await fail(
        ctx,
        'ما قدرت أشيل الرتبة',
        `ديسكورد رفض التغيير: ${error.message}. تأكد أن رتبتي فوق رتبة العزل.`,
      );
      return;
    }

    // The active role must be gone before the record is marked released,
    // otherwise the list would claim a member is free while still restricted.
    if (member.roles.cache.has(active.roleId)) {
      await fail(
        ctx,
        'رتبة العزل لسا موجودة',
        `ما قدرت أشيل <@&${active.roleId}>. ارفع رتبتي فوقها وجرّب؛ العزل يبقى شغّال لين تنجح.`,
      );
      return;
    }

    const access = await restoreAccessRole(
      ctx.guild,
      member,
      ctx.user.tag ?? ctx.user.username,
    );

    releaseActiveExile({
      guildId: ctx.guildId,
      userId: member.id,
      releasedBy: ctx.user.id,
      reason: reason || 'بدون سبب',
    });

    await sendExileLog(ctx.guild, {
      type: 'release',
      userId: member.id,
      actorId: ctx.user.id,
      level: active.level,
      roleId: active.roleId,
      reason: reason || 'بدون سبب',
      at: active.createdAt,
      releasedAt: Date.now(),
      footer: `محجوز لمدة ${formatDurationArabic(Date.now() - active.createdAt)}`,
    });

    const lines = [
      `${member} صار حر — شلت <@&${active.roleId}>.`,
      `كان في **${levelLabel(active.level)}** لمدة **${formatDurationArabic(Date.now() - active.createdAt)}**.`,
      `السبب: ${reason || 'بدون سبب'}`,
    ];

    if (access.restored) lines.push(`رجّعت <@&${EXILE_ACCESS_ROLE_ID}>.`);
    if (access.failed) {
      lines.push('', `⚠️ ما قدرت أرجّع <@&${EXILE_ACCESS_ROLE_ID}>: ${access.failed}`);
    }

    if (result.failed.length > 0) {
      lines.push(
        '',
        `⚠️ **${result.failed.length}** من رتب العزل الثانية ما انشالت. راجع ترتيب رتبتي.`,
      );
    }

    await done(ctx, 'تم فك العزل', lines.join('\n'));
  },
};
