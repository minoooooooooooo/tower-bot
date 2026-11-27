import { getDb } from '../lib/db.js';

/**
 * The coin ledger. Every signed balance movement writes one row in the same
 * transaction as the `profiles.coins` update, including the balance after it, so
 * `/coin-log` can show history without replaying the database.
 */

export const COIN_PAGE_SIZE = 8;

export const COIN_TYPE_LABELS = {
  earn: 'مكافأة مستوى',
  backfill: 'رصيد افتتاحي',
  transfer_in: 'تحويل داخل',
  transfer_out: 'تحويل خارج',
  purchase: 'شراء',
  refund: 'استرجاع',
  admin_add: 'إضافة مشرف',
  admin_remove: 'خصم مشرف',
  adjust: 'تعديل',
};

export const COIN_FILTERS = ['all', 'earn', 'transfer', 'purchase', 'refund', 'admin', 'backfill'];

export const COIN_FILTER_LABELS = {
  all: 'كل الحركة',
  earn: 'مكافآت المستويات',
  transfer: 'التحويلات',
  purchase: 'المشتريات',
  refund: 'الاسترجاعات',
  admin: 'تعديلات المشرفين',
  backfill: 'الأرصدة الافتتاحية',
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

/** Hand-written adjustments; only these can be removed from the log. */
const ADMIN_TYPES = ['admin_add', 'admin_remove', 'adjust'];

function mapRow(row) {
  let detail = null;

  if (row.detail) {
    try {
      detail = JSON.parse(row.detail);
    } catch {
      detail = null;
    }
  }

  return { ...row, detail };
}

function whereFor(guildId, userId, filter) {
  const clauses = ['guild_id = ?'];
  const args = [guildId];

  if (userId) {
    clauses.push('user_id = ?');
    args.push(userId);
  }

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
  return queryHistory(guildId, userId, { filter, limit, offset });
}

/** The same history for every member in the guild (Manage Server only). */
export function guildCoinHistory(guildId, { filter = 'all', limit = COIN_PAGE_SIZE, offset = 0 } = {}) {
  return queryHistory(guildId, null, { filter, limit, offset });
}

function queryHistory(guildId, userId, { filter = 'all', limit = COIN_PAGE_SIZE, offset = 0 } = {}) {
  const { where, args } = whereFor(guildId, userId, filter);
  const rows = getDb()
    .prepare(
      `SELECT id, user_id, amount, balance_after, type, actor_id, detail, created_at
         FROM coin_transactions
        WHERE ${where}
        ORDER BY id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...args, Math.max(1, Math.trunc(limit)), Math.max(0, Math.trunc(offset)));

  return rows.map(mapRow);
}

/** Hand-written adjustments, newest first, optionally for one member. */
export function adminTransactions(guildId, { userId = null, limit = 15, offset = 0 } = {}) {
  const clauses = [`guild_id = ?`, `type IN (${ADMIN_TYPES.map(() => '?').join(', ')})`];
  const args = [guildId, ...ADMIN_TYPES];

  if (userId) {
    clauses.push('user_id = ?');
    args.push(userId);
  }

  const rows = getDb()
    .prepare(
      `SELECT id, user_id, amount, balance_after, type, actor_id, detail, created_at
         FROM coin_transactions
        WHERE ${clauses.join(' AND ')}
        ORDER BY id DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...args, Math.max(1, Math.trunc(limit)), Math.max(0, Math.trunc(offset)));

  return rows.map(mapRow);
}

export function countAdminTransactions(guildId, { userId = null } = {}) {
  const clauses = [`guild_id = ?`, `type IN (${ADMIN_TYPES.map(() => '?').join(', ')})`];
  const args = [guildId, ...ADMIN_TYPES];

  if (userId) {
    clauses.push('user_id = ?');
    args.push(userId);
  }

  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count
         FROM coin_transactions
        WHERE ${clauses.join(' AND ')}`,
    )
    .get(...args);

  return Number(row?.count) || 0;
}

export function coinTransaction(guildId, id) {
  const row = getDb()
    .prepare(
      `SELECT id, user_id, amount, balance_after, type, actor_id, detail, created_at
         FROM coin_transactions
        WHERE guild_id = ? AND id = ?`,
    )
    .get(guildId, Math.trunc(Number(id) || 0));

  return row ? mapRow(row) : null;
}

/**
 * Removes one hand-written adjustment. The current balance is left alone: this
 * deletes history, not coins. Later rows for the same member are re-based by
 * the removed amount so their "balance after" still follows.
 */
export function removeAdminTransaction(guildId, id) {
  const numeric = Math.trunc(Number(id) || 0);

  if (numeric <= 0) return { ok: false, reason: 'id' };

  const db = getDb();
  const row = coinTransaction(guildId, numeric);

  if (!row) return { ok: false, reason: 'missing' };
  if (!ADMIN_TYPES.includes(String(row.type))) return { ok: false, reason: 'type', row };

  db.exec('BEGIN');

  try {
    db.prepare('DELETE FROM coin_transactions WHERE guild_id = ? AND id = ?').run(guildId, numeric);
    db.prepare(
      `UPDATE coin_transactions
          SET balance_after = MAX(0, balance_after - ?)
        WHERE guild_id = ? AND user_id = ? AND id > ?`,
    ).run(Math.trunc(Number(row.amount) || 0), guildId, row.user_id, numeric);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { ok: true, row };
}

export function coinTotals(guildId, userId, { filter = 'all' } = {}) {
  return queryTotals(guildId, userId, filter);
}

/** Guild-wide totals, including the number of distinct members with rows. */
export function guildCoinTotals(guildId, { filter = 'all' } = {}) {
  return queryTotals(guildId, null, filter);
}

function queryTotals(guildId, userId, filter) {
  const { where, args } = whereFor(guildId, userId, filter);
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count,
              COUNT(DISTINCT user_id) AS members,
              COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS earned,
              COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS spent
         FROM coin_transactions
        WHERE ${where}`,
    )
    .get(...args);

  return {
    count: Number(row?.count) || 0,
    members: Number(row?.members) || 0,
    earned: Number(row?.earned) || 0,
    spent: Number(row?.spent) || 0,
  };
}
