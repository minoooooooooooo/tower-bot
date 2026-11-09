import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { config, rootDir } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { normalizeForMatch } from '../lib/text.js';
import {
  POINTS_PER_XP,
  XP_PER_LEVEL,
  getProfile,
  setProfileBackground,
} from './profile-store.js';

const logger = createLogger('backgrounds');

/**
 * Card backgrounds and the level ladder that unlocks them.
 *
 * The ladder is data, not code: `assets/profile/backgrounds/backgrounds.json`
 * ships with the bot, and `data/backgrounds.json` (if present) overrides it.
 * Change a `level`, add a design, mark one `auto: false`, or give it a `price`
 * without touching JavaScript.
 *
 * A free design (`price: 0`, `auto: true`) equips itself when a member reaches
 * its level. The member can still switch to any unlocked design, but the next
 * unlocked free design replaces a lower one automatically. A paid design
 * (`price > 0`) never auto-equips; it is part of the collection to purchase.
 *
 * Artwork is optional. Without a file a tier is a colour treatment applied to
 * `card.png`, so the panels, labels and XP track keep their exact positions.
 * With `assets/profile/backgrounds/<id>.png` the renderer prefers the file:
 * `artMode: "template"` means the file is a complete 1868x1200 card, while
 * `artMode: "wallpaper"` means a raw background and the bot draws the glass
 * panels itself.
 */

/** Same canvas size as profile-card.js. */
export const CARD_WIDTH = 1868;
export const CARD_HEIGHT = 1200;

/** Stored in `profiles.background` for a custom wallpaper. */
export const CUSTOM_ID = 'custom';

/** Discord's normal upload limit; larger files are refused before download. */
export const MAX_WALLPAPER_BYTES = 10 * 1024 * 1024;

const MIN_WALLPAPER_WIDTH = 400;
const MIN_WALLPAPER_HEIGHT = 300;
const MAX_WALLPAPER_SIDE = 12_000;
const WALLPAPER_QUALITY = 90;
const WALLPAPER_EXTENSIONS = /\.(png|jpe?g|webp|gif)$/i;
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function defaultManifest() {
  return {
    customLevel: 50,
    autoEquip: true,
    backgrounds: [
      { id: 'default', name: 'Classic', level: 1 },
      {
        id: 'tier-05',
        name: 'Ember',
        level: 5,
        theme: { from: '#ff7a1a', to: '#ffd166', accent: '#ffb347' },
      },
      {
        id: 'tier-10',
        name: 'Verdant',
        level: 10,
        theme: { from: '#1f9d55', to: '#a8e063', accent: '#7ee787' },
      },
      {
        id: 'tier-15',
        name: 'Tide',
        level: 15,
        theme: { from: '#1e6fff', to: '#38e8d0', accent: '#62d9ff' },
      },
      {
        id: 'tier-20',
        name: 'Amethyst',
        level: 20,
        theme: { from: '#8a3ffc', to: '#e879f9', accent: '#c084fc' },
      },
      {
        id: 'tier-25',
        name: 'Rose',
        level: 25,
        theme: { from: '#e11d48', to: '#ff8fab', accent: '#ff7aa8' },
      },
      {
        id: 'tier-30',
        name: 'Solar',
        level: 30,
        theme: { from: '#f59e0b', to: '#fff176', accent: '#ffd166' },
      },
      {
        id: 'tier-35',
        name: 'Frost',
        level: 35,
        theme: { from: '#38bdf8', to: '#e0f2fe', accent: '#9fe8ff' },
      },
      {
        id: 'tier-40',
        name: 'Void',
        level: 40,
        theme: { from: '#4c1d95', to: '#a78bfa', accent: '#a78bfa' },
      },
      {
        id: 'tier-45',
        name: 'Prismatic',
        level: 45,
        theme: { from: '#ff0080', to: '#00e5ff', accent: '#f0abfc' },
      },
      {
        id: 'tier-50',
        name: 'Celestial',
        level: 50,
        theme: { from: '#ffcc33', to: '#ffe9a8', accent: '#ffe066' },
      },
    ],
  };
}

