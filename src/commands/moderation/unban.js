import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { resolveUser } from '../../lib/resolve.js';
import { botPermissionProblem } from '../../services/moderation.js';
import { deleteExpiry } from '../../services/moderation-store.js';
import { apiProblem, defaultReason, done, fail, info, slashReason } from './_shared.js';

export default {
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Remove a ban so the user can join again')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('User to unban').setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('id')
        .setDescription('Banned user id, when they are not in the server')
        .setRequired(false)
        .setMaxLength(20),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('Why they are being unbanned').setRequired(false),
    ),

  name: 'unban',
  description: 'Remove a ban so the user can join again',
  category: 'Moderation',
  usage: 'unban <@user|id> [reason]',
  cooldown: 3,
  guildOnly: true,
  permissions: ['BanMembers'],

  async execute(ctx, client) {
    const picked = ctx.isSlash ? ctx.getUser('user') : null;
    const raw = picked?.id ?? (ctx.isSlash ? ctx.getString('id') : ctx.args[0]);
    const user = picked ?? (raw ? await resolveUser(client, raw, ctx.message) : null);
    const userId = user?.id ?? (/^\d{17,20}$/.test(String(raw ?? '')) ? String(raw) : null);
    const label = user?.tag ?? (userId ? `<@${userId}>` : 'That user');

    if (!userId) {
      await fail(
        ctx,
        'Unknown user',
        `Mention the user, paste their id, or use their username, for example \`${ctx.isSlash ? '/unban id:123456789012345678' : ':-unban 123456789012345678 appealed'}\`.`,
      );
      return;
    }

    const permissionIssue = botPermissionProblem(
      ctx.guild,
      PermissionFlagsBits.BanMembers,
      'Ban Members',
    );

    if (permissionIssue) {
      await fail(ctx, 'Cannot unban', permissionIssue);
      return;
    }

    const ban = await ctx.guild.bans.fetch(userId).catch(() => null);

    if (!ban) {
      deleteExpiry(ctx.guildId, userId, 'ban');
      await info(ctx, 'Not banned', `${label} is not banned from this server.`);
      return;
    }

    const reason = defaultReason(
      ctx.isSlash ? slashReason(ctx) : ctx.args.slice(1).join(' ').trim(),
    );

    try {
      await ctx.guild.bans.remove(
        userId,
        `Unbanned by ${ctx.user.tag ?? ctx.user.username}: ${reason}`,
      );
    } catch (error) {
      await fail(ctx, 'Could not unban that user', apiProblem(error));
      return;
    }

    deleteExpiry(ctx.guildId, userId, 'ban');

    await done(ctx, 'User unbanned', `${label} can join again.\n**Reason:** ${reason}`);
  },
};
