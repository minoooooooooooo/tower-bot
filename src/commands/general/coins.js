import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { config } from '../../config.js';
import { formatNumber } from '../../lib/activity-format.js';
import { COLORS, embed, errorEmbed, warningEmbed } from '../../lib/embeds.js';
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
    return 'Use `/coins` to see your balance, or `/coins user:@member amount:50` to send coins.';
  }

  return (
    `Use \`${config.prefix}coins\` to see your balance, ` +
    `\`${config.prefix}coins @member\` to see theirs, or ` +
    `\`${config.prefix}coins @member 50\` to send 50 coins.`
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('coins')
    .setDescription('Check a coin balance or send coins to a member')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('Member to check or pay (default: you)')
        .setRequired(false),
    )
    .addIntegerOption((option) =>
      option
        .setName('amount')
        .setDescription('Coins to send (leave empty to check a balance)')
        .setMinValue(1)
        .setRequired(false),
    ),

  name: 'coins',
  aliases: ['coin', 'balance', 'wallet'],
  description: 'Check a coin balance or send coins to a member',
  category: 'Profile',
  usage: 'coins [@member] [amount]',
  cooldown: 3,
  guildOnly: true,

  async execute(ctx, client) {
    const tokens = ctx.isSlash ? [] : ctx.args;

    if (!ctx.isSlash && tokens.length > 2) {
      await ctx.fail({
        embeds: [errorEmbed('Too many arguments', usage(ctx))],
      });
      return;
    }

    const amount = ctx.isSlash ? ctx.getInteger('amount') ?? null : parseAmount(tokens[1]);

    if (amount === undefined) {
      await ctx.fail({
        embeds: [
          errorEmbed(
            'Invalid amount',
            `The amount must be a whole number of at least 1.\n\n${usage(ctx)}`,
          ),
        ],
      });
      return;
    }

    // A slash amount without a target has nobody to pay.
    if (ctx.isSlash && amount !== null && !ctx.getUser('user')) {
      await ctx.fail({
        embeds: [errorEmbed('Pick a member', 'Choose who should receive the coins.')],
      });
      return;
    }

    // The linked balances and member lookups can take longer than Discord's
    // three-second acknowledgement window.
    if (ctx.isSlash) await ctx.defer();

    let targetUser = ctx.isSlash ? ctx.getUser('user') ?? null : null;

    if (!ctx.isSlash && tokens[0]) {
      targetUser = await resolveUser(client, tokens[0], ctx.message);

      if (!targetUser) {
        await ctx.fail({
          embeds: [
            errorEmbed(
              'Unknown member',
              `Mention the member or paste their id, for example \`${config.prefix}coins @member\`.`,
            ),
          ],
        });
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
        await ctx.fail({
          embeds: [errorEmbed('Bots have no coins', 'Pick a member, not a bot.')],
        });
        return;
      }

      const userId = targetUser?.id ?? senderId;

      if (targetUser) settleProfile(ctx.guildId, userId, linked);

      const { coins } = getProfile(ctx.guildId, userId);
      const member = ctx.guild.members.cache.get(userId) ?? null;
      const name = targetUser ? displayNameOf(targetUser, member) : null;

      await ctx.editReply({
        embeds: [
          embed({
            title: targetUser ? `${name} · coins` : 'Your coins',
            description: `**${formatNumber(coins)}** coins`,
            footer: targetUser
              ? undefined
              : `Send coins with ${config.prefix}coins @member <amount>`,
          }),
        ],
        allowedMentions: { parse: [] },
      });
      return;
    }

    // ---- transfer ---------------------------------------------------------
    if (targetUser.id === senderId) {
      await ctx.fail({
        embeds: [errorEmbed('Cannot pay yourself', 'Choose another member.')],
      });
      return;
    }

    if (targetUser.bot) {
      await ctx.fail({
        embeds: [errorEmbed('Bots have no coins', 'Choose a member, not a bot.')],
      });
      return;
    }

    if (!transferEnabled(ctx.guildId)) {
      await ctx.fail({
        embeds: [
          warningEmbed(
            'Transfers are off',
            `Coin transfers are disabled in this server. An admin can turn them on with ` +
              `\`${config.prefix}coins-config on\`.`,
          ),
        ],
      });
      return;
    }

    const targetMember =
      ctx.guild.members.cache.get(targetUser.id) ??
      (await ctx.guild.members.fetch(targetUser.id).catch(() => null));

    if (!targetMember) {
      await ctx.fail({
        embeds: [
          errorEmbed('Member not in this server', 'Coins can only be sent to current members.'),
        ],
      });
      return;
    }

    settleProfile(ctx.guildId, targetUser.id, linked);

    let result;

    try {
      result = transferCoins(ctx.guildId, senderId, targetUser.id, amount);
    } catch {
      await ctx.fail({
        embeds: [errorEmbed('Could not send the coins', 'The database write failed. Try again.')],
      });
      return;
    }

    if (!result.ok) {
      if (result.reason === 'funds') {
        await ctx.fail({
          embeds: [
            warningEmbed(
              'Not enough coins',
              `You have **${formatNumber(result.balance)}** coins, so you cannot send ` +
                `**${formatNumber(amount)}**.`,
            ),
          ],
        });
        return;
      }

      await ctx.fail({
        embeds: [errorEmbed('Could not send the coins', usage(ctx))],
      });
      return;
    }

    await ctx.editReply({
      embeds: [
        embed({
          title: 'Coins sent',
          description:
            `**${formatNumber(amount)}** coins to ${targetMember}.\n` +
            `Your balance: **${formatNumber(result.fromBalance)}** coins.`,
          color: COLORS.success,
          footer: `Their balance: ${formatNumber(result.toBalance)} coins`,
        }),
      ],
      allowedMentions: { parse: [] },
    });
  },
};
