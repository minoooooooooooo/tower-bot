import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { config } from '../config.js';
import { getDb } from '../lib/db.js';
import { createLogger } from '../lib/logger.js';
import { recordCoinTransaction } from './coin-ledger.js';
import { WallpaperError } from './profile-backgrounds.js';
import { settleProfile } from './profile-store.js';

const logger = createLogger('characters');

/**
 * Store characters are collectible portrait cards. They are independent from
 * the level ladder: a character has a name, a 225x350 portrait and a coin price,
 * nothing else. The catalogue lives in `data/characters.json` and the portrait
 * in `data/characters/<id>.jpg`, so admin uploads survive a bot update.
 */

export const CHARACTER_WIDTH = 225;
export const CHARACTER_HEIGHT = 350;
export const CHARACTER_ITEM_PREFIX = 'character:';

export const MAX_CHARACTER_PRICE = 100_000;

const MIN_SOURCE_SIDE = 32;
const MAX_SOURCE_SIDE = 6000;
const CHARACTER_QUALITY = 90;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const MANIFEST = path.join(config.dataDir, 'characters.json');
const ART_DIR = path.join(config.dataDir, 'characters');

function readManifest() {
  if (!existsSync(MANIFEST)) return { characters: [] };

  try {
    return JSON.parse(readFileSync(MANIFEST, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    logger.warn(`Could not read ${path.basename(MANIFEST)}: ${error.message}`);
    return { characters: [] };
  }
}

function normalizeCharacters(raw) {
  const entries = Array.isArray(raw?.characters) ? raw.characters : [];
  const characters = [];
  const seen = new Set();

  for (const entry of entries) {
    const id = String(entry?.id ?? '').trim().toLowerCase();
    const name = String(entry?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);

    if (!ID_PATTERN.test(id) || !name || seen.has(id)) continue;

    const price = Math.max(
      0,
      Math.min(MAX_CHARACTER_PRICE, Math.trunc(Number(entry?.price) || 0)),
    );

    characters.push(Object.freeze({ id, name, price }));
    seen.add(id);
  }

  characters.sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
  return characters;
}

/**
 * Mutable on purpose: admin edits reload the catalogue in place, so the running
 * storefront sees a new character without a restart.
 */
export const CHARACTERS = normalizeCharacters(readManifest());

export function reloadCharacters() {
  CHARACTERS.splice(0, CHARACTERS.length, ...normalizeCharacters(readManifest()));
  logger.info(`Character catalogue: ${CHARACTERS.length} character(s).`);
  return CHARACTERS;
}

export function characterById(id) {
  const text = String(id ?? '').trim().toLowerCase();
  return CHARACTERS.find((character) => character.id === text) ?? null;
}

export function characterItemKey(id) {
  return `${CHARACTER_ITEM_PREFIX}${String(id ?? '').trim().toLowerCase()}`;
}

/** Design ids this member owns, used for the Owned badge and the buy guard. */
export function ownedCharacterIds(guildId, userId) {
  const rows = getDb()
    .prepare(
      `SELECT item_key FROM store_purchases
        WHERE guild_id = ? AND user_id = ? AND status = 'fulfilled'
          AND item_key LIKE 'character:%'`,
    )
    .all(guildId, userId);

  const ids = new Set();

  for (const row of rows) {
    const id = String(row.item_key ?? '').slice(CHARACTER_ITEM_PREFIX.length);
    if (id) ids.add(id);
  }

  return ids;
}

/* ── Artwork ──────────────────────────────────────────────────────────────── */

export function characterArtFile(id) {
  const text = String(id ?? '').trim().toLowerCase();

  if (!ID_PATTERN.test(text)) return null;

  const file = path.join(ART_DIR, `${text}.jpg`);
  return existsSync(file) ? file : null;
}

export function characterArtUrl(id) {
  const file = characterArtFile(id);
  return file ? `/assets/characters/${path.basename(file)}` : null;
}

function cleanName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

function cleanPrice(value, fallback = 0) {
  const number = Math.trunc(Number(value));

  if (!Number.isFinite(number) || number < 0 || number > MAX_CHARACTER_PRICE) return fallback;

  return number;
}

function slugify(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 26);
}

function uniqueId(name) {
  const suffix = Math.random().toString(36).slice(2, 6);
  const base = `char-${slugify(name) || 'character'}-${suffix}`.slice(0, 40);
  let id = base;
  let counter = 2;

  while (characterById(id)) {
    id = `${base.slice(0, 37)}-${counter}`;
    counter += 1;
  }

  return id;
}

async function writeManifest(characters) {
  await mkdir(path.dirname(MANIFEST), { recursive: true });
  await writeFile(
    MANIFEST,
    `${JSON.stringify(
      {
        characters: characters.map(({ id, name, price }) => ({ id, name, price })),
      },
      null,
      2,
    )}\n`,
  );
}

function withEntry(entry) {
  const raw = readManifest();
  const characters = Array.isArray(raw.characters) ? [...raw.characters] : [];
  const index = characters.findIndex((item) => String(item?.id ?? '') === entry.id);

  if (index >= 0) characters[index] = entry;
  else characters.push(entry);

  return characters;
}

/**
 * Normalises an admin portrait to exactly 225x350 using a cover crop, so a
 * phone screenshot and a tall illustration both fill the card without being
 * stretched.
 */
export async function saveCharacterArt(id, input) {
  const text = String(id ?? '').trim().toLowerCase();

  if (!ID_PATTERN.test(text)) {
    throw new WallpaperError('That character id is not valid.', 'path');
  }

  let image;

  try {
    image = Buffer.isBuffer(input) ? await loadImage(input) : input;
  } catch {
    throw new WallpaperError('That file could not be read as an image.', 'decode');
  }

  if (!image?.width || !image?.height) {
    throw new WallpaperError('That file could not be read as an image.', 'decode');
  }

  if (
    image.width < MIN_SOURCE_SIDE ||
    image.height < MIN_SOURCE_SIDE ||
    image.width > MAX_SOURCE_SIDE ||
    image.height > MAX_SOURCE_SIDE
  ) {
    throw new WallpaperError(
      `The portrait must be between ${MIN_SOURCE_SIDE}x${MIN_SOURCE_SIDE} and ` +
        `${MAX_SOURCE_SIDE}x${MAX_SOURCE_SIDE} pixels.`,
      'dimensions',
    );
  }

  const canvas = createCanvas(CHARACTER_WIDTH, CHARACTER_HEIGHT);
  const ctx = canvas.getContext('2d');
  const scale = Math.max(CHARACTER_WIDTH / image.width, CHARACTER_HEIGHT / image.height);
  const width = image.width * scale;
  const height = image.height * scale;

  ctx.fillStyle = '#101218';
  ctx.fillRect(0, 0, CHARACTER_WIDTH, CHARACTER_HEIGHT);
  ctx.drawImage(
    image,
    (CHARACTER_WIDTH - width) / 2,
    (CHARACTER_HEIGHT - height) / 2,
    width,
    height,
  );

  const encoded = canvas.toBuffer('image/jpeg', CHARACTER_QUALITY);
  const file = path.join(ART_DIR, `${text}.jpg`);

  await mkdir(ART_DIR, { recursive: true });
  await writeFile(file, encoded);

  return {
    file,
    width: image.width,
    height: image.height,
    bytes: encoded.length,
  };
}

export async function deleteCharacterArt(id) {
  const text = String(id ?? '').trim().toLowerCase();
  await rm(path.join(ART_DIR, `${text}.jpg`), { force: true });
}

/* ── Admin edits ──────────────────────────────────────────────────────────── */

export async function createCharacter({ name, price = 100, image }) {
  const clean = cleanName(name);

  if (!clean) throw new WallpaperError('Give the character a name (1–40 characters).', 'name');
  if (!image) throw new WallpaperError('Attach a portrait for the character.', 'image');

  const id = uniqueId(clean);
  await saveCharacterArt(id, image);

  try {
    await writeManifest(withEntry({ id, name: clean, price: cleanPrice(price, 100) }));
    reloadCharacters();
  } catch (error) {
    await deleteCharacterArt(id).catch(() => null);
    throw error;
  }

  logger.info(`Character "${id}" added from the Activity`);
  return characterById(id);
}

export async function updateCharacter(id, { name, price, image }) {
  const text = String(id ?? '').trim().toLowerCase();
  const current = characterById(text);

  if (!current) throw new WallpaperError('That character no longer exists.', 'unknown');
  if (!ID_PATTERN.test(text)) throw new WallpaperError('That character cannot be edited.', 'path');

  const next = {
    id: text,
    name: current.name,
    price: current.price,
  };

  if (name !== undefined) {
    const clean = cleanName(name);
    if (!clean) throw new WallpaperError('Give the character a name (1–40 characters).', 'name');
    next.name = clean;
  }

  if (price !== undefined) next.price = cleanPrice(price, current.price);

  // Validate everything before touching the portrait, so a bad name cannot
  // leave new art behind while the catalogue keeps the old entry.
  if (image) await saveCharacterArt(text, image);

  await writeManifest(withEntry(next));
  reloadCharacters();

  logger.info(`Character "${text}" updated from the Activity`);
  return characterById(text);
}

export async function deleteCharacter(id) {
  const text = String(id ?? '').trim().toLowerCase();
  const current = characterById(text);

  if (!current) throw new WallpaperError('That character no longer exists.', 'unknown');
  if (!ID_PATTERN.test(text)) throw new WallpaperError('That character cannot be deleted.', 'path');

  const raw = readManifest();
  const characters = (Array.isArray(raw.characters) ? raw.characters : []).filter(
    (item) => String(item?.id ?? '') !== text,
  );

  await writeManifest(characters);
  await deleteCharacterArt(text);
  reloadCharacters();

  logger.info(`Character "${text}" deleted from the Activity`);
  return { id: text };
}

/* ── Buying ───────────────────────────────────────────────────────────────── */

/**
 * Charges for one character and records ownership. There is no delivery step:
 * the purchase row itself is the collection entry, so the purchase can commit
 * atomically with the balance change.
 */
export function buyCharacter({ guildId, userId, characterId }) {
  const character = characterById(characterId);

  if (!character) return { ok: false, reason: 'unknown' };

  if (ownedCharacterIds(guildId, userId).has(character.id)) {
    return { ok: false, reason: 'limit', character };
  }

  settleProfile(guildId, userId);

  const db = getDb();
  const now = Date.now();
  const price = character.price;
  const key = characterItemKey(character.id);

  db.exec('BEGIN');

  try {
    const row = db
      .prepare('SELECT coins FROM profiles WHERE guild_id = ? AND user_id = ?')
      .get(guildId, userId);
    const balance = Number(row?.coins) || 0;

    if (balance < price) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'funds', balance, price, character };
    }

    if (price > 0) {
      db.prepare(
        'UPDATE profiles SET coins = coins - ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
      ).run(price, now, guildId, userId);
    }

    const info = db
      .prepare(
        `INSERT INTO store_purchases
           (guild_id, user_id, item_key, price, status, detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'fulfilled', ?, ?, ?)`,
      )
      .run(
        guildId,
        userId,
        key,
        price,
        JSON.stringify({ characterId: character.id, characterName: character.name }),
        now,
        now,
      );

    if (price > 0) {
      recordCoinTransaction({
        guildId,
        userId,
        amount: -price,
        balanceAfter: balance - price,
        type: 'purchase',
        actorId: userId,
        detail: {
          purchaseId: Number(info.lastInsertRowid),
          itemKey: key,
          itemName: character.name,
          itemType: 'character',
          quantity: 1,
          unitPrice: price,
        },
      });
    }

    db.exec('COMMIT');

    logger.info(`Character: ${userId} bought ${character.id} for ${price} coins in ${guildId}`);

    return {
      ok: true,
      character,
      price,
      balance: balance - price,
      purchaseId: Number(info.lastInsertRowid),
    };
  } catch (error) {
    db.exec('ROLLBACK');
    logger.error(`Could not charge ${userId} for character ${character.id}`, error);
    return { ok: false, reason: 'database', character };
  }
}
