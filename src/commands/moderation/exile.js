import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { resolveMember } from '../../lib/resolve.js';
import {
  EXILE_ACCESS_ROLE_ID,
  assignExileRole,
  manageableRoleProblem,
  memberProblem,
  resolveAccessRole,
  roleProblem,
  sendExileLog,
} from '../../services/exile.js';
import {
  EXILE_LEVELS,
  MAX_REASON_LENGTH,
  allExileRoleIds,
  createExile,
  getActiveExile,
  getRoleForLevel,
  isRoleSetUp,
  levelLabel,
  normalizeLevel,
  updateActiveExile,
} from '../../services/exile-store.js';
import { ensureExileBackfill, recordExilePoints } from '../../services/profile-store.js';
import { done, fail, info } from './_shared.js';

async function requireManageServer(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await fail(ctx, 'صلاحيات ناقصة', 'تحتاج **إدارة السيرفر** عشان تعزل الأعضاء.');

  return false;
}

const LEVEL_CHOICES = EXILE_LEVELS.map((level) => ({ name: levelLabel(level), value: level }));

/**
 * Prefix form is order tolerant: the member, an optional level and the rest of
 * the message as a reason. Prefix args never include the command name.
 */
async function parsePrefix(ctx) {
  let member = null;
  let level = 'main';
  let levelSeen = false;
  let problem = null;
  const reasonParts = [];

  for (const token of ctx.args) {
    if (!member) {
      const candidate = await resolveMember(ctx.guild, token, ctx.message);

      if (candidate) {
        member = candidate;
        continue;
      }
    }

    if (!levelSeen && /^\d+$/.test(token)) {
      const parsed = normalizeLevel(token);

      if (!parsed) {
        problem = `**${token}** مو مستوى. استخدم \`main\` أو من 1 إلى 10.`;
        break;
      }

      level = parsed;
      levelSeen = true;
      continue;
    }

    if (!levelSeen && /^(main|m|none)$/i.test(token)) {
      level = 'main';
      levelSeen = true;
      continue;
    }

    reasonParts.push(token);
  }

  return { member, level, reason: reasonParts.join(' ').trim(), problem };
}