function envInteger(name) {
  const value = Number.parseInt(String(process.env[name] ?? '').trim(), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function envFlag(name, fallback) {
  const value = String(process.env[name] ?? '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(value)) return false;
  if (['1', 'true', 'on', 'yes'].includes(value)) return true;
  return fallback;
}

function normalizeTheme(theme) {
  if (!theme || typeof theme !== 'object') return null;

  const color = (value) =>
    typeof value === 'string' && HEX_COLOR.test(value.trim()) ? value.trim() : null;
  const from = color(theme.from);
  const to = color(theme.to);

  if (!from || !to) return null;

  return Object.freeze({ from, to, accent: color(theme.accent) ?? to });
}

function readManifestFile(file) {
  if (!file || !existsSync(file)) return null;

  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    logger.warn(`Could not read ${path.basename(file)}: ${error.message}`);
    return null;
  }
}

function normalizeManifest(raw, source) {
  const entries = Array.isArray(raw?.backgrounds) ? raw.backgrounds : [];
  const backgrounds = [];
  const seen = new Set();

  for (const entry of entries) {
    const id = String(entry?.id ?? '').trim().toLowerCase();
    const name = String(entry?.name ?? '').trim();
    const level = Math.trunc(Number(entry?.level));

    if (
      !ID_PATTERN.test(id) ||
      !name ||
      !Number.isInteger(level) ||
      level < 1 ||
      level > 999
    ) {
      logger.warn(`Skipping an invalid background entry in ${path.basename(source)}.`);
      continue;
    }

    if (seen.has(id)) {
      logger.warn(`Skipping duplicate background id "${id}" in ${path.basename(source)}.`);
      continue;
    }

    const price = Math.max(0, Math.trunc(Number(entry?.price) || 0));
    const isDefault = id === 'default';
    const theme = isDefault ? null : normalizeTheme(entry?.theme);

    if (!isDefault && !theme) {
      logger.warn(`Background "${id}" needs a theme with valid hex from/to colors.`);
      continue;
    }

    // A free design auto-equips unless it opts out; a paid design never does.
    const auto = isDefault
      ? false
      : entry?.auto === undefined
        ? price === 0
        : Boolean(entry.auto);

    backgrounds.push(
      Object.freeze({
        id,
        name: name.slice(0, 40),
        level,
        theme,
        price,
        auto,
        artMode: entry?.artMode === 'wallpaper' ? 'wallpaper' : 'template',
      }),
    );
    seen.add(id);
  }

  if (!seen.has('default')) {
    backgrounds.push(
      Object.freeze({
        id: 'default',
        name: 'Classic',
        level: 1,
        theme: null,
        price: 0,
        auto: false,
        artMode: 'template',
      }),
    );
  }

  if (backgrounds.length === 1) {
    logger.warn('No usable backgrounds in the manifest; using the built-in ladder.');
    return normalizeManifest(defaultManifest(), 'built-in');
  }

  backgrounds.sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));

  const configuredLevel = Math.trunc(Number(raw?.customLevel));
  const customLevel = envInteger('BACKGROUND_CUSTOM_LEVEL') ?? configuredLevel ?? 50;
  const autoEquip = envFlag(
    'BACKGROUND_AUTO_EQUIP',
    raw?.autoEquip === undefined ? true : Boolean(raw.autoEquip),
  );

  return {
    backgrounds: Object.freeze(backgrounds),
    customLevel: Number.isInteger(customLevel) && customLevel > 0 ? customLevel : 50,
    autoEquip,
    source,
  };
}

function loadManifest() {
  const override = path.join(config.dataDir, 'backgrounds.json');
  const bundled = path.join(rootDir, 'assets', 'profile', 'backgrounds', 'backgrounds.json');
  let source = override;
  let raw = readManifestFile(override);

  if (!raw) {
    source = bundled;
    raw = readManifestFile(bundled);
  }

  if (!raw) {
    source = 'built-in';
    raw = defaultManifest();
  }

  const manifest = normalizeManifest(raw, source);
  logger.info(`Background ladder: ${manifest.backgrounds.length} designs (${manifest.source}).`);
  return manifest;
}

const manifest = loadManifest();

export const BACKGROUNDS = manifest.backgrounds;
export const DEFAULT_BACKGROUND =
  BACKGROUNDS.find((background) => background.id === 'default') ?? BACKGROUNDS[0];

/** Level at which a member may upload their own wallpaper. */
export const CUSTOM_LEVEL = manifest.customLevel;

/** Whether the newest unlocked free design equips itself. */
export const AUTO_EQUIP = manifest.autoEquip;

/** Where the loaded ladder came from. Useful in a boot or debug log. */
export const BACKGROUND_SOURCE = manifest.source;

/** Raw points needed to reach a level: 100 XP per level, 5 points per XP. */
export function pointsForLevel(level) {
  return Math.max(0, Number(level) - 1) * XP_PER_LEVEL * POINTS_PER_XP;
}

