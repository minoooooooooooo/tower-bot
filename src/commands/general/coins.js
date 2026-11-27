import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { config } from '../../config.js';
import { formatNumber } from '../../lib/activity-format.js';
import { askConfirmation } from '../../lib/confirm.js';
import { errorReply, okReply, warnReply } from '../../lib/replies.js';
import { resolveUser } from '../../lib/resolve.js';
import { displayNameOf } from '../../lib/targets.js';
import { linkedPoints } from '../../services/ebot-vex.js';
import {
  ensureCoinBackfill,
  getProfile,
  settleProfile,
  transferCoins,
  transferEnabled,
} from '../../services/profile-store.js';

/**
 * Parses a prefix amount. `null` means "not given", `undefined` means the token
 * exists but is not a positive whole number.
 */
function parseAmount(token) {
  if (token === undefined) return null;

  const text = String(token).trim();

  if (!/^\d+$/.test(text)) return undefined;

  const value = Number(text);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function usage(ctx) {
  if (ctx.isSlash) {
    return 'استخدم `/coins` عشان تشوف رصيدك، أو `/coins user:@member amount:50` عشان ترسل عملات (بيطلب منك تأكيد).';
  }

  return (
    `استخدم \`${config.prefix}coins\` عشان تشوف رصيدك، ` +
    `\`${config.prefix}coins @member\` عشان تشوف رصيده، أو ` +
    `\`${config.prefix}coins @member 50\` عشان ترسل 50 عملة (بيطلب منك تأكيد).`
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('coins')
    .setDescription('اعرض رصيد العملات أو أرسل عملات لعضو')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('العضو المطلوب أو المستلم (الافتراضي: أنت)')
        .setRequired(false),
    )
    .addIntegerOption((option) =>
      option
        .setName('amount')
        .setDescription('عدد العملات اللي ترسلها (اتركها فاضية لعرض الرصيد)')
        .setMinValue(1)
        .setRequired(false),
    ),

  name: 'coins',
  aliases: ['coin', 'balance', 'wallet'],
  description: 'اعرض رصيد العملات أو أرسل عملات لعضو',
  category: 'Profile',
  usage: 'coins [@member] [amount]',
  cooldown: 3,
  guildOnly: true,

  async execute(ctx, client) {
    const tokens = ctx.isSlash ? [] : ctx.args;

    if (!ctx.isSlash && tokens.length > 2) {
      await ctx.fail(errorReply('وسائط كثيرة', usage(ctx)));
      return;
    }

    const amount = ctx.isSlash ? ctx.getInteger('amount') ?? null : parseAmount(tokens[1]);

    if (amount === undefined) {
      await ctx.fail(
        errorReply(
          'مبلغ غير صحيح',
          `المبلغ لازم يكون رقم صحيح 1 أو أكثر.\n\n${usage(ctx)}`,
        ),
      );
      return;
    }

    // A slash amount without a target has nobody to pay.
    if (ctx.isSlash && amount !== null && !ctx.getUser('user')) {
      await ctx.fail(errorReply('اختر عضو', 'حدّد مين يستلم العملات.'));
      return;
    }

    // The linked balances and member lookups can take longer than Discord's
    // three-second acknowledgement window.
    if (ctx.isSlash) await ctx.defer();

    let targetUser = ctx.isSlash ? ctx.getUser('user') ?? null : null;

    if (!ctx.isSlash && tokens[0]) {
      targetUser = await resolveUser(client, tokens[0], ctx.message);

      if (!targetUser) {
        await ctx.fail(
          errorReply(
            'عضو غير معروف',
            `منشن العضو أو الصق الآيدي، مثل \`${config.prefix}coins @member\`.`,
          ),
        );
        return;
      }
    }

    let linked = null;

    try {
      linked = await linkedPoints(client, ctx.guildId);
    } catch {
      // A linked-bot outage must not block a balance check or a transfer.
    }

    try {
      ensureCoinBackfill(ctx.guildId, linked);
    } catch {
      // A failed one-time import must not block the command.
    }

    const senderId = ctx.user.id;
    settleProfile(ctx.guildId, senderId, linked);

    // ---- balance view -----------------------------------------------------
    if (!targetUser || amount === null) {
      if (targetUser?.bot) {
        await ctx.fail(errorReply('البوتات ما عندها عملات', 'اختر عضو، مو بوت.'));
        return;
      }

      const userId = targetUser?.id ?? senderId;

      if (targetUser) settleProfile(ctx.guildId, userId, linked);

      const { coins } = getProfile(ctx.guildId, userId);
      const member = ctx.guild.members.cache.get(userId) ?? null;
      const name = targetUser ? displayNameOf(targetUser, member) : null;

      await ctx.editReply({
        content: targetUser
          ? `ℹ️ **رصيد ${name}**\n**${formatNumber(coins)}** عملة`
          : `ℹ️ **رصيدك**\n**${formatNumber(coins)}** عملة\nأرسل عملات بـ \`${config.prefix}coins @member <amount>\`.`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    // ---- transfer ---------------------------------------------------------
    if (targetUser.id === senderId) {
      await ctx.fail(errorReply('ما تقدر تدفع لنفسك', 'اختر عضو ثاني.'));
      return;
    }

    if (targetUser.bot) {
      await ctx.fail(errorReply('البوتات ما عندها عملات', 'اختر عضو، مو بوت.'));
      return;
    }

    if (!transferEnabled(ctx.guildId)) {
      await ctx.fail(
        warnReply(
          'التحويل مقفّل',
          'تحويل العملات مقفّل في هذا السيرفر. مشرف يقدر يفتحه بـ ' +
            `\`${config.prefix}coins-config on\`.`,
        ),
      );
      return;
    }

    const targetMember =
      ctx.guild.members.cache.get(targetUser.id) ??
      (await ctx.guild.members.fetch(targetUser.id).catch(() => null));

    if (!targetMember) {
      await ctx.fail(
        errorReply('العضو مو في السيرفر', 'العملات تنرسل للأعضاء الموجودين بس.'),
      );
      return;
    }

    settleProfile(ctx.guildId, targetUser.id, linked);

    const balance = getProfile(ctx.guildId, senderId).coins;

    if (balance < amount) {
      await ctx.fail(
        warnReply(
          'ما عندك عملات كافية',
          `عندك **${formatNumber(balance)}** عملة، فما تقدر ترسل **${formatNumber(amount)}**.`,
        ),
      );
      return;
    }

    // Nothing moves until the sender answers the prompt in the channel. The
    // checks run again when they do, in case the balance or the server setting
    // changed during the two-minute window.
    const transferNow = async () => {
      if (!transferEnabled(ctx.guildId)) {
        await ctx.reply(
          warnReply(
            'التحويل مقفّل',
            'تحويل العملات انقفل في هذا السيرفر قبل ما يأكد التحويل.',
          ),
        );
        return;
      }

      let result;

      try {
        result = transferCoins(ctx.guildId, senderId, targetUser.id, amount);
      } catch {
        await ctx.reply(
          errorReply('ما قدرت أرسل العملات', 'كتابة قاعدة البيانات فشلت. جرّب مرة ثانية.'),
        );
        return;
      }

      if (!result.ok) {
        if (result.reason === 'funds') {
          await ctx.reply(
            warnReply(
              'ما عندك عملات كافية',
              `عندك **${formatNumber(result.balance)}** عملة، فما تقدر ترسل ` +
                `**${formatNumber(amount)}**.`,
            ),
          );
          return;
        }

        await ctx.reply(errorReply('ما قدرت أرسل العملات', usage(ctx)));
        return;
      }

      await ctx.reply({
        ...okReply(
          'انرسلت العملات',
          `**${formatNumber(amount)}** عملة إلى ${targetMember}.\n` +
            `رصيدك: **${formatNumber(result.fromBalance)}** عملة.\n` +
            `رصيده: **${formatNumber(result.toBalance)}** عملة.`,
        ),
        allowedMentions: { parse: [] },
      });
    };

    await askConfirmation({
      ctx,
      prompt:
        `بتحوّل **${formatNumber(amount)}** عملة إلى ${targetMember}.\n` +
        `رصيدك الحالي: **${formatNumber(balance)}** عملة. التحويل ما ينرجع تلقائيًا.`,
      run: transferNow,
    });
  },
};