export default {
  data: new SlashCommandBuilder()
    .setName('exile')
    .setDescription('أعطِ عضوًا رتبة عزل واخفِ السيرفر عنه')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('العضو اللي تبي تعزله').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('level')
        .setDescription('العزل الرئيسي أو مستوى شدة من 1 إلى 10 (الافتراضي: الرئيسي)')
        .setRequired(false)
        .addChoices(...LEVEL_CHOICES),
    )
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('سبب العزل (ينكتب في السجل)')
        .setRequired(false)
        .setMaxLength(MAX_REASON_LENGTH),
    ),

  name: 'exile',
  aliases: ['jail', 'prison'],
  description: 'أعطِ عضوًا رتبة عزل واخفِ السيرفر عنه',
  category: 'Moderation',
  usage: 'exile <@member> [main|1-10] [reason]',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ManageGuild'],

  async execute(ctx) {
    if (!(await requireManageServer(ctx))) return;

    // The one-time exile history import must finish before this command can
    // create a new row, or the new exile would be counted twice.
    try {
      ensureExileBackfill(ctx.guildId);
    } catch {
      // A failed import must not block moderation.
    }

    let member;
    let level;
    let reason;

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

      level = normalizeLevel(ctx.getString('level'));
      reason = (ctx.getString('reason') ?? '').trim();
    } else {
      const parsed = await parsePrefix(ctx);

      if (parsed.problem) {
        await fail(ctx, 'مستوى غير صحيح', parsed.problem);
        return;
      }

      member = parsed.member;
      level = parsed.level;
      reason = parsed.reason.slice(0, MAX_REASON_LENGTH);
    }

    if (!member) {
      await fail(
        ctx,
        'عضو غير معروف',
        `منشن العضو أو الصق الآيدي، مثل \`${ctx.isSlash ? '/exile user:@member level:1' : ':-exile @member 1 spam'}\`.`,
      );
      return;
    }

    const targetProblem = memberProblem(ctx.guild, member);

    if (targetProblem) {
      await fail(ctx, 'ما أقدر أعزل هذا العضو', targetProblem);
      return;
    }

    if (!level) {
      await fail(ctx, 'مستوى غير صحيح', 'استخدم `main` أو رقم من 1 إلى 10.');
      return;
    }

    const roleId = getRoleForLevel(ctx.guildId, level);

    if (!roleId) {
      await fail(
        ctx,
        `${levelLabel(level)} ما له رتبة`,
        `شغّل \`/exile-role set level:${level} role:@رتبتك\` أول.`,
      );
      return;
    }

    const role =
      ctx.guild.roles.cache.get(roleId) ??
      (await ctx.guild.roles.fetch(roleId).catch(() => null));

    if (!role) {
      await fail(
        ctx,
        'الرتبة المربوطة انحذفت',
        `رتبة **${levelLabel(level)}** ما عادت موجودة. اربط غيرها بـ \`/exile-role set level:${level} role:@رتبتك\`.`,
      );
      return;
    }

    const roleIssue = roleProblem(ctx.guild, role);

    if (roleIssue) {
      await fail(ctx, 'ما أقدر أستخدم هذي الرتبة', roleIssue);
      return;
    }

    if (!isRoleSetUp(ctx.guildId, role.id)) {
      await fail(
        ctx,
        'هذي الرتبة ما انضبطت',
        `بدون \`/exile-setup role:${role.name}\` الرتبة ما تخفي شي، والعضو بيظل يشوف كل القنوات. شغّل الإعداد أول.`,
      );
      return;
    }

    // The all-access role allows View Channel everywhere, so leaving it on
    // would defeat the exile. It is only skipped when it is itself one of the
    // configured exile roles, in which case assignExileRole owns it.
    const accessIsExileRole = allExileRoleIds(ctx.guildId).includes(EXILE_ACCESS_ROLE_ID);
    const accessRole = accessIsExileRole ? null : await resolveAccessRole(ctx.guild);
    let accessRemovedNow = false;

    if (accessRole) {
      const accessIssue = manageableRoleProblem(ctx.guild, accessRole);

      if (accessIssue) {
        await fail(
          ctx,
          'ما أقدر أشيل رتبة الوصول الكامل',
          `لازم أشيل ${accessRole} من العضو قبل أعزله، لكن ${accessIssue}`,
        );
        return;
      }

      if (member.roles.cache.has(accessRole.id)) {
        try {
          await member.roles.remove(
            accessRole.id,
            `عزل ${levelLabel(level)} بواسطة ${ctx.user.tag ?? ctx.user.username}`,
          );
          accessRemovedNow = true;
        } catch (error) {
          await fail(
            ctx,
            'ما قدرت أشيل رتبة الوصول الكامل',
            `ديسكورد رفض يشيل ${accessRole}: ${error.message}. العضو ما انعزل.`,
          );
          return;
        }
      }
    }

    const active = getActiveExile(ctx.guildId, member.id);
    const sameLevel = active?.level === level;
    const auditReason = reason || active?.reason || null;

    let assigned;

    try {
      assigned = await assignExileRole(
        member,
        role.id,
        `عزل ${levelLabel(level)} بواسطة ${ctx.user.tag ?? ctx.user.username}`,
      );
    } catch (error) {
      // Do not leave a member without their all-access role when the exile
      // itself failed. Nothing was recorded, so this must be undone.
      if (accessRemovedNow && accessRole && !member.roles.cache.has(accessRole.id)) {
        await member.roles
          .add(accessRole.id, 'إرجاع بعد عزل فاشل')
          .catch(() => null);
      }

      await fail(
        ctx,
        'ما قدرت أعطي الرتبة',
        `ديسكورد رفض التغيير: ${error.message}. تأكد أن رتبتي فوق ${role} وعندي **إدارة الرتب**.`,
      );
      return;
    }

    if (active) {
      updateActiveExile({
        guildId: ctx.guildId,
        userId: member.id,
        level,
        roleId: role.id,
        reason: auditReason,
        createdBy: ctx.user.id,
      });
    } else {
      createExile({
        guildId: ctx.guildId,
        userId: member.id,
        level,
        roleId: role.id,
        reason: auditReason,
        createdBy: ctx.user.id,
      });
    }

    // Main is only a holding level; the points land when the exile is
    // forwarded to a numbered level. Escalating 3 → 6 adds the difference,
    // so the total follows the highest level reached.
    if (!sameLevel) {
      recordExilePoints(ctx.guildId, member.id, active?.level ?? 'main', level);
    }

    if (!sameLevel) {
      await sendExileLog(ctx.guild, {
        type: active ? 'level' : 'exile',
        userId: member.id,
        actorId: ctx.user.id,
        level,
        roleId: role.id,
        reason: auditReason,
        at: active?.createdAt ?? Date.now(),
        footer: active ? `المستوى السابق: ${levelLabel(active.level)}` : undefined,
      });
    }

    if (sameLevel) {
      await info(
        ctx,
        'معزول أصلًا',
        `${member} عنده **${levelLabel(level)}** من قبل.` +
          (auditReason ? `\nالسبب: ${auditReason}` : ''),
      );
      return;
    }

    const lines = [
      `${member} الحين في **${levelLabel(level)}** برتبة ${role}.`,
      active
        ? `المستوى السابق: **${levelLabel(active.level)}**.`
        : 'كل القنوات مخفية عنه إلا استثناءات هذا المستوى.',
      `السبب: ${auditReason || '—'}`,
    ];

    if (assigned.failed.length > 0) {
      lines.push(
        '',
        `⚠️ ما قدرت أشيل **${assigned.failed.length}** من رتب العزل القديمة؛ راجع ترتيب رتبتي.`,
      );
    }

    await done(
      ctx,
      active ? 'تغيّر مستوى العزل' : 'تم عزل العضو',
      lines.join('\n'),
    );
  },
};