export function backgroundById(id) {
  return BACKGROUNDS.find((background) => background.id === id) ?? null;
}

export function isBackgroundUnlocked(background, level) {
  return Boolean(background) && background.level <= Math.max(1, Number(level) || 1);
}

export function unlockedBackgrounds(level) {
  return BACKGROUNDS.filter((background) => isBackgroundUnlocked(background, level));
}

/** The cheapest design that is still locked, or null when everything is open. */
export function nextBackground(level) {
  return BACKGROUNDS.find((background) => background.level > Math.max(1, Number(level) || 1)) ?? null;
}

/**
 * Accepts the forms a member is likely to type: `15`, `level 15`, `tier-15`,
 * or `tide`. Returns null for anything else, so the command can list the
 * options instead of guessing.
 */
export function findBackground(query) {
  const raw = normalizeForMatch(query).replace(/^#/, '');
  if (!raw) return null;

  const numeric = /^(?:(?:level|lvl)\s*)?(\d{1,3})$/.exec(raw);

  if (numeric) {
    const level = Number(numeric[1]);
    return BACKGROUNDS.find((background) => background.level === level) ?? null;
  }

  return (
    BACKGROUNDS.find(
      (background) =>
        normalizeForMatch(background.id) === raw || normalizeForMatch(background.name) === raw,
    ) ?? null
  );
}

/** The highest-level free design the member has reached, or null below level 1. */
export function bestAutoBackground(level) {
  const current = Math.max(1, Number(level) || 1);
  let best = null;

  for (const background of BACKGROUNDS) {
    if (background.id === DEFAULT_BACKGROUND.id) continue;
    if (!background.auto || background.price > 0) continue;
    if (background.level > current) continue;
    if (!best || background.level > best.level) best = background;
  }

  return best;
}

/**
 * The selection a member should have after reaching `level`.
 *
 * Rules:
 * - an explicit Classic (`default`) is respected forever;
 * - a paid or `auto: false` design is never replaced automatically;
 * - an uploaded custom wallpaper is kept while the file exists;
 * - a locked pick is preserved (the card falls back to Classic) until the
 *   member levels back into it;
 * - otherwise the newest unlocked free design wins.
 */
export function autoBackgroundFor(selected, level, { hasCustom = false } = {}) {
  if (!AUTO_EQUIP) return selected ?? null;

  if (selected === CUSTOM_ID && hasCustom) return CUSTOM_ID;

  const current = backgroundById(selected);

  if (current?.id === DEFAULT_BACKGROUND.id) return current.id;
  if (current && (current.auto === false || current.price > 0)) return current.id;

  const best = bestAutoBackground(level);

  if (!best) return selected ?? null;
  if (!current) return best.id;
  if (!isBackgroundUnlocked(current, level)) return selected;
  if (current.level >= best.level) return selected;

  return best.id;
}

/**
 * Applies the automatic selection and persists it. This runs when the card or
 * `/background` is viewed, so points from any source (staff edits, exiles,
 * linked bots) all produce the same result without a hook in every writer.
 */
export function syncAutoBackground(guildId, userId, level, { hasCustom = false } = {}) {
  const stored = getProfile(guildId, userId).background;
  const next = autoBackgroundFor(stored, level, { hasCustom });

  if (next !== stored) setProfileBackground(guildId, userId, next);

  return next;
}

/**
 * Turns the stored preference into something the renderer understands. A design
 * the member has since fallen below falls back to Classic rather than showing
 * something they no longer earn. An uploaded wallpaper stays available once it
 * exists, so a temporary point correction does not delete it.
 */
export function resolveBackground({
  selected = null,
  level = 1,
  hasCustom = false,
  customPath = null,
} = {}) {
  if (selected === CUSTOM_ID && hasCustom && customPath) {
    return {
      kind: 'custom',
      id: CUSTOM_ID,
      name: 'Custom wallpaper',
      level: CUSTOM_LEVEL,
      theme: null,
      path: customPath,
    };
  }

  const background = backgroundById(selected);

  if (isBackgroundUnlocked(background, level)) {
    return {
      kind: background.theme ? 'tier' : 'default',
      ...background,
    };
  }

  return { kind: 'default', ...DEFAULT_BACKGROUND };
}

/* ── Custom wallpapers ────────────────────────────────────────────────────── */

function safeSegment(value) {
  const text = String(value ?? '');

  if (!/^[0-9A-Za-z_-]+$/.test(text)) {
    throw new WallpaperError('That member or server id cannot be used for a wallpaper path.', 'path');
  }

  return text;
}

/**
 * One file per member per guild, inside `data/` so a zip deployment keeps it.
 * The path is deterministic, which means the database only stores the `custom`
 * marker and a missing file can be detected without a second table.
 */
export function customWallpaperPath(guildId, userId) {
  return path.join(
    config.dataDir,
    'profile-backgrounds',
    safeSegment(guildId),
    `${safeSegment(userId)}.jpg`,
  );
}

export function hasCustomWallpaper(guildId, userId) {
  try {
    return existsSync(customWallpaperPath(guildId, userId));
  } catch {
    return false;
  }
}

export async function deleteCustomWallpaper(guildId, userId) {
  await rm(customWallpaperPath(guildId, userId), { force: true });
}

export class WallpaperError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.name = 'WallpaperError';
    this.code = code;
  }
}

