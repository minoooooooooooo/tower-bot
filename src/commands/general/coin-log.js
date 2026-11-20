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
  guildCoinHistory,
  guildCoinTotals,
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

const GLOBAL_WORDS = new Set(['all', 'global', 'everyone', 'server', 'universal', 'guild', 'whole']);

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

const LRM = '\u200E';

function short(value, max = 32) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** `formatNumber` clamps at zero; history needs the sign. */
function formatSigned(value) {
  const number = Math.trunc(Number(value) || 0);
  const sign = number > 0 ? '+' : number < 0 ? '-' : '';

  return `${sign}${Math.abs(number).toLocaleString('en-US')}`;
}

/** Compact, locale-free age; avoids long "an hour ago" lines wrapping. */
function ago(createdAt) {
  const stamp = Number(createdAt) || 0;
  const minutes = Math.floor(Math.max(0, Date.now() - stamp) / 60_000);

  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  return `<t:${Math.floor(stamp / 1000)}:d>`;
}

function describe(row, userId) {
  const detail = row.detail ?? {};

  switch (row.type) {
    case 'purchase':
      return short((detail.itemName ?? detail.itemKey ?? 'store item').replace(/\s+background$/i, ''));
    case 'refund': {
      const key = detail.itemKey ? String(detail.itemKey).replace(/^design:/, '') : '';
      return key ? short(key, 24) : '';
    }
    case 'transfer_in':
      return detail.fromUserId ? `from <@${detail.fromUserId}>` : '';
    case 'transfer_out':
      return detail.toUserId ? `to <@${detail.toUserId}>` : '';
    case 'earn':
      return detail.level ? `level ${detail.level}` : '';
    case 'backfill':
      if (detail.source === 'ledger started') return '';
      return detail.level ? `level ${detail.level}` : short(detail.source ?? '');
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

/**
 * One compact line per movement. The invisible LRM after the opening bold
 * marker makes the paragraph resolve LTR, so an Arabic member name inside a
 * mention cannot flip the amount and balance to the right.
 */
function historyLine(row, { member = false, viewerId } = {}) {
  const parts = [
    `**${LRM}${formatSigned(row.amount)}**`,
    COIN_TYPE_LABELS[row.type] ?? row.type,
    member ? `<@${row.user_id}>` : null,
    describe(row, viewerId),
    `bal **${formatNumber(row.balance_after)}**`,
    ago(row.created_at),
  ].filter(Boolean);

  return `${parts.join(' · ')}${LRM}`;
}

function logEmbed({ targetId, name, isSelf, filter, page, pages, totals, rows, balance }) {
  const lines = rows.length
    ? rows.map((row) => historyLine(row, { viewerId: targetId })).join('\n')
    : '_No coin movement yet._';

  return embed({
    title: isSelf ? 'Your coin log' : `${name} · coin log`,
    description:
      `Filter: **${COIN_FILTER_LABELS[filter] ?? filter}**` +
      (totals.count ? ` · ${formatNumber(totals.count)} records` : '') +
      ' · newest first',
    color: COLORS.primary,
    fields: [
      { name: 'Balance', value: `**${formatNumber(balance)}** coins`, inline: true },
      { name: 'In', value: totals.earned ? `**+${formatNumber(totals.earned)}**` : '**0**', inline: true },
      { name: 'Out', value: totals.spent ? `**-${formatNumber(totals.spent)}**` : '**0**', inline: true },
      { name: 'History', value: lines, inline: false },
    ],
    footer: `Page ${formatNumber(page)} / ${formatNumber(pages)} · ${COIN_PAGE_SIZE} per page`,
  });
}

function guildLogEmbed({ guildName, filter, page, pages, totals, rows }) {
  const lines = rows.length
    ? rows
        .map((row) => historyLine(row, { member: true, viewerId: row.user_id }))
        .join('\n')
    : '_No coin movement yet._';

  return embed({
    title: `${guildName} · server coin log`,
    description:
      `All members · **${COIN_FILTER_LABELS[filter] ?? filter}**` +
      (totals.count ? ` · ${formatNumber(totals.count)} records` : '') +
      ' · newest first',
    color: COLORS.primary,
    fields: [
      { name: 'In', value: totals.earned ? `**+${formatNumber(totals.earned)}**` : '**0**', inline: true },
      { name: 'Out', value: totals.spent ? `**-${formatNumber(totals.spent)}**` : '**0**', inline: true },
      { name: 'Members', value: `**${formatNumber(totals.members)}**`, inline: true },
      { name: 'History', value: lines, inline: false },
    ],
    footer: `Page ${formatNumber(page)} / ${formatNumber(pages)} · ${COIN_PAGE_SIZE} per page`,
  });
}

async function runCoinLog(ctx, client) {
  let target = ctx.user;
  let filter = 'all';
  let page = 1;
  let global = false;

  if (ctx.isSlash) {
    target = ctx.getUser('user') ?? ctx.user;
    filter = normalizeFilter(ctx.getString('type')) ?? 'all';
    page = ctx.getInteger('page') ?? 1;
    global = ctx.getBoolean('global') === true;

    if (global && ctx.getUser('user')) {
      await ctx.fail({
        embeds: [
          errorEmbed(
            'Choose one view',
            'Pick a member or `global:true`, not both. `/coin-log global:true` shows every member.',
          ),
        ],
      });
      return;
    }
  } else {
    const args = [...ctx.args];

    if (args[0] && GLOBAL_WORDS.has(String(args[0]).toLowerCase())) {
      global = true;
      args.shift();
    } else if (args[0] && looksLikeUser(args[0])) {
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

  if (global) {
    if (!ctx.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild)) {
      await ctx.fail({
        embeds: [
          errorEmbed(
            'Missing permissions',
            'You need **Manage Server** to read the server-wide coin log.',
          ),
        ],
      });
      return;
    }
  } else if (target.id !== ctx.user.id) {
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

  if (!global && target.bot) {
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

  if (global) {
    try {
      ensureCoinBackfill(ctx.guildId, linked);
    } catch {
      // A failed one-time import must not block the log.
    }

    const totals = guildCoinTotals(ctx.guildId, { filter });
    const pages = Math.max(1, Math.ceil(totals.count / COIN_PAGE_SIZE));
    const safePage = Math.min(page, pages);
    const rows = guildCoinHistory(ctx.guildId, {
      filter,
      limit: COIN_PAGE_SIZE,
      offset: (safePage - 1) * COIN_PAGE_SIZE,
    });

    await ctx.editReply({
      embeds: [
        guildLogEmbed({
          guildName: ctx.guild?.name ?? 'Server',
          filter,
          page: safePage,
          pages,
          totals,
          rows,
        }),
      ],
      allowedMentions: { parse: [] },
    });
    return;
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
    .addBooleanOption((option) =>
      option
        .setName('global')
        .setDescription('Show every member in this server (Manage Server)')
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
  usage: 'coin-log [@member | all] [earn|transfer|purchase|refund|admin|backfill] [page]',
  cooldown: 3,
  guildOnly: true,

  async execute(ctx, client) {
    return runCoinLog(ctx, client);
  },
};
