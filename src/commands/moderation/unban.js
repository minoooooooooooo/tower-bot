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
    .setDescription('ارفع الحظر عشان يقدر المستخدم يدخل من جديد')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('المستخدم المطلوب رفع الحظر عنه').setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('id')
        .setDescription('آيدي المستخدم المحظور، إذا مو موجود في السيرفر')
        .setRequired(false)
        .setMaxLength(20),
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('سبب رفع الحظر').setRequired(false),
    ),

  name: 'unban',
  description: 'ارفع الحظر عشان يقدر المستخدم يدخل من جديد',
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
        'المستخدم غير موجود',
        `اذكر المستخدم أو الصق الآيدي أو اكتب اسمه، مثال: \`${ctx.isSlash ? '/unban id:123456789012345678' : ':-unban 123456789012345678 appealed'}\`.`,
      );
      return;
    }

    const permissionIssue = botPermissionProblem(
      ctx.guild,
      PermissionFlagsBits.BanMembers,
      'Ban Members',
    );

    if (permissionIssue) {
      await fail(ctx, 'ما أقدر أرفع الحظر', permissionIssue);
      return;
    }

    const ban = await ctx.guild.bans.fetch(userId).catch(() => null);

    if (!ban) {
      deleteExpiry(ctx.guildId, userId, 'ban');
      await info(ctx, 'غير محظور', `${label} غير محظور في السيرفر.`);
      return;
    }

    const reason = defaultReason(
      ctx.isSlash ? slashReason(ctx) : ctx.args.slice(1).join(' ').trim(),
    );

    try {
      await ctx.guild.bans.remove(
        userId,
        `رفع حظر بواسطة ${ctx.user.tag ?? ctx.user.username}: ${reason}`,
      );
    } catch (error) {
      await fail(ctx, 'تعذر رفع الحظر', apiProblem(error));
      return;
    }

    deleteExpiry(ctx.guildId, userId, 'ban');

    await done(ctx, 'تم رفع الحظر', `${label} يقدر يدخل من جديد.\n**السبب:** ${reason}`);
  },
};
