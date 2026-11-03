import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { errorEmbed, infoEmbed, successEmbed } from '../../lib/embeds.js';
import { resolveMember } from '../../lib/resolve.js';
import { removeExileRoles, sendExileLog } from '../../services/exile.js';
import {
  MAX_REASON_LENGTH,
  getActiveExile,
  levelLabel,
  releaseActiveExile,
} from '../../services/exile-store.js';

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

async function requireManageServer(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await ctx.reply(
    ephemeral({
      embeds: [errorEmbed('Missing permissions', 'You need **Manage Server** to release members.')],
    }),
  );

  return false;
}

function formatHeld(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));

  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;

  return `${Math.floor(minutes / (60 * 24))}d`;
}

export default {
  data: new SlashCommandBuilder()
    .setName('exile-release')
    .setDescription('Remove a member’s exile role and let them see the server again')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('Member to release').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('reason')
        .setDescription('Why they are being released (shown in the log)')
        .setRequired(false)
        .setMaxLength(MAX_REASON_LENGTH),
    ),

  name: 'exile-release',
  aliases: ['unjail', 'unexile'],
  description: 'Remove a member’s exile role and let them see the server again',
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
      await ctx.reply(
        ephemeral({
          embeds: [
            errorEmbed(
              'Unknown member',
              `Mention the member or paste their id, for example \`${ctx.isSlash ? '/exile-release user:@member' : ':-exile-release @member appeal accepted'}\`.`,
            ),
          ],
        }),
      );
      return;
    }

    const reason = ((ctx.isSlash ? ctx.getString('reason') : ctx.args.slice(1).join(' '))?.trim() ?? '').slice(
      0,
      MAX_REASON_LENGTH,
    );
    const active = getActiveExile(ctx.guildId, member.id);

    if (!active) {
      const cleanup = await removeExileRoles(member, null, `Exile cleanup by ${ctx.user.tag ?? ctx.user.username}`);

      await ctx.reply(
        ephemeral({
          embeds: [
            cleanup.removed.length > 0
              ? successEmbed(
                  'Stale exile role removed',
                  `${member} had an exile role but no active record. I removed ${cleanup.removed.length} role${cleanup.removed.length === 1 ? '' : 's'}; they can see the server again.`,
                )
              : infoEmbed('Not exiled', `${member} does not have an active exile.`),
          ],
        }),
      );
      return;
    }

    let result;

    try {
      result = await removeExileRoles(
        member,
        active.roleId,
        `Exile released by ${ctx.user.tag ?? ctx.user.username}`,
      );
    } catch (error) {
      await ctx.reply(
        ephemeral({
          embeds: [
            errorEmbed(
              'Could not remove the role',
              `Discord refused the change: ${error.message}. Check that my role is above the exile role.`,
            ),
          ],
        }),
      );
      return;
    }

    // The active role must be gone before the record is marked released,
    // otherwise the list would claim a member is free while still restricted.
    if (member.roles.cache.has(active.roleId)) {
      await ctx.reply(
        ephemeral({
          embeds: [
            errorEmbed(
              'Exile role is still applied',
              `I could not remove <@&${active.roleId}>. Move my role above it and try again; the exile stays active until then.`,
            ),
          ],
        }),
      );
      return;
    }

    releaseActiveExile({
      guildId: ctx.guildId,
      userId: member.id,
      releasedBy: ctx.user.id,
      reason: reason || 'Released',
    });

    await sendExileLog(ctx.guild, {
      type: 'release',
      userId: member.id,
      actorId: ctx.user.id,
      level: active.level,
      roleId: active.roleId,
      reason: reason || 'Released',
      at: active.createdAt,
      releasedAt: Date.now(),
      footer: `Held for ${formatHeld(Date.now() - active.createdAt)}`,
    });

    const lines = [
      `${member} is free again — <@&${active.roleId}> was removed.`,
      `They were at **${levelLabel(active.level)}** for **${formatHeld(Date.now() - active.createdAt)}**.`,
      `Reason: ${reason || 'Released'}`,
    ];

    if (result.failed.length > 0) {
      lines.push(
        '',
        `⚠️ ${result.failed.length} other exile role${result.failed.length === 1 ? '' : 's'} could not be removed. Check my role position.`,
      );
    }

    await ctx.reply(ephemeral({ embeds: [successEmbed('Member released', lines.join('\n'))] }));
  },
};
