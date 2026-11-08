import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { errorEmbed, infoEmbed, successEmbed } from '../../lib/embeds.js';
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

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

async function requireManageServer(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await ctx.reply(
    ephemeral({
      embeds: [errorEmbed('Missing permissions', 'You need **Manage Server** to exile members.')],
    }),
  );

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
        problem = `**${token}** is not a level. Use \`main\` or 1–10.`;
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
    .setDescription('Give a member an exile role and hide the server from them')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('Member to exile').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('level')
        .setDescription('Main exile or a severity level 1–10 (default: main)')
        .setRequired(false)
        .addChoices(...LEVEL_CHOICES),
    )
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('Why this member is being exiled (shown in the log)')
        .setRequired(false)
        .setMaxLength(MAX_REASON_LENGTH),
    ),

  name: 'exile',
  aliases: ['jail', 'prison'],
  description: 'Give a member an exile role and hide the server from them',
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
        await ctx.reply(ephemeral({ embeds: [errorEmbed('Invalid level', parsed.problem)] }));
        return;
      }

      member = parsed.member;
      level = parsed.level;
      reason = parsed.reason.slice(0, MAX_REASON_LENGTH);
    }

    if (!member) {
      await ctx.reply(
        ephemeral({
          embeds: [
            errorEmbed(
              'Unknown member',
              `Mention the member or paste their id, for example \`${ctx.isSlash ? '/exile user:@member level:1' : ':-exile @member 1 spam'}\`.`,
            ),
          ],
        }),
      );
      return;
    }

    const targetProblem = memberProblem(ctx.guild, member);

    if (targetProblem) {
      await ctx.reply(ephemeral({ embeds: [errorEmbed('Cannot exile that member', targetProblem)] }));
      return;
    }

    if (!level) {
      await ctx.reply(ephemeral({ embeds: [errorEmbed('Invalid level', 'Use `main` or 1–10.')] }));
      return;
    }

    const roleId = getRoleForLevel(ctx.guildId, level);

    if (!roleId) {
      await ctx.reply(
        ephemeral({
          embeds: [
            errorEmbed(
              `${levelLabel(level)} has no role`,
              `Run \`/exile-role set level:${level} role:@YourRole\` first.`,
            ),
          ],
        }),
      );
      return;
    }

    const role =
      ctx.guild.roles.cache.get(roleId) ??
      (await ctx.guild.roles.fetch(roleId).catch(() => null));

    if (!role) {
      await ctx.reply(
        ephemeral({
          embeds: [
            errorEmbed(
              'The mapped role is gone',
              `The role for **${levelLabel(level)}** no longer exists. Map another one with \`/exile-role set level:${level} role:@YourRole\`.`,
            ),
          ],
        }),
      );
      return;
    }

    const roleIssue = roleProblem(ctx.guild, role);

    if (roleIssue) {
      await ctx.reply(ephemeral({ embeds: [errorEmbed('Cannot use that role', roleIssue)] }));
      return;
    }

    if (!isRoleSetUp(ctx.guildId, role.id)) {
      await ctx.reply(
        ephemeral({
          embeds: [
            errorEmbed(
              'That role was never set up',
              `Without \`/exile-setup role:${role.name}\` the role hides nothing, so the member would keep seeing every channel. Run setup first.`,
            ),
          ],
        }),
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
        await ctx.reply(
          ephemeral({
            embeds: [
              errorEmbed(
                'Cannot remove the all-access role',
                `I must take ${accessRole} off the member before exiling them, but ${accessIssue}`,
              ),
            ],
          }),
        );
        return;
      }

      if (member.roles.cache.has(accessRole.id)) {
        try {
          await member.roles.remove(
            accessRole.id,
            `Exile ${levelLabel(level)} by ${ctx.user.tag ?? ctx.user.username}`,
          );
          accessRemovedNow = true;
        } catch (error) {
          await ctx.reply(
            ephemeral({
              embeds: [
                errorEmbed(
                  'Could not remove the all-access role',
                  `Discord refused to remove ${accessRole}: ${error.message}. The member was not exiled.`,
                ),
              ],
            }),
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
        `Exile ${levelLabel(level)} by ${ctx.user.tag ?? ctx.user.username}`,
      );
    } catch (error) {
      // Do not leave a member without their all-access role when the exile
      // itself failed. Nothing was recorded, so this must be undone.
      if (accessRemovedNow && accessRole && !member.roles.cache.has(accessRole.id)) {
        await member.roles
          .add(accessRole.id, 'Restore after a failed exile')
          .catch(() => null);
      }

      await ctx.reply(
        ephemeral({
          embeds: [
            errorEmbed(
              'Could not assign the role',
              `Discord refused the change: ${error.message}. Check that my role is above ${role} and that I still have **Manage Roles**.`,
            ),
          ],
        }),
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
        footer: active ? `Previous level: ${levelLabel(active.level)}` : undefined,
      });
    }

    const lines = [
      `${member} is now at **${levelLabel(level)}** with the ${role} role.`,
      active
        ? `Previous level: **${levelLabel(active.level)}**.`
        : 'Every channel except this level’s exceptions is hidden from them.',
      `Reason: ${auditReason || '—'}`,
    ];

    if (assigned.failed.length > 0) {
      lines.push(
        '',
        `⚠️ I could not remove ${assigned.failed.length} older exile role${assigned.failed.length === 1 ? '' : 's'}; check my role position.`,
      );
    }

    await ctx.reply(
      ephemeral({
        embeds: [
          sameLevel
            ? infoEmbed(
                'Already exiled',
                `${member} already holds **${levelLabel(level)}**. ${auditReason ? `Reason: ${auditReason}` : ''}`.trim(),
              )
            : successEmbed(active ? 'Exile level changed' : 'Member exiled', lines.join('\n')),
        ],
      }),
    );
  },
};
