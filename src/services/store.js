import { PermissionFlagsBits } from 'discord.js';
import { getDb } from '../lib/db.js';
import { createLogger } from '../lib/logger.js';
import { parseColor } from '../commands/general/color.js';
import {
  MAX_EMOJI_BYTES,
  EMOJI_NAME_PATTERN,
  backgroundIdFromKey,
  baseStoreItems,
} from './store-catalog.js';
import {
  MAX_TITLE_LENGTH,
  POINTS_PER_XP,
  addProfilePoints,
  getProfile,
  setProfileTitle,
  settleProfile,
} from './profile-store.js';

const logger = createLogger('store');

const FULFILLED = 'fulfilled';
const REFUNDED = 'refunded';
const PENDING = 'pending';

// Discord's emoji capacity by boost tier (tier 0–3).
const STATIC_EMOJI_SLOTS = [50, 100, 150, 250];
const ANIMATED_EMOJI_SLOTS = [0, 0, 50, 100];

const EMOJI_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);

/** Upper bound for one stackable purchase, so a typo cannot drain a wallet. */
export const MAX_STACK = 100;

function db() {
  return getDb();
}

function parseDetail(row) {
  if (!row?.detail) return null;

  try {
    return JSON.parse(row.detail);
  } catch {
    return null;
  }
}

/* ── Catalogue ────────────────────────────────────────────────────────────── */

function overrideRow(guildId, key) {
  return (
    db()
      .prepare('SELECT price, enabled FROM store_items WHERE guild_id = ? AND item_key = ?')
      .get(guildId, key) ?? null
  );
}

/** The code catalogue plus this guild's price and visibility changes. */
export function storeCatalog(guildId) {
  return baseStoreItems().map((item) => {
    const row = overrideRow(guildId, item.key);

    return {
      ...item,
      defaultPrice: item.price,
      price: row && row.price !== null ? Number(row.price) : item.price,
      enabled: row && row.enabled !== null ? row.enabled !== 0 : true,
      overridden: Boolean(row),
    };
  });
}

export function storeItem(guildId, key) {
  return storeCatalog(guildId).find((item) => item.key === key) ?? null;
}

/**
 * Finds an item by key, design id or name. Exact keys win, then a key fragment,
 * then a name fragment, so `tier-20`, `design:tier-20` and `amethyst` all work.
 */
export function findStoreItem(guildId, query) {
  const raw = String(query ?? '').trim().toLowerCase();
  if (!raw) return null;

  const items = storeCatalog(guildId);
  const design = backgroundIdFromKey(raw) ?? raw;

  return (
    items.find((item) => item.key.toLowerCase() === raw) ??
    items.find((item) => item.type === 'background' && item.backgroundId === design) ??
    items.find((item) => item.key.toLowerCase().includes(raw)) ??
    items.find((item) => item.name.toLowerCase() === raw) ??
    items.find((item) => item.name.toLowerCase().includes(raw)) ??
    null
  );
}

/** Sets one guild's price and/or visibility. Missing fields keep their value. */
export function setStoreOverride(guildId, key, patch = {}) {
  const current = overrideRow(guildId, key);
  const price = 'price' in patch ? patch.price : (current?.price ?? null);
  const enabled = 'enabled' in patch ? patch.enabled : (current?.enabled ?? null);

  db()
    .prepare(
      `INSERT INTO store_items (guild_id, item_key, price, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (guild_id, item_key) DO UPDATE SET
         price = excluded.price,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
    )
    .run(
      guildId,
      key,
      price === null || price === undefined ? null : Math.max(0, Math.trunc(Number(price) || 0)),
      enabled === null || enabled === undefined ? null : enabled ? 1 : 0,
      Date.now(),
    );

  return storeItem(guildId, key);
}

export function clearStoreOverride(guildId, key) {
  db().prepare('DELETE FROM store_items WHERE guild_id = ? AND item_key = ?').run(guildId, key);
  return storeItem(guildId, key);
}

/** Fulfilled sales per item, for `/store-config list`. */
export function storeSales(guildId) {
  const rows = db()
    .prepare(
      `SELECT item_key, COUNT(*) AS count, SUM(price) AS coins
         FROM store_purchases
        WHERE guild_id = ? AND status = ?
        GROUP BY item_key`,
    )
    .all(guildId, FULFILLED);

  return new Map(
    rows.map((row) => [row.item_key, { count: Number(row.count), coins: Number(row.coins) || 0 }]),
  );
}

/* ── Purchases ───────────────────────────────────────────────────────────── */

function fulfilledCount(guildId, userId, key) {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS count FROM store_purchases
        WHERE guild_id = ? AND user_id = ? AND item_key = ? AND status = ?`,
    )
    .get(guildId, userId, key, FULFILLED);

  return Number(row?.count) || 0;
}

