import { BACKGROUNDS } from './profile-backgrounds.js';

/**
 * The catalogue is defined here in code; only a price change or hiding an item
 * needs a database row (see `store_items` and `/store-config`). Adding a new
 * item is one object in `STORE_ITEMS` plus a case in `deliver()` in
 * `src/services/store.js`.
 *
 * `price` is in coins. `limit` is how many fulfilled purchases one member may
 * hold (0 means unlimited). `needs` tells the command which extra inputs the
 * item wants: `name`, `color`, `image`.
 */

export const STORE_TYPE_LABELS = {
  background: 'Profile backgrounds',
  xp: 'Experience',
  behavior: 'Good behaviour',
  title: 'Profile title',
  role: 'Custom role',
  emoji: 'Server emoji',
};

/** Discord's limit for one emoji upload. */
export const MAX_EMOJI_BYTES = 256 * 1024;

export const EMOJI_NAME_PATTERN = /^[a-zA-Z0-9_]{2,32}$/;

export const STORE_ITEMS = [
  {
    key: 'xp-10',
    type: 'xp',
    name: '10 XP',
    price: 40,
    amount: 10,
    limit: 0,
    summary: 'Adds 10 XP (50 Nightmare points). Punishments still tax the gain.',
  },
  {
    key: 'behavior-25',
    type: 'behavior',
    name: '25 good behaviour points',
    price: 30,
    amount: 25,
    limit: 0,
    summary: 'Adds 25 good behaviour points to your card.',
  },
  {
    key: 'profile-title',
    type: 'title',
    name: 'Profile title',
    price: 60,
    limit: 0,
    needs: ['name'],
    summary: 'Sets the title on your card. Buy again to change it.',
  },
  {
    key: 'emoji-slot',
    type: 'emoji',
    name: 'Server emoji',
    price: 75,
    limit: 3,
    needs: ['name', 'image'],
    summary: 'Uploads an emoji for you (PNG, JPEG, WebP or GIF up to 256 KB).',
  },
  {
    key: 'custom-role',
    type: 'role',
    name: 'Custom role',
    price: 120,
    limit: 1,
    needs: ['name'],
    summary: 'Creates a role with your name and colour and gives it to you.',
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
    name: `${background.name} background`,
    price: Math.max(1, Math.trunc(Number(background.price) || 0)),
    backgroundId: background.id,
    level: background.level,
    limit: 1,
    summary: `Unlocks the ${background.name} design for your profile card.`,
  }));
}

/** Every item the code knows about, before guild overrides. */
export function baseStoreItems() {
  return [...STORE_ITEMS, ...backgroundStoreItems()];
}

export function baseStoreItem(key) {
  return baseStoreItems().find((item) => item.key === key) ?? null;
}
