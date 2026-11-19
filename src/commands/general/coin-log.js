import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from '../../config.js';
import { formatNumber } from '../../lib/activity-format.js';
import { COLORS, embed, errorEmbed } from '../../lib/embeds.js';
import { resolveUser } from '../../lib/resolve.js';
import { displayNameOf } from '../../lib/targets.js';
import { linkedPoints } from '../../services/ebot-vex.js';
import {
  COIN_FILTERS,
  COIN_FILTER_LABELS,
  COIN_PAGE_SIZE,
  COIN_TYPE_LABELS,
  coinHistory,
  coinTotals,
  ensureOpeningBalance,
} from '../../services/coin-ledger.js';
import {
  ensureCoinBackfill,
  getProfile,
  settleProfile,
} from '../../services/profile-store.js';

const FILTER_ALIASES = {
  all: 'all',
  earn: 'earn',
  earned: 'earn',
  earning: 'earn',
  level: 'earn',
  levels: 'earn',
  transfer: 'transfer',
  transfers: 'transfer',
  sent: 'transfer',
  received: 'transfer',
  purchase: 'purchase',
  purchases: 'purchase',
  bought: 'purchase',
  buy: 'purchase',
  refund: 'refund',
  refunds: 'refund',
  admin: 'admin',
  adjustment: 'admin',
  adjustments: 'admin',
  backfill: 'backfill',
  opening: 'backfill',
  start: 'backfill',
};

const FILTER_CHOICES = COIN_FILTERS.map((value) => ({
  name: COIN_FILTER_LABELS[value] ?? value,
  value,
}));

function normalizeFilter(value) {
  return FILTER_ALIASES[String(value ?? '').trim().toLowerCase()] ?? null;
}

function parsePage(value) {
  const number = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(number) && number > 0 ? number : 1;
}

function looksLikeUser(token) {
  return /^<@!?\d+>$/.test(String(token ?? '')) || /^\d{17,20}$/.test(String(token ?? ''));
}

function short(value, max = 38) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describe(row, userId) {
  const detail = row.detail ?? {};

  switch (row.type) {
    case 'purchase':
      return short(detail.itemName ?? detail.itemKey ?? 'store item');
    case 'refund':
      return short(detail.itemKey ? `refund ${detail.itemKey}` : 'purchase refund');
    case 'transfer_in':
      return detail.fromUserId ? `from <@${detail.fromUserId}>` : '';
    case 'transfer_out':
      return detail.toUserId ? `to <@${detail.toUserId}>` : '';
    case 'earn':
      return detail.level ? `level ${detail.level}` : '';
    case 'backfill':
      if (detail.source === 'ledger started') return 'history before the ledger';
      return detail.level ? `level ${detail.level} import` : short(detail.source ?? '');
    case 'admin_add':
    case 'admin_remove': {
      const source = detail.source === 'profile-edit' ? 'profile edit' : short(detail.source ?? '');
      const actor = row.actor_id && row.actor_id !== userId ? ` by <@${row.actor_id}>` : '';
      return `${source}${actor}`.trim();
    }
    default:
      return short(detail.source ?? '');
  }
}

function historyLine(row, userId) {
  const amount = `${row.amount > 0 ? '+' : ''}${formatNumber(row.amount)}`;
  const label = COIN_TYPE_LABELS[row.type] ?? row.type;
  const detail = describe(row, userId);
  const when = `<t:${Math.floor(Number(row.created_at) / 1000)}:R>`;

  return (
    `${amount} · ${label}` +
    (detail ? ` — ${detail}` : '') +
    ` · bal ${formatNumber(row.balance_after)} · ${when}`
  );
}

function logEmbed({ targetId, name, isSelf, filter, page, pages, totals, rows, balance }) {
  const lines = rows.length
    ? rows.map((row) => historyLine(row, targetId)).join('\n')
    : '_No coin movement yet._';

  return embed({
    title: isSelf ? 'Your coin log' : `${name} · coin log`,
    description:
      `Filter: **${COIN_FILTER_LABELS[filter] ?? filter}**` +
      (totals.count ? ` · ${formatNumber(totals.count)} records` : ''),
    color: COLORS.primary,
    fields: [
      { name: 'Balance', value: `**${formatNumber(balance)}** coins`, inline: true },
      { name: 'In', value: `+${formatNumber(totals.earned)}`, inline: true },
      { name: 'Out', value: `-${formatNumber(totals.spent)}`, inline: true },
      { name: 'History', value: lines, inline: false },
    ],
    footer: `Page ${formatNumber(page)} / ${formatNumber(pages)} · ${COIN_PAGE_SIZE} per page`,
  });
}

