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
    .setDescription('Ban a user, optionally for a limited time')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('User to ban').setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('id')
        .setDescription('User id, when they are not in the server')
        .setRequired(false)
        .setMaxLength(20),
    )
    .addStringOption((option) =>
      option
        .setName('duration')
        .setDescription('Temporary ban, e.g. 40s, 10m, 2h, 7d — leave empty for permanent')
        .setRequired(false)
        .setMaxLength(20),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('Why they are being banned').setRequired(false),
    ),

  name: 'ban',
  description: 'Ban a user permanently or for a limited time',
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
        'Unknown user',
        `Mention the user or paste their id, for example \`${ctx.isSlash ? '/ban user:@name 7d raiding' : ':-ban 123456789012345678 7d raiding'}\`.`,
      );
      return;
    }

    if (userId === ctx.user.id) {
      await fail(ctx, 'Cannot ban yourself', 'Pick another user.');
      return;
    }

    if (userId === ctx.guild.ownerId) {
      await fail(
        ctx,
        'Cannot ban the owner',
        'The server owner cannot be banned — the owner bypasses every permission.',
      );
      return;
    }

    if (userId === client.user?.id) {
      await fail(ctx, 'Cannot ban me', 'Pick another user.');
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
        await fail(ctx, 'Cannot ban that member', issue);
        return;
      }
    }

    const permissionIssue = botPermissionProblem(
      ctx.guild,
      PermissionFlagsBits.BanMembers,
      'Ban Members',
    );

    if (permissionIssue) {
      await fail(ctx, 'Cannot ban members', permissionIssue);
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

    try {
      await ctx.guild.members.ban(userId, {
        reason: `Banned by ${ctx.user.tag ?? ctx.user.username}: ${reason}`,
        deleteMessageSeconds: 0,
      });
    } catch (error) {
      await fail(ctx, 'Could not ban that user', apiProblem(error));
      return;
    }

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
      `${user?.tag ?? `<@${userId}>`} is banned ${
        durationMs ? `for **${formatDuration(durationMs)}**` : 'permanently'
      }.`,
      `**Reason:** ${reason}`,
    ];

    if (durationMs) {
      lines.push('', '_Temporary bans are lifted by the scheduler within a minute of expiring._');
    }

    await done(ctx, 'User banned', lines.join('\n'));
  },
};