/** Everything one member owns, newest first. */
export function memberPurchases(guildId, userId) {
  return db()
    .prepare(
      `SELECT id, item_key, price, detail, created_at
         FROM store_purchases
        WHERE guild_id = ? AND user_id = ? AND status = ?
        ORDER BY created_at DESC, id DESC`,
    )
    .all(guildId, userId, FULFILLED)
    .map((row) => ({ ...row, detail: parseDetail(row) }));
}

/** Design ids this member bought, used by `/background` and the card. */
export function ownedBackgroundIds(guildId, userId) {
  const rows = db()
    .prepare(
      `SELECT item_key FROM store_purchases
        WHERE guild_id = ? AND user_id = ? AND status = ? AND item_key LIKE 'design:%'`,
    )
    .all(guildId, userId, FULFILLED);

  const ids = new Set();

  for (const row of rows) {
    const id = backgroundIdFromKey(row.item_key);
    if (id) ids.add(id);
  }

  return ids;
}

/* ── Delivery checks ─────────────────────────────────────────────────────── */

function emojiCapacity(guild) {
  const tier = Math.min(3, Math.max(0, Number(guild?.premiumTier) || 0));

  return {
    static: STATIC_EMOJI_SLOTS[tier],
    animated: ANIMATED_EMOJI_SLOTS[tier],
  };
}

function attachmentKind(attachment) {
  const type = String(attachment?.contentType ?? '').toLowerCase();

  if (type) return type;

  const name = String(attachment?.name ?? attachment?.url ?? '').toLowerCase();

  if (/\.jpe?g$/.test(name)) return 'image/jpeg';
  if (/\.webp$/.test(name)) return 'image/webp';
  if (/\.gif$/.test(name)) return 'image/gif';

  return 'image/png';
}

function cleanRoleName(value) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^@+/, '');

  if (!text) return null;
  if (/^(everyone|here)$/i.test(text)) return null;

  return text.slice(0, 32);
}

function cleanTitle(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH) || null;
}

function canManageRoles(guild) {
  const me = guild?.members?.me;

  return Boolean(me?.permissions?.has?.(PermissionFlagsBits.ManageRoles));
}

function canManageEmojis(guild) {
  const me = guild?.members?.me;
  const flag =
    PermissionFlagsBits.ManageGuildExpressions ?? PermissionFlagsBits.ManageEmojisAndStickers;

  return Boolean(me?.permissions?.has?.(flag));
}

function hasFreeEmojiSlot(guild, animated) {
  const capacity = emojiCapacity(guild);
  const emojis = guild?.emojis?.cache;

  if (!emojis) return true;

  const used = emojis.filter((emoji) => Boolean(emoji.animated)).size;
  const usedStatic = emojis.size - used;

  if (animated) {
    return capacity.animated > 0 && used < capacity.animated;
  }

  return usedStatic < capacity.static;
}

/* ── Delivery ────────────────────────────────────────────────────────────── */

async function deliver({ item, guild, guildId, userId, member, name, color, attachment, quantity = 1 }) {
  switch (item.type) {
    case 'xp': {
      const xp = Math.max(1, Math.trunc(Number(item.amount) || 1)) * quantity;
      const points = xp * POINTS_PER_XP;

      addProfilePoints(guildId, userId, { nightmare: points });
      return { xp, points, quantity };
    }

    case 'behavior': {
      const points = Math.max(1, Math.trunc(Number(item.amount) || 1)) * quantity;

      addProfilePoints(guildId, userId, { goodBehavior: points });
      return { points, quantity };
    }

    case 'title': {
      const title = cleanTitle(name);

      setProfileTitle(guildId, userId, title);
      return { title };
    }

    case 'background':
      return { backgroundId: item.backgroundId };

    case 'role': {
      const parsed = color ? parseColor(color) : null;
      const role = await guild.roles.create({
        name,
        color: parsed?.value,
        hoist: false,
        mentionable: false,
        reason: `Store purchase by ${userId}`,
      });

      try {
        const target = member ?? (await guild.members.fetch(userId));
        await target.roles.add(role, 'Store purchase');
      } catch (error) {
        await role.delete('Store purchase could not be assigned').catch(() => null);
        throw error;
      }

      return { roleId: role.id, name: role.name, color: parsed?.hex ?? null };
    }

    case 'emoji': {
      const emoji = await guild.emojis.create({
        attachment: attachment.buffer ?? attachment.url,
        name,
        reason: `Store purchase by ${userId}`,
      });

      return { emojiId: emoji.id, name: emoji.name, animated: Boolean(emoji.animated) };
    }

    default:
      throw new Error(`No delivery handler for item type "${item.type}".`);
  }
}

