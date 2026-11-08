import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { config } from '../config.js';
import { normalizeForMatch } from '../lib/text.js';
import { POINTS_PER_XP, XP_PER_LEVEL } from './profile-store.js';

/**
 * Card backgrounds and the level ladder that unlocks them.
 *
 * The original artwork is a single full-card image, so a new tier is a colour
 * treatment applied to the same pixels: the panels, labels and XP track keep
 * their exact positions and only the palette changes. Higher tiers also make a
 * custom wallpaper available.
 *
 * A deployment can replace any generated treatment with real artwork by adding
 * `assets/profile/backgrounds/<id>.png` (same 1868x1200 layout). The renderer
 * prefers that file, so no code change is needed when the art arrives.
 */

/** Same canvas size as profile-card.js. */
export const CARD_WIDTH = 1868;
export const CARD_HEIGHT = 1200;

/** Level at which a member may upload their own wallpaper. */
export const CUSTOM_LEVEL = 50;

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

function tier(id, name, level, from, to, accent) {
  return Object.freeze({
    id,
    name,
    level,
    theme: Object.freeze({ from, to, accent }),
  });
}

/**
 * Level 1 is the untouched template. Every five levels adds one treatment, so
 * the ladder is 5, 10, 15 … 50.
 */
export const BACKGROUNDS = Object.freeze([
  Object.freeze({ id: 'default', name: 'Classic', level: 1, theme: null }),
  tier('tier-05', 'Ember', 5, '#ff7a1a', '#ffd166', '#ffb347'),
  tier('tier-10', 'Verdant', 10, '#1f9d55', '#a8e063', '#7ee787'),
  tier('tier-15', 'Tide', 15, '#1e6fff', '#38e8d0', '#62d9ff'),
  tier('tier-20', 'Amethyst', 20, '#8a3ffc', '#e879f9', '#c084fc'),
  tier('tier-25', 'Rose', 25, '#e11d48', '#ff8fab', '#ff7aa8'),
  tier('tier-30', 'Solar', 30, '#f59e0b', '#fff176', '#ffd166'),
  tier('tier-35', 'Frost', 35, '#38bdf8', '#e0f2fe', '#9fe8ff'),
  tier('tier-40', 'Void', 40, '#4c1d95', '#a78bfa', '#a78bfa'),
  tier('tier-45', 'Prismatic', 45, '#ff0080', '#00e5ff', '#f0abfc'),
  tier('tier-50', 'Celestial', 50, '#ffcc33', '#ffe9a8', '#ffe066'),
]);

export const DEFAULT_BACKGROUND = BACKGROUNDS[0];

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
