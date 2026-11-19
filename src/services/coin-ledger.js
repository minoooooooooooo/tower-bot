import { getDb } from '../lib/db.js';

/**
 * The coin ledger. Every signed balance movement writes one row in the same
 * transaction as the `profiles.coins` update, including the balance after it, so
 * `/coin-log` can show history without replaying the database.
 */

export const COIN_PAGE_SIZE = 8;

export const COIN_TYPE_LABELS = {
  earn: 'Level reward',
  backfill: 'Opening balance',
  transfer_in: 'Transfer in',
  transfer_out: 'Transfer out',
  purchase: 'Purchase',
  refund: 'Refund',
  admin_add: 'Admin added',
  admin_remove: 'Admin removed',
  adjust: 'Adjustment',
};

export const COIN_FILTERS = ['all', 'earn', 'transfer', 'purchase', 'refund', 'admin', 'backfill'];

export const COIN_FILTER_LABELS = {
  all: 'All movement',
  earn: 'Level rewards',
  transfer: 'Transfers',
  purchase: 'Purchases',
  refund: 'Refunds',
  admin: 'Admin changes',
  backfill: 'Opening balances',
};

function filterTypes(filter) {
  switch (String(filter ?? 'all').toLowerCase()) {
    case 'earn':
      return ['earn'];
    case 'transfer':
      return ['transfer_in', 'transfer_out'];
    case 'purchase':
      return ['purchase'];
    case 'refund':
      return ['refund'];
    case 'admin':
      return ['admin_add', 'admin_remove', 'adjust'];
    case 'backfill':
    case 'opening':
      return ['backfill'];
    default:
      return null;
  }
}

function whereFor(guildId, userId, filter) {
  const clauses = ['guild_id = ?', 'user_id = ?'];
  const args = [guildId, userId];
  const types = filterTypes(filter);

  if (types) {
    clauses.push(`type IN (${types.map(() => '?').join(', ')})`);
    args.push(...types);
  }

  return { where: clauses.join(' AND '), args };
}

/**
 * Low-level insert. The caller owns the surrounding transaction, so a purchase
 * or transfer cannot commit without its ledger row (or fail without rolling
 * back the coins too).
 */
export function recordCoinTransaction({
  guildId,
  userId,
  amount,
  balanceAfter,
  type = 'adjust',
  actorId = null,
  detail = null,
  createdAt = null,
}) {
  const value = Math.trunc(Number(amount) || 0);

  if (!value) return null;

  let kind = String(type || 'adjust');
  if (kind === 'admin') kind = value > 0 ? 'admin_add' : 'admin_remove';

  const info = getDb()
    .prepare(
      `INSERT INTO coin_transactions
         (guild_id, user_id, amount, balance_after, type, actor_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      guildId,
      userId,
      value,
      Math.max(0, Math.trunc(Number(balanceAfter) || 0)),
      kind,
      actorId ?? null,
      detail === null || detail === undefined ? null : JSON.stringify(detail),
      Number(createdAt) || Date.now(),
    );

  return Number(info.lastInsertRowid);
}

/**
 * Gives a member with no ledger rows a starting point at their current balance.
 * The existing history predates the ledger, so this is marked as an opening
 * balance rather than invented income.
 */
export function ensureOpeningBalance(guildId, userId, balance) {
  const coins = Math.max(0, Math.trunc(Number(balance) || 0));

  if (coins <= 0) return null;

  const row = getDb()
    .prepare(
      'SELECT COUNT(*) AS count FROM coin_transactions WHERE guild_id = ? AND user_id = ?',
    )
    .get(guildId, userId);

  if (Number(row?.count) > 0) return null;

  return recordCoinTransaction({
    guildId,
    userId,
    amount: coins,
    balanceAfter: coins,
    type: 'backfill',
    detail: { source: 'ledger started' },
  });
}

export function coinHistory(guildId, userId, { filter = 'all', limit = COIN_PAGE_SIZE, offset = 0 } = {}) {
  const { where, args } = whereFor(guildId, userId, filter);
  const rows = getDb()
    .prepare(
      `SELECT id, amount, balance_after, type, actor_id, detail, created_at
         FROM coin_transactions
        WHERE ${where}
        ORDER BY id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...args, Math.max(1, Math.trunc(limit)), Math.max(0, Math.trunc(offset)));

  return rows.map((row) => {
    let detail = null;

    if (row.detail) {
      try {
        detail = JSON.parse(row.detail);
      } catch {
        detail = null;
      }
    }

    return { ...row, detail };
  });
}

export function coinTotals(guildId, userId, { filter = 'all' } = {}) {
  const { where, args } = whereFor(guildId, userId, filter);
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS earned,
              COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS spent
         FROM coin_transactions
        WHERE ${where}`,
    )
    .get(...args);

  return {
    count: Number(row?.count) || 0,
    earned: Number(row?.earned) || 0,
    spent: Number(row?.spent) || 0,
  };
}
