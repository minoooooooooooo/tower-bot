import { BACKGROUNDS } from './profile-backgrounds.js';

/**
 * The catalogue is defined here in code; only a price change or hiding an item
 * needs a database row (see `store_items` and `/store-config`). Adding a new
 * item is one object in `STORE_ITEMS` plus a case in `deliver()` in
 * `src/services/store.js`.
 *
 * `price` is in coins. `limit` is how many fulfilled purchases one member may
 * hold (0 means unlimited). `needs` tells the command which extra inputs the
 * item wants: `name`, `color`, `image`. `stackable` items can be bought in a
 * quantity (`/store buy <key> quantity:5`), which multiplies both the price and
 * the `amount` delivered.
 */

export const STORE_TYPE_LABELS = {
  background: 'خلفيات الملف',
  xp: 'الخبرة',
  behavior: 'السلوك الحسن',
  title: 'لقب الملف',
  role: 'رتبة خاصة',
  emoji: 'إيموجي السيرفر',
};

/** Discord's limit for one emoji upload. */
export const MAX_EMOJI_BYTES = 256 * 1024;

export const EMOJI_NAME_PATTERN = /^[a-zA-Z0-9_]{2,32}$/;

export const STORE_ITEMS = [
  {
    key: 'xp-10',
    type: 'xp',
    name: '10 خبرة',
    price: 40,
    amount: 10,
    limit: 0,
    summary: 'يضيف 10 خبرة (50 نقطة Nightmare). العقوبات لسا تنقص من المكسب.',
  },
  {
    key: 'behavior-1',
    type: 'behavior',
    name: 'نقطة سلوك حسن',
    price: 100,
    amount: 1,
    limit: 0,
    stackable: true,
    summary: 'يضيف نقطة سلوك حسن لبطاقتك. اشترِ أكثر من وحدة مرة وحدة بالكمية.',
  },
  {
    key: 'profile-title',
    type: 'title',
    name: 'لقب الملف',
    price: 60,
    limit: 0,
    needs: ['name'],
    summary: 'يحط اللقب على بطاقتك. اشتره مرة ثانية عشان تغيّره.',
  },
  {
    key: 'emoji-slot',
    type: 'emoji',
    name: 'إيموجي سيرفر',
    price: 75,
    limit: 3,
    needs: ['name', 'image'],
    summary: 'يرفع لك إيموجي (PNG أو JPEG أو WebP أو GIF حتى 256 كيلوبايت).',
  },
  {
    key: 'custom-role',
    type: 'role',
    name: 'رتبة خاصة',
    price: 120,
    limit: 1,
    needs: ['name'],
    summary: 'ينشئ رتبة باسمك ولونك ويعطيك إياها.',
  },
];

/** Store key for a design that has a price in `backgrounds.json`. */
export function designItemKey(backgroundId) {
  return `design:${backgroundId}`;
}

/** Reads the design id back out of a `design:<id>` key. */
export function backgroundIdFromKey(key) {
  const text = String(key ?? '').trim();
  if (!text.startsWith('design:')) return null;

  const id = text.slice('design:'.length).trim();
  return id || null;
}

/**
 * Paid designs are part of the catalogue only while their manifest entry has
 * `price > 0`. Keep the art and the ladder entry as they are; adding a price is
 * the whole switch. Free ladder designs never appear here.
 */
export function backgroundStoreItems() {
  return BACKGROUNDS.filter((background) => Number(background.price) > 0).map((background) => ({
    key: designItemKey(background.id),
    type: 'background',
    name: background.name,
    price: Math.max(1, Math.trunc(Number(background.price) || 0)),
    backgroundId: background.id,
    level: background.level,
    limit: 1,
    summary: `يفتح تصميم ${background.name} على بطاقة ملفك.`,
  }));
}

/** Every item the code knows about, before guild overrides. */
export function baseStoreItems() {
  return [...STORE_ITEMS, ...backgroundStoreItems()];
}

export function baseStoreItem(key) {
  return baseStoreItems().find((item) => item.key === key) ?? null;
}
