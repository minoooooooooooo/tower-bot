import { getDb } from '../lib/db.js';
import { createLogger } from '../lib/logger.js';
import { recordCoinTransaction } from './coin-ledger.js';
import { settleProfile } from './profile-store.js';

const logger = createLogger('characters');

/**
 * A character reservation is a paid placeholder for a character name. It is not
 * tied to the level ladder: the member pays once, chooses a name, and can rename
 * it until a manager reviews it. Managers see every pending reservation in the
 * Characters tab.
 */

/** Override row in `store_items` for the reservation item. */
export const RESERVE_KEY = 'character-reserve';

export const DEFAULT_RESERVE_PRICE = 100;
export const MAX_RESERVE_PRICE = 100_000;
export const MAX_RESERVATION_NAME = 40;

const PENDING = 'pending';

function db() {
  return getDb();
}

function cleanName(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_RESERVATION_NAME);
}

function mapRow(row) {
  if (!row) return null;

  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    userName: row.user_name ?? null,
    name: row.name,
    status: row.status,
    price: Number(row.price) || 0,
    purchaseId: row.purchase_id === null ? null : Number(row.purchase_id),
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

/* ── Settings (per guild) ─────────────────────────────────────────────────── */

export function reservationSettings(guildId) {
  const row = db()
    .prepare('SELECT price, enabled FROM store_items WHERE guild_id = ? AND item_key = ?')
    .get(guildId, RESERVE_KEY);

  return {
    // Visible by default so the option appears after the update. A manager can
    // hide it from the Characters tab at any time.
    enabled: row && row.enabled !== null ? row.enabled !== 0 : true,
    price:
      row && row.price !== null
        ? Math.max(0, Math.min(MAX_RESERVE_PRICE, Number(row.price) || 0))
        : DEFAULT_RESERVE_PRICE,
    overridden: Boolean(row),
  };
}

export function setReservationSettings(guildId, { enabled, price } = {}) {
  const current = reservationSettings(guildId);
  const nextPrice =
    price === undefined
      ? current.price
      : Math.max(0, Math.min(MAX_RESERVE_PRICE, Math.trunc(Number(price) || 0)));
  const nextEnabled = enabled === undefined ? current.enabled : Boolean(enabled);

  db()
    .prepare(
      `INSERT INTO store_items (guild_id, item_key, price, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, item_key) DO UPDATE SET
         price = excluded.price,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
    )
    .run(guildId, RESERVE_KEY, nextPrice, nextEnabled ? 1 : 0, Date.now());

  return reservationSettings(guildId);
}

/* ── Reading ──────────────────────────────────────────────────────────────── */

export function pendingReservationFor(guildId, userId) {
  return mapRow(
    db()
      .prepare(
        `SELECT * FROM character_reservations
          WHERE guild_id = ? AND user_id = ? AND status = ?
          ORDER BY id DESC LIMIT 1`,
      )
      .get(guildId, userId, PENDING),
  );
}

export function pendingReservations(guildId) {
  return db()
    .prepare(
      `SELECT * FROM character_reservations
        WHERE guild_id = ? AND status = ?
        ORDER BY id DESC`,
    )
    .all(guildId, PENDING)
    .map(mapRow);
}

/* ── Writing ──────────────────────────────────────────────────────────────── */

/**
 * Charges the configured price and creates a pending reservation in one
 * transaction, so a member can never be charged without the reservation (or
 * receive one without paying). A member may hold one pending reservation at a
 * time; while it is pending they can rename it for free.
 */
export function reserveCharacter({ guildId, userId, userName = null, name }) {
  const clean = cleanName(name);

  if (!clean) return { ok: false, reason: 'name' };

  const settings = reservationSettings(guildId);

  if (!settings.enabled) {
    return { ok: false, reason: 'disabled', message: 'حجز الشخصيات مقفّل حاليًا.' };
  }

  const existing = pendingReservationFor(guildId, userId);

  if (existing) return { ok: false, reason: 'pending', reservation: existing };

  settleProfile(guildId, userId);

  const database = db();
  const now = Date.now();
  const price = settings.price;

  database.exec('BEGIN');

  try {
    const row = database
      .prepare('SELECT coins FROM profiles WHERE guild_id = ? AND user_id = ?')
      .get(guildId, userId);
    const balance = Number(row?.coins) || 0;

    if (balance < price) {
      database.exec('ROLLBACK');
      return { ok: false, reason: 'funds', balance, price };
    }

    if (price > 0) {
      database.prepare(
        'UPDATE profiles SET coins = coins - ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
      ).run(price, now, guildId, userId);
    }

    const purchase = database
      .prepare(
        `INSERT INTO store_purchases
           (guild_id, user_id, item_key, price, status, detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'fulfilled', NULL, ?, ?)`,
      )
      .run(guildId, userId, RESERVE_KEY, price, now, now);
    const purchaseId = Number(purchase.lastInsertRowid);

    const inserted = database
      .prepare(
        `INSERT INTO character_reservations
           (guild_id, user_id, user_name, name, status, price, purchase_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(guildId, userId, userName, clean, PENDING, price, purchaseId, now, now);
    const reservationId = Number(inserted.lastInsertRowid);

    database
      .prepare('UPDATE store_purchases SET detail = ? WHERE id = ?')
      .run(JSON.stringify({ reservationId, characterName: clean }), purchaseId);

    if (price > 0) {
      recordCoinTransaction({
        guildId,
        userId,
        amount: -price,
        balanceAfter: balance - price,
        type: 'purchase',
        actorId: userId,
        detail: {
          purchaseId,
          itemKey: RESERVE_KEY,
          itemName: 'Character reservation',
          itemType: 'reservation',
          quantity: 1,
          unitPrice: price,
        },
      });
    }

    database.exec('COMMIT');

    logger.info(
      `Character reservation ${reservationId} created for ${userId} in ${guildId} (${price} coins)`,
    );

    return {
      ok: true,
      reservation: mapRow(
        database
          .prepare('SELECT * FROM character_reservations WHERE id = ?')
          .get(reservationId),
      ),
      price,
      balance: balance - price,
    };
  } catch (error) {
    database.exec('ROLLBACK');
    logger.error(`Could not reserve a character for ${userId}`, error);
    return { ok: false, reason: 'database' };
  }
}

/** Renames a pending reservation the caller owns. No extra charge. */
export function renameReservation({ guildId, userId, id, name }) {
  const clean = cleanName(name);

  if (!clean) return { ok: false, reason: 'name' };

  const reservationId = Math.trunc(Number(id));

  if (!Number.isFinite(reservationId) || reservationId <= 0) {
    return { ok: false, reason: 'unknown' };
  }

  const database = db();
  const existing = database
    .prepare(
      `SELECT * FROM character_reservations
        WHERE id = ? AND guild_id = ? AND user_id = ? AND status = ?`,
    )
    .get(reservationId, guildId, userId, PENDING);

  if (!existing) return { ok: false, reason: 'unknown' };

  database
    .prepare('UPDATE character_reservations SET name = ?, updated_at = ? WHERE id = ?')
    .run(clean, Date.now(), reservationId);

  return {
    ok: true,
    reservation: mapRow(
      database.prepare('SELECT * FROM character_reservations WHERE id = ?').get(reservationId),
    ),
  };
}

/** Removes a pending reservation and refunds it; used by future moderator tools. */
export function cancelReservation({ guildId, userId = null, id }) {
  const reservationId = Math.trunc(Number(id));

  if (!Number.isFinite(reservationId) || reservationId <= 0) {
    return { ok: false, reason: 'unknown' };
  }

  const database = db();
  const row = database
    .prepare(
      `SELECT * FROM character_reservations
        WHERE id = ? AND guild_id = ? AND status = ?
          AND (? IS NULL OR user_id = ?)`,
    )
    .get(reservationId, guildId, PENDING, userId, userId);

  if (!row) return { ok: false, reason: 'unknown' };

  const refund = Math.max(0, Number(row.price) || 0);
  const now = Date.now();

  database.exec('BEGIN');

  try {
    database
      .prepare("UPDATE character_reservations SET status = 'cancelled', updated_at = ? WHERE id = ?")
      .run(now, reservationId);

    if (refund > 0) {
      database
        .prepare('UPDATE profiles SET coins = coins + ?, updated_at = ? WHERE guild_id = ? AND user_id = ?')
        .run(refund, now, guildId, row.user_id);

      const balance = database
        .prepare('SELECT coins FROM profiles WHERE guild_id = ? AND user_id = ?')
        .get(guildId, row.user_id);

      recordCoinTransaction({
        guildId,
        userId: row.user_id,
        amount: refund,
        balanceAfter: Number(balance?.coins) || 0,
        type: 'refund',
        actorId: userId,
        detail: { reservationId, itemKey: RESERVE_KEY, itemName: 'Character reservation' },
      });
    }

    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    logger.error(`Could not cancel reservation ${reservationId}`, error);
    return { ok: false, reason: 'database' };
  }

  return { ok: true, id: reservationId, refund };
}