function contentTypeOf(attachment) {
  return String(attachment?.contentType ?? '').split(';')[0].trim().toLowerCase();
}

function looksLikeImage(attachment, type) {
  if (ALLOWED_TYPES.has(type)) return true;
  if (type) return false;
  return WALLPAPER_EXTENSIONS.test(String(attachment?.name ?? ''));
}

/**
 * Downloads an uploaded image, checks it, and stores a normalised 1868x1200
 * JPEG. Re-encoding is deliberate: it strips metadata, bounds the file size and
 * guarantees the renderer always receives the exact dimensions it expects.
 */
export async function saveCustomWallpaper(
  guildId,
  userId,
  attachment,
  { fetchImpl = globalThis.fetch } = {},
) {
  if (!attachment?.url) {
    throw new WallpaperError('Attach an image to the command, or upload one in the same message.', 'missing');
  }

  if (Number(attachment.size) > MAX_WALLPAPER_BYTES) {
    throw new WallpaperError(
      `That image is too large. The limit is ${Math.round(MAX_WALLPAPER_BYTES / (1024 * 1024))} MB.`,
      'too-large',
    );
  }

  const type = contentTypeOf(attachment);

  if (!looksLikeImage(attachment, type)) {
    throw new WallpaperError('Only PNG, JPEG, WebP or GIF images can be used as a wallpaper.', 'type');
  }

  if (typeof fetchImpl !== 'function') {
    throw new WallpaperError('This bot cannot download attachments right now.', 'download');
  }

  let response;

  try {
    response = await fetchImpl(attachment.url, { signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new WallpaperError('Discord did not return the image in time. Try again.', 'download');
  }

  if (!response.ok) {
    throw new WallpaperError('Discord did not return the image. Try uploading it again.', 'download');
  }

  const bytes = Buffer.from(await response.arrayBuffer());

  if (bytes.length > MAX_WALLPAPER_BYTES) {
    throw new WallpaperError(
      `That image is too large. The limit is ${Math.round(MAX_WALLPAPER_BYTES / (1024 * 1024))} MB.`,
      'too-large',
    );
  }

  let image;

  try {
    image = await loadImage(bytes);
  } catch {
    throw new WallpaperError('That file could not be read as an image.', 'decode');
  }

  if (
    image.width < MIN_WALLPAPER_WIDTH ||
    image.height < MIN_WALLPAPER_HEIGHT ||
    image.width > MAX_WALLPAPER_SIDE ||
    image.height > MAX_WALLPAPER_SIDE
  ) {
    throw new WallpaperError(
      `The image must be between ${MIN_WALLPAPER_WIDTH}x${MIN_WALLPAPER_HEIGHT} and ` +
        `${MAX_WALLPAPER_SIDE}x${MAX_WALLPAPER_SIDE} pixels.`,
      'dimensions',
    );
  }

  // Cover-crop without distorting the picture, then flatten onto a dark canvas
  // so a transparent PNG does not turn black in the JPEG encoder.
  const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
  const ctx = canvas.getContext('2d');
  const scale = Math.max(CARD_WIDTH / image.width, CARD_HEIGHT / image.height);
  const width = image.width * scale;
  const height = image.height * scale;

  ctx.fillStyle = '#101218';
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  ctx.drawImage(
    image,
    (CARD_WIDTH - width) / 2,
    (CARD_HEIGHT - height) / 2,
    width,
    height,
  );

  const encoded = canvas.toBuffer('image/jpeg', WALLPAPER_QUALITY);
  const file = customWallpaperPath(guildId, userId);

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, encoded);

  return {
    path: file,
    bytes: encoded.length,
    sourceWidth: image.width,
    sourceHeight: image.height,
  };
}