function refundPurchase(guildId, userId, purchaseId, price) {
  const now = Date.now();

  db().exec('BEGIN');

  try {
    db()
      .prepare('UPDATE profiles SET coins = coins + ?, updated_at = ? WHERE guild_id = ? AND user_id = ?')
      .run(price, now, guildId, userId);
    db()
      .prepare('UPDATE store_purchases SET status = ?, updated_at = ? WHERE id = ?')
      .run(REFUNDED, now, purchaseId);
    db().exec('COMMIT');
  } catch (error) {
    db().exec('ROLLBACK');
    throw error;
  }
}

/** Turns a Discord failure into something a member can act on. */
function deliveryMessage(error) {
  const code = Number(error?.code);

  if (code === 50013) return 'I am missing a permission for that. Tell an admin.';
  if (code === 30008) return 'The server has no free emoji slots left. Tell an admin.';
  if (code === 50035) return 'Discord refused the name or image. Try another.';

  return 'Discord refused it, so your coins were refunded.';
}

/* ── Buying ──────────────────────────────────────────────────────────────── */

/**
 * Validates, charges and delivers one purchase.
 *
 * The coins are taken and a `pending` row is written in one transaction, so a
 * crash can never leave a member charged without a record. Delivery runs after
 * that; if it fails, the coins are returned and the row becomes `refunded`.
 *
 * Returns `{ ok: true, ... }` or `{ ok: false, reason, ... }`.
 */