async function runCoinLog(ctx, client) {
  let target = ctx.user;
  let filter = 'all';
  let page = 1;

  if (ctx.isSlash) {
    target = ctx.getUser('user') ?? ctx.user;
    filter = normalizeFilter(ctx.getString('type')) ?? 'all';
    page = ctx.getInteger('page') ?? 1;
  } else {
    const args = [...ctx.args];

    if (args[0] && looksLikeUser(args[0])) {
      const resolved = await resolveUser(client, args[0], ctx.message);

      if (!resolved) {
        await ctx.fail({
          embeds: [
            errorEmbed(
              'Unknown member',
              `Mention the member or paste their id, for example \`${config.prefix}coin-log @member\`.`,
            ),
          ],
        });
        return;
      }

      target = resolved;
      args.shift();
    }

    const filterIndex = args.findIndex((token) => normalizeFilter(token));

    if (filterIndex >= 0) {
      filter = normalizeFilter(args[filterIndex]);
      args.splice(filterIndex, 1);
    }

    page = parsePage(args[0]);
  }

  if (target.id !== ctx.user.id) {
    const allowed = Boolean(ctx.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));

    if (!allowed) {
      await ctx.fail({
        embeds: [
          errorEmbed(
            'Missing permissions',
            'You need **Manage Server** to read another member’s coin log.',
          ),
        ],
      });
      return;
    }
  }

  if (target.bot) {
    await ctx.fail({
      embeds: [errorEmbed('Bots have no coins', 'Pick a member, not a bot.')],
    });
    return;
  }

  if (ctx.isSlash) await ctx.defer({ ephemeral: true });

  let linked = null;

  try {
    linked = await linkedPoints(client, ctx.guildId);
  } catch {
    // A linked-bot outage must not block the ledger.
  }

  // Existing balances predate the ledger. Give them a starting point before
  // the one-time coin import and any pending level reward, so the history reads
  // in order.
  const before = getProfile(ctx.guildId, target.id);
  ensureOpeningBalance(ctx.guildId, target.id, before.coins);

  try {
    ensureCoinBackfill(ctx.guildId, linked);
  } catch {
    // A failed one-time import must not block the log.
  }

  settleProfile(ctx.guildId, target.id, linked);

  const profile = getProfile(ctx.guildId, target.id);
  const totals = coinTotals(ctx.guildId, target.id, { filter });
  const pages = Math.max(1, Math.ceil(totals.count / COIN_PAGE_SIZE));
  const safePage = Math.min(page, pages);
  const rows = coinHistory(ctx.guildId, target.id, {
    filter,
    limit: COIN_PAGE_SIZE,
    offset: (safePage - 1) * COIN_PAGE_SIZE,
  });
  const member = ctx.guild.members.cache.get(target.id) ?? null;
  const name = displayNameOf(target, member);

  await ctx.editReply({
    embeds: [
      logEmbed({
        targetId: target.id,
        name,
        isSelf: target.id === ctx.user.id,
        filter,
        page: safePage,
        pages,
        totals,
        rows,
        balance: profile.coins,
      }),
    ],
    allowedMentions: { parse: [] },
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('coin-log')
    .setDescription('Show recent coin movement and the current balance')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('Member to inspect (default: you; Manage Server for others)')
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('type')
        .setDescription('Only show one kind of movement')
        .addChoices(...FILTER_CHOICES)
        .setRequired(false),
    )
    .addIntegerOption((option) =>
      option
        .setName('page')
        .setDescription('Page number (8 records per page)')
        .setMinValue(1)
        .setRequired(false),
    ),

  name: 'coin-log',
  aliases: ['coins-log', 'coin-history', 'coinlog', 'ledger', 'bank-log'],
  description: 'Show recent coin movement and the current balance',
  category: 'Profile',
  usage: 'coin-log [@member] [earn|transfer|purchase|refund|admin|backfill] [page]',
  cooldown: 3,
  guildOnly: true,

  async execute(ctx, client) {
    return runCoinLog(ctx, client);
  },
};
