import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { formatDuration, parseDuration } from '../../lib/durations.js';
import { targetMember } from '../../lib/targets.js';
import { targetProblem, actorProblem, ensureMuteRole, muteRoleProblem } from '../../services/moderation.js';
import { deleteExpiry, setExpiry } from '../../services/moderation-store.js';
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
    .setDescription('Mute a member with the Muted role')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('Member to mute').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('duration')
        .setDescription('How long, e.g. 40s, 10m, 2h, 7d — leave empty until unmuted')
        .setRequired(false)
        .setMaxLength(20),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('Why they are being muted').setRequired(false),
    ),

  name: 'mute',
  aliases: ['mute-member'],
  description: 'Mute a member with the Muted role, optionally for a limited time',
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
        'Unknown member',
        `Mention the member or paste their id, for example \`${ctx.isSlash ? '/mute user:@member 10m spam' : ':-mute @member 10m spam'}\`.`,
      );
      return;
    }

    const issue =
      targetProblem(ctx.guild, member, ctx.user.id) ??
      actorProblem(ctx.guild, ctx.member, member);

    if (issue) {
      await fail(ctx, 'Cannot mute that member', issue);
      return;
    }

    if (member.permissions?.has(PermissionFlagsBits.Administrator)) {
      await fail(
        ctx,
        'Cannot mute that member',
        'That member has **Administrator**, which bypasses channel overwrites, so the mute would do nothing. Remove Administrator first.',
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
            'Invalid duration',
            `\`${String(rawDuration).slice(0, 30)}\` is not a duration. Use \`40s\`, \`10m\`, \`2h\` or \`7d\`.`,
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
      await fail(ctx, 'Could not prepare the muted role', setup.problem);
      return;
    }

    const roleIssue = muteRoleProblem(ctx.guild, setup.role);

    if (roleIssue) {
      await fail(ctx, 'Cannot apply the muted role', roleIssue);
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
        'Already muted',
        `${member} already has ${setup.role}.${
          durationMs
            ? ` The timer is now **${formatDuration(durationMs)}**.`
            : ' The mute is now indefinite until unmuted.'
        }`,
      );
      return;
    }

    try {
      await member.roles.add(setup.role, `Muted by ${ctx.user.tag ?? ctx.user.username}: ${reason}`);
    } catch (error) {
      await fail(ctx, 'Could not mute that member', apiProblem(error));
      return;
    }

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
      `${member} is muted with ${setup.role} ${
        durationMs ? `for **${formatDuration(durationMs)}**` : 'until someone unmutes them'
      }.`,
      `**Reason:** ${reason}`,
    ];

    if (setup.created) {
      lines.push('', `Created the **${setup.role.name}** role and muted it in ${setup.updated} channel(s).`);
    }

    if (setup.failed?.length) {
      lines.push(
        '',
        `⚠️ ${setup.failed.length} channel(s) could not be muted. Check my **Manage Roles** permission and my role position.`,
      );
    }

    await done(ctx, 'Member muted', lines.join('\n'));
  },
};