export async function buyStoreItem({
  guild = null,
  guildId,
  userId,
  member = null,
  key,
  name = null,
  color = null,
  attachment = null,
  quantity = 1,
}) {
  const item = findStoreItem(guildId, key);
  const id = guildId;

  if (!item) return { ok: false, reason: 'unknown', query: key };
  if (!item.enabled) return { ok: false, reason: 'disabled', item };
  if (item.price < 0) return { ok: false, reason: 'unpriced', item };

  // Only stackable items honour a quantity; everything else is one per buy.
  const qty = item.stackable
    ? Math.min(MAX_STACK, Math.max(1, Math.trunc(Number(quantity) || 1)))
    : 1;
  const totalPrice = item.price * qty;

  if (item.limit > 0 && fulfilledCount(id, userId, item.key) >= item.limit) {
    return { ok: false, reason: 'limit', item, limit: item.limit };
  }

  let roleName = null;
  let emojiName = null;
  let emojiKind = 'image/png';
  let title = null;

  if (item.type === 'role') {
    roleName = cleanRoleName(name);

    if (!roleName) {
      return {
        ok: false,
        reason: 'name',
        item,
        message: 'Send a role name (1–32 characters, not `@everyone`).',
      };
    }

    if (color && !parseColor(color)) {
      return {
        ok: false,
        reason: 'color',
        item,
        message: 'Use a hex colour like `#ff8800` or a name like `red`.',
      };
    }

    if (!guild) return { ok: false, reason: 'guild', item };
    if (!canManageRoles(guild)) {
      return {
        ok: false,
        reason: 'permission',
        item,
        message: 'I need **Manage Roles** before I can create your role.',
      };
    }
  }

  if (item.type === 'emoji') {
    emojiName = String(name ?? '').trim();

    if (!EMOJI_NAME_PATTERN.test(emojiName)) {
      return {
        ok: false,
        reason: 'name',
        item,
        message: 'Emoji names use 2–32 letters, numbers or underscores, like `tower_star`.',
      };
    }

    if (!attachment?.url) {
      return {
        ok: false,
        reason: 'image',
        item,
        message: 'Attach the emoji image (PNG, JPEG, WebP or GIF).',
      };
    }

    emojiKind = attachmentKind(attachment);

    if (!EMOJI_TYPES.has(emojiKind)) {
      return {
        ok: false,
        reason: 'image',
        item,
        message: 'The emoji must be a PNG, JPEG, WebP or GIF image.',
      };
    }

    if (Number(attachment.size) > MAX_EMOJI_BYTES) {
      return {
        ok: false,
        reason: 'size',
        item,
        message: `The image is ${Math.ceil(Number(attachment.size) / 1024)} KB; the limit is 256 KB.`,
      };
    }

    if (!guild) return { ok: false, reason: 'guild', item };

    if (!canManageEmojis(guild)) {
      return {
        ok: false,
        reason: 'permission',
        item,
        message: 'I need **Manage Expressions** before I can upload an emoji.',
      };
    }

    const animated = emojiKind === 'image/gif';

    if (!hasFreeEmojiSlot(guild, animated)) {
      return {
        ok: false,
        reason: 'slots',
        item,
        message: animated
          ? 'The server has no free animated emoji slots.'
          : 'The server has no free emoji slots.',
      };
    }
  }

  if (item.type === 'title') {
    title = cleanTitle(name);

    if (!title) {
      return {
        ok: false,
        reason: 'name',
        item,
        message: 'Send the title you want (up to 32 characters).',
      };
    }
  }

  // A level reached since the last read may already have paid coins.
  settleProfile(id, userId);

  const now = Date.now();
  let purchaseId = 0;
  let balance = 0;

  db().exec('BEGIN');

  try {
    const row = db()
      .prepare('SELECT coins FROM profiles WHERE guild_id = ? AND user_id = ?')
      .get(id, userId);

    balance = Number(row?.coins) || 0;

    if (balance < totalPrice) {
      db().exec('ROLLBACK');
      return { ok: false, reason: 'funds', item, balance, quantity: qty, totalPrice };
    }

    db()
      .prepare('UPDATE profiles SET coins = coins - ?, updated_at = ? WHERE guild_id = ? AND user_id = ?')
      .run(totalPrice, now, id, userId);

    const info = db()
      .prepare(
        `INSERT INTO store_purchases
           (guild_id, user_id, item_key, price, status, detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(id, userId, item.key, totalPrice, PENDING, now, now);

    purchaseId = Number(info.lastInsertRowid);
    balance -= totalPrice;
    db().exec('COMMIT');
  } catch (error) {
    db().exec('ROLLBACK');
    logger.error(`Could not charge ${userId} for ${item.key}`, error);
    return { ok: false, reason: 'database', item };
  }

  let detail;

  try {
    detail = await deliver({
      item,
      guild,
      guildId: id,
      userId,
      member,
      name: item.type === 'role' ? roleName : item.type === 'emoji' ? emojiName : title,
      color,
      attachment,
      quantity: qty,
    });
  } catch (error) {
    logger.warn(`Delivery failed for ${item.key} to ${userId}: ${error?.message ?? error}`);

    try {
      refundPurchase(id, userId, purchaseId, totalPrice);
    } catch (refundError) {
      logger.error(`Could not refund purchase ${purchaseId}`, refundError);
    }

    return {
      ok: false,
      reason: 'delivery',
      item,
      message: deliveryMessage(error),
      refunded: true,
    };
  }

  try {
    db()
      .prepare('UPDATE store_purchases SET status = ?, detail = ?, updated_at = ? WHERE id = ?')
      .run(FULFILLED, JSON.stringify(detail ?? {}), Date.now(), purchaseId);
  } catch (error) {
    logger.error(`Could not finish purchase ${purchaseId}`, error);
  }

  logger.info(`Store: ${userId} bought ${item.key} x${qty} for ${totalPrice} coins in ${id}`);

  return {
    ok: true,
    item,
    purchaseId,
    price: totalPrice,
    unitPrice: item.price,
    quantity: qty,
    balance,
    detail: detail ?? {},
  };
}

/** Marks a member's fulfilled purchases as void so they can buy again. */
export function voidMemberPurchases(guildId, userId, key = null) {
  const now = Date.now();
  const sql = key
    ? `UPDATE store_purchases SET status = 'void', updated_at = ?
        WHERE guild_id = ? AND user_id = ? AND item_key = ? AND status = ?`
    : `UPDATE store_purchases SET status = 'void', updated_at = ?
        WHERE guild_id = ? AND user_id = ? AND status = ?`;
  const args = key
    ? [now, guildId, userId, key, FULFILLED]
    : [now, guildId, userId, FULFILLED];

  const result = db().prepare(sql).run(...args);
  return Number(result.changes) || 0;
}

/** A balance read that does not forget a level reached since the last check. */
export function storeBalance(guildId, userId) {
  settleProfile(guildId, userId);
  return getProfile(guildId, userId).coins;
}
