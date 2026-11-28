import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { config, rootDir } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { normalizeForMatch } from '../lib/text.js';
import { isGifBytes, normaliseAnimatedGif } from './wallpaper-gif.js';
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

const MIN_WALLPAPER_WIDTH = 64;
const MIN_WALLPAPER_HEIGHT = 64;
const MAX_WALLPAPER_SIDE = 6000;
const WALLPAPER_QUALITY = 90;
const WALLPAPER_EXTENSIONS = /\.(png|jpe?g|webp|gif)$/i;
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const BUNDLED_MANIFEST = path.join(rootDir, 'assets', 'profile', 'backgrounds', 'backgrounds.json');
const DATA_MANIFEST = path.join(config.dataDir, 'backgrounds.json');
const DATA_ART_DIR = path.join(config.dataDir, 'backgrounds');
const ART_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];

function defaultManifest() {
  return {
    customLevel: 50,
    autoEquip: true,
    backgrounds: [
      { id: 'default', name: 'كلاسيكي', level: 1 },
      {
        id: 'tier-05',
        name: 'جمر',
        level: 5,
        theme: { from: '#ff7a1a', to: '#ffd166', accent: '#ffb347' },
      },
      {
        id: 'tier-10',
        name: 'مروج',
        level: 10,
        theme: { from: '#1f9d55', to: '#a8e063', accent: '#7ee787' },
      },
      {
        id: 'tier-15',
        name: 'مدّ',
        level: 15,
        theme: { from: '#1e6fff', to: '#38e8d0', accent: '#62d9ff' },
      },
      {
        id: 'tier-20',
        name: 'جمشت',
        level: 20,
        theme: { from: '#8a3ffc', to: '#e879f9', accent: '#c084fc' },
      },
      {
        id: 'tier-25',
        name: 'ورد',
        level: 25,
        theme: { from: '#e11d48', to: '#ff8fab', accent: '#ff7aa8' },
      },
      {
        id: 'tier-30',
        name: 'شمسي',
        level: 30,
        theme: { from: '#f59e0b', to: '#fff176', accent: '#ffd166' },
      },
      {
        id: 'tier-35',
        name: 'صقيع',
        level: 35,
        theme: { from: '#38bdf8', to: '#e0f2fe', accent: '#9fe8ff' },
      },
      {
        id: 'tier-40',
        name: 'فراغ',
        level: 40,
        theme: { from: '#4c1d95', to: '#a78bfa', accent: '#a78bfa' },
      },
      {
        id: 'tier-45',
        name: 'طيف',
        level: 45,
        theme: { from: '#ff0080', to: '#00e5ff', accent: '#f0abfc' },
      },
      {
        id: 'tier-50',
        name: 'سماوي',
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

function manifestEntries(raw) {
  return Array.isArray(raw?.backgrounds) ? raw.backgrounds : [];
}

function builtInIdSet(raw) {
  return new Set(
    manifestEntries(raw)
      .map((entry) => String(entry?.id ?? '').trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * The bundled ladder is the base; `data/backgrounds.json` is an overlay. A data
 * entry with the same id merges over the bundled one (so an admin can rename a
 * design or replace its art), a new id is added, and `deleted: true` hides it.
 */
function mergeManifestRaw(bundled, overrides) {
  const byId = new Map();

  for (const entry of manifestEntries(bundled)) {
    const id = String(entry?.id ?? '').trim();
    if (id) byId.set(id, { ...entry });
  }

  for (const entry of manifestEntries(overrides)) {
    const id = String(entry?.id ?? '').trim();
    if (!id) continue;

    if (entry.deleted === true) {
      byId.delete(id);
      continue;
    }

    byId.set(id, { ...(byId.get(id) ?? {}), ...entry, id });
  }

  return {
    ...(bundled ?? {}),
    ...(overrides ?? {}),
    backgrounds: [...byId.values()],
  };
}

function normalizeManifest(raw, source, builtInIds = new Set()) {
  const entries = manifestEntries(raw);
  const backgrounds = [];
  const seen = new Set();

  for (const entry of entries) {
    if (entry?.deleted === true) continue;

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
      : price > 0
        ? false
        : entry?.auto === undefined
          ? true
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
        builtIn: builtInIds.has(id),
      }),
    );
    seen.add(id);
  }

  if (!seen.has('default')) {
    backgrounds.push(
      Object.freeze({
        id: 'default',
        name: 'كلاسيكي',
        level: 1,
        theme: null,
        price: 0,
        auto: false,
        artMode: 'template',
        builtIn: true,
      }),
    );
  }

  if (backgrounds.length === 1) {
    logger.warn('No usable backgrounds in the manifest; using the built-in ladder.');
    const fallback = defaultManifest();
    return normalizeManifest(fallback, 'built-in', builtInIdSet(fallback));
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

let builtInIds = new Set();

function loadManifest() {
  const bundled = readManifestFile(BUNDLED_MANIFEST);
  const overrides = readManifestFile(DATA_MANIFEST);

  let raw;
  let source;

  if (bundled || overrides) {
    raw = mergeManifestRaw(bundled, overrides);
    source = overrides
      ? `${path.basename(BUNDLED_MANIFEST)}+${path.basename(DATA_MANIFEST)}`
      : BUNDLED_MANIFEST;
  } else {
    raw = defaultManifest();
    source = 'built-in';
  }

  builtInIds = builtInIdSet(bundled ?? defaultManifest());

  const manifest = normalizeManifest(raw, source, builtInIds);
  logger.info(`Background ladder: ${manifest.backgrounds.length} designs (${manifest.source}).`);
  return manifest;
}

const initialManifest = loadManifest();

/**
 * Mutable on purpose: admin edits reload the merged manifest in place, so every
 * module that already imported the array sees the new designs without a restart.
 */
export const BACKGROUNDS = [...initialManifest.backgrounds];
export const DEFAULT_BACKGROUND =
  BACKGROUNDS.find((background) => background.id === 'default') ?? BACKGROUNDS[0];

/** Level at which a member may upload their own wallpaper. */
export const CUSTOM_LEVEL = initialManifest.customLevel;

/** Whether the newest unlocked free design equips itself. */
export const AUTO_EQUIP = initialManifest.autoEquip;

/** Where the loaded ladder came from. Useful in a boot or debug log. */
export const BACKGROUND_SOURCE = initialManifest.source;

/** Re-reads the bundled + data manifests and updates the live ladder in place. */
export function reloadBackgrounds() {
  const next = loadManifest();
  BACKGROUNDS.splice(0, BACKGROUNDS.length, ...next.backgrounds);
  return BACKGROUNDS;
}

/** The overlay file that admin edits write. */
export function backgroundOverridesPath() {
  return DATA_MANIFEST;
}

export function readBackgroundOverrides() {
  return readManifestFile(DATA_MANIFEST) ?? { backgrounds: [] };
}

export async function writeBackgroundOverrides(raw) {
  await mkdir(path.dirname(DATA_MANIFEST), { recursive: true });
  await writeFile(DATA_MANIFEST, `${JSON.stringify(raw, null, 2)}\n`);
}

/** True when the design ships with the bot (so deleting it is an override). */
export function isBuiltInBackground(id) {
  return builtInIds.has(String(id ?? '').trim().toLowerCase());
}

export function isValidBackgroundId(id) {
  const text = String(id ?? '').trim().toLowerCase();

  return ID_PATTERN.test(text) && text !== CUSTOM_ID;
}

/** Raw points needed to reach a level: 100 XP per level, 5 points per XP. */
export function pointsForLevel(level) {
  return Math.max(0, Number(level) - 1) * XP_PER_LEVEL * POINTS_PER_XP;
}

export function backgroundById(id) {
  return BACKGROUNDS.find((background) => background.id === id) ?? null;
}

export function isBackgroundUnlocked(background, level, owned = null) {
  if (!background) return false;

  const owns = owned?.has?.(background.id) ?? (Array.isArray(owned) && owned.includes(background.id));
  if (owns) return true;

  // A paid design is unlocked by buying it, never by level alone.
  if (Number(background.price) > 0) return false;

  return background.level <= Math.max(1, Number(level) || 1);
}

export function unlockedBackgrounds(level, owned = null) {
  return BACKGROUNDS.filter((background) => isBackgroundUnlocked(background, level, owned));
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
 * something they no longer earn. A design bought from the store stays
 * available at any level. An uploaded wallpaper stays available once it
 * exists, so a temporary point correction does not delete it.
 */
export function resolveBackground({
  selected = null,
  level = 1,
  hasCustom = false,
  customPath = null,
  customGifPath = null,
  owned = null,
} = {}) {
  if (selected === CUSTOM_ID && hasCustom && customPath) {
    return {
      kind: 'custom',
      id: CUSTOM_ID,
      name: 'خلفية مخصصة',
      level: CUSTOM_LEVEL,
      theme: null,
      path: customPath,
      gifPath: customGifPath || null,
    };
  }

  const background = backgroundById(selected);

  if (isBackgroundUnlocked(background, level, owned)) {
    return {
      kind: background.theme ? 'tier' : 'default',
      ...background,
    };
  }

  return { kind: 'default', ...DEFAULT_BACKGROUND };
}

/* ── Artwork and admin edits ──────────────────────────────────────────────── */

/** Finds a design's art: admin uploads in `data/` first, bundled art second. */
export function backgroundArtFile(id) {
  const text = String(id ?? '').trim().toLowerCase();

  if (!ID_PATTERN.test(text)) return null;

  const dirs = [DATA_ART_DIR, path.join(rootDir, 'assets', 'profile', 'backgrounds')];

  for (const dir of dirs) {
    for (const extension of ART_EXTENSIONS) {
      const file = path.join(dir, `${text}.${extension}`);

      if (existsSync(file)) return { file, extension };
    }
  }

  return null;
}

/** A 480 px card thumbnail for the store, so 60 cards do not load full art. */
function backgroundThumbFile(id) {
  const text = String(id ?? '').trim().toLowerCase();

  if (!ID_PATTERN.test(text)) return null;

  for (const dir of [DATA_ART_DIR, path.join(rootDir, 'assets', 'profile', 'backgrounds')]) {
    const file = path.join(dir, `${text}-thumb.jpg`);

    if (existsSync(file)) return file;
  }

  return null;
}

export function backgroundArtUrl(id) {
  const thumb = backgroundThumbFile(id);

  if (thumb) return `/assets/backgrounds/${path.basename(thumb)}`;

  const art = backgroundArtFile(id);

  return art ? `/assets/backgrounds/${path.basename(art.file)}` : null;
}

const clampChannel = (value) => Math.max(0, Math.min(255, Math.round(value)));
const channelHex = (value) => clampChannel(value).toString(16).padStart(2, '0');
const colorHex = (r, g, b) => `#${channelHex(r)}${channelHex(g)}${channelHex(b)}`;

function rgbToHsl(r, g, b) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  let hue = 0;
  let saturation = 0;

  if (max !== min) {
    const delta = max - min;
    saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);

    if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0);
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;

    hue /= 6;
  }

  return [hue, saturation, lightness];
}

function hslToRgb(h, s, l) {
  const hue = (p, q, t) => {
    let value = t;
    if (value < 0) value += 1;
    if (value > 1) value -= 1;
    if (value < 1 / 6) return p + (q - p) * 6 * value;
    if (value < 1 / 2) return q;
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
    return p;
  };

  if (s === 0) return [l * 255, l * 255, l * 255];

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;

  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

/**
 * Picks a dark, a light and a vivid colour from a picture. Used for designs
 * added from the Activity, so they get a working fallback theme and XP accent
 * without the admin having to understand hex colours.
 */
export function themeFromImage(image) {
  const width = 48;
  const height = Math.max(1, Math.round((image.height / image.width) * width));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  const pixels = [];

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    pixels.push({
      r,
      g,
      b,
      luminance: 0.2126 * r + 0.7152 * g + 0.0722 * b,
      saturation: Math.max(r, g, b) - Math.min(r, g, b),
    });
  }

  if (pixels.length === 0) return normalizeTheme({ from: '#1e6fff', to: '#38e8d0' });

  const average = (list) => {
    const total = list.reduce((acc, p) => [acc[0] + p.r, acc[1] + p.g, acc[2] + p.b], [0, 0, 0]);
    return total.map((value) => value / Math.max(1, list.length));
  };

  const byLight = [...pixels].sort((a, b) => a.luminance - b.luminance);
  const dark = average(byLight.slice(0, Math.max(1, Math.floor(byLight.length * 0.3))));
  const bright = average(byLight.slice(-Math.max(1, Math.floor(byLight.length * 0.22))));
  const vivid = average(
    [...pixels]
      .sort((a, b) => b.saturation - a.saturation)
      .slice(0, Math.max(1, Math.floor(pixels.length * 0.08))),
  );

  const [dh, ds, dl] = rgbToHsl(...dark);
  const from = hslToRgb(dh, Math.min(1, ds * 1.15 + 0.05), Math.max(0.16, Math.min(0.34, dl * 0.8)));

  const [bh, bs, bl] = rgbToHsl(...bright);
  const to = hslToRgb(bh, Math.min(1, bs * 1.2 + 0.05), Math.min(0.88, Math.max(0.6, bl)));

  const [vh, vs, vl] = rgbToHsl(...vivid);
  const accent = hslToRgb(
    vh,
    Math.min(1, Math.max(0.4, vs * 1.3 + 0.08)),
    Math.max(0.42, Math.min(0.62, vl)),
  );

  return normalizeTheme({
    from: colorHex(...from),
    to: colorHex(...to),
    accent: colorHex(...accent),
  });
}

/**
 * Normalises an admin upload to the card size and writes it under `data/`.
 * A replacement always wins over bundled art because `backgroundArtFile`
 * checks `data/` first.
 */
export async function saveBackgroundArt(id, input) {
  const text = String(id ?? '').trim().toLowerCase();

  if (!isValidBackgroundId(text)) {
    throw new WallpaperError('آيدي الخلفية مو صحيح.', 'path');
  }

  let image;

  try {
    image = Buffer.isBuffer(input) ? await loadImage(input) : input;
  } catch {
    throw new WallpaperError('ما قدرنا نقرأ الملف كصورة.', 'decode');
  }

  if (!image?.width || !image?.height) {
    throw new WallpaperError('ما قدرنا نقرأ الملف كصورة.', 'decode');
  }

  if (
    image.width < MIN_WALLPAPER_WIDTH ||
    image.height < MIN_WALLPAPER_HEIGHT ||
    image.width > MAX_WALLPAPER_SIDE ||
    image.height > MAX_WALLPAPER_SIDE
  ) {
    throw new WallpaperError(
      `لازم تكون الصورة بين ${MIN_WALLPAPER_WIDTH}x${MIN_WALLPAPER_HEIGHT} و ` +
        `${MAX_WALLPAPER_SIDE}x${MAX_WALLPAPER_SIDE} بكسل.`,
      'dimensions',
    );
  }

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
  const file = path.join(DATA_ART_DIR, `${text}.jpg`);
  const thumbFile = path.join(DATA_ART_DIR, `${text}-thumb.jpg`);

  await mkdir(DATA_ART_DIR, { recursive: true });
  await writeFile(file, encoded);

  const thumb = createCanvas(480, 270);
  const thumbCtx = thumb.getContext('2d');
  const thumbScale = Math.max(480 / CARD_WIDTH, 270 / CARD_HEIGHT);
  const thumbWidth = CARD_WIDTH * thumbScale;
  const thumbHeight = CARD_HEIGHT * thumbScale;

  thumbCtx.drawImage(
    canvas,
    (480 - thumbWidth) / 2,
    (270 - thumbHeight) / 2,
    thumbWidth,
    thumbHeight,
  );
  await writeFile(thumbFile, thumb.toBuffer('image/jpeg', 78));

  // Keep one file per id, whichever extension the previous upload used.
  for (const extension of ART_EXTENSIONS) {
    if (extension === 'jpg') continue;
    await rm(path.join(DATA_ART_DIR, `${text}.${extension}`), { force: true });
  }

  return {
    file,
    thumb: thumbFile,
    width: image.width,
    height: image.height,
    bytes: encoded.length,
    theme: themeFromImage(image),
  };
}

export async function deleteBackgroundArt(id) {
  const text = String(id ?? '').trim().toLowerCase();

  for (const extension of ART_EXTENSIONS) {
    await rm(path.join(DATA_ART_DIR, `${text}.${extension}`), { force: true });
  }

  await rm(path.join(DATA_ART_DIR, `${text}-thumb.jpg`), { force: true });
}

/* ── Custom wallpapers ────────────────────────────────────────────────────── */

function safeSegment(value) {
  const text = String(value ?? '');

  if (!/^[0-9A-Za-z_-]+$/.test(text)) {
    throw new WallpaperError('آيدي العضو أو السيرفر ما يصلح لمسار الخلفية.', 'path');
  }

  return text;
}

/**
 * One file per member per guild, inside `data/` so a zip deployment keeps it.
 * The path is deterministic, which means the database only stores the `custom`
 * marker and a missing file can be detected without a second table.
 *
 * A GIF upload also writes a sibling `.gif` (see `customWallpaperGifPath`); the
 * JPEG is always the first frame and stays the fallback if the animation cannot
 * be read at render time.
 */
export function customWallpaperPath(guildId, userId) {
  return path.join(
    config.dataDir,
    'profile-backgrounds',
    safeSegment(guildId),
    `${safeSegment(userId)}.jpg`,
  );
}

/** The normalised animated copy of a GIF wallpaper, or a path that may not exist. */
export function customWallpaperGifPath(guildId, userId) {
  return path.join(
    config.dataDir,
    'profile-backgrounds',
    safeSegment(guildId),
    `${safeSegment(userId)}.gif`,
  );
}

export function hasCustomWallpaper(guildId, userId) {
  try {
    return existsSync(customWallpaperPath(guildId, userId));
  } catch {
    return false;
  }
}

export function hasAnimatedWallpaper(guildId, userId) {
  try {
    return existsSync(customWallpaperGifPath(guildId, userId));
  } catch {
    return false;
  }
}

export async function deleteCustomWallpaper(guildId, userId) {
  await Promise.all([
    rm(customWallpaperPath(guildId, userId), { force: true }),
    rm(customWallpaperGifPath(guildId, userId), { force: true }),
  ]);
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
 *
 * A GIF is also decoded and re-encoded as an animated wallpaper at its own
 * resolution (never upscaled, capped at 1280 px), so the card can loop it. That
 * file is a sibling `.gif`; the JPEG stays as the first frame and as the
 * fallback when animation is off or unreadable.
 */
export async function saveCustomWallpaper(
  guildId,
  userId,
  attachment,
  { fetchImpl = globalThis.fetch } = {},
) {
  if (!attachment?.url) {
    throw new WallpaperError('أرفق الصورة مع الأمر أو ارفعها بنفس الرسالة.', 'missing');
  }

  if (Number(attachment.size) > MAX_WALLPAPER_BYTES) {
    throw new WallpaperError(
      `الصورة كبيرة. الحد ${Math.round(MAX_WALLPAPER_BYTES / (1024 * 1024))} ميجابايت.`,
      'too-large',
    );
  }

  const type = contentTypeOf(attachment);

  if (!looksLikeImage(attachment, type)) {
    throw new WallpaperError('الخلفيات تقبل PNG أو JPEG أو WebP أو GIF بس.', 'type');
  }

  if (typeof fetchImpl !== 'function') {
    throw new WallpaperError('البوت ما يقدر ينزّل المرفقات الحين.', 'download');
  }

  let response;

  try {
    response = await fetchImpl(attachment.url, { signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new WallpaperError('ديسكورد ما رجّع الصورة في الوقت. جرّب مرة ثانية.', 'download');
  }

  if (!response.ok) {
    throw new WallpaperError('ديسكورد ما رجّع الصورة. ارفعها مرة ثانية.', 'download');
  }

  const bytes = Buffer.from(await response.arrayBuffer());

  if (bytes.length > MAX_WALLPAPER_BYTES) {
    throw new WallpaperError(
      `الصورة كبيرة. الحد ${Math.round(MAX_WALLPAPER_BYTES / (1024 * 1024))} ميجابايت.`,
      'too-large',
    );
  }

  let image;

  try {
    image = await loadImage(bytes);
  } catch {
    throw new WallpaperError('ما قدرنا نقرأ الملف كصورة.', 'decode');
  }

  if (
    image.width < MIN_WALLPAPER_WIDTH ||
    image.height < MIN_WALLPAPER_HEIGHT ||
    image.width > MAX_WALLPAPER_SIDE ||
    image.height > MAX_WALLPAPER_SIDE
  ) {
    throw new WallpaperError(
      `لازم تكون الصورة بين ${MIN_WALLPAPER_WIDTH}x${MIN_WALLPAPER_HEIGHT} و ` +
        `${MAX_WALLPAPER_SIDE}x${MAX_WALLPAPER_SIDE} بكسل.`,
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
  const gifFile = customWallpaperGifPath(guildId, userId);

  // GIFs arrive with their own timing and frame count. Normalising once, at
  // upload, keeps the render path cheap and stops a huge upload from being
  // decoded on every /profile.
  const wasGif = isGifBytes(bytes);
  let animation = null;

  if (wasGif) {
    try {
      animation = await normaliseAnimatedGif(bytes);
    } catch (error) {
      logger.warn(`Could not prepare the animated wallpaper for ${userId}: ${error.message}`);
    }
  }

  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, encoded);

  if (animation) await writeFile(gifFile, animation.buffer);
  else await rm(gifFile, { force: true });

  return {
    path: file,
    bytes: encoded.length,
    sourceWidth: image.width,
    sourceHeight: image.height,
    animated: Boolean(animation),
    wasGif,
    frames: animation?.frames ?? 1,
    animationBytes: animation?.buffer.length ?? 0,
    animationWidth: animation?.width ?? 0,
    animationHeight: animation?.height ?? 0,
    animationDuration: animation?.duration ?? 0,
    sourceDuration: animation?.sourceDuration ?? 0,
    trimmed: Boolean(animation?.trimmed),
  };
}
