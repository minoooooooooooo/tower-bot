import { createLogger } from '../lib/logger.js';
import {
  WallpaperError,
  backgroundById,
  deleteBackgroundArt,
  isBuiltInBackground,
  isValidBackgroundId,
  readBackgroundOverrides,
  reloadBackgrounds,
  saveBackgroundArt,
  writeBackgroundOverrides,
} from './profile-backgrounds.js';

const logger = createLogger('background-admin');

const MAX_NAME = 40;
const MAX_PRICE = 100_000;
const MAX_LEVEL = 999;

function cleanName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

function cleanPrice(value, fallback) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number) || number < 0 || number > MAX_PRICE) return fallback;
  return number;
}

function cleanLevel(value, fallback) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number) || number < 1 || number > MAX_LEVEL) return fallback;
  return number;
}

function slugify(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

function uniqueId(name) {
  const base = `bg-${slugify(name) || Date.now().toString(36)}`.slice(0, 36);
  let id = base;
  let suffix = 2;

  while (backgroundById(id) || isBuiltInBackground(id) || !isValidBackgroundId(id)) {
    id = `${base.slice(0, 34)}-${suffix}`;
    suffix += 1;
  }

  return id;
}

function overridesWithEntry(id, entry) {
  const raw = readBackgroundOverrides();
  const backgrounds = Array.isArray(raw.backgrounds) ? [...raw.backgrounds] : [];
  const index = backgrounds.findIndex((item) => String(item?.id ?? '') === id);

  if (index >= 0) backgrounds[index] = entry;
  else backgrounds.push(entry);

  return { ...raw, backgrounds };
}

function plainTheme(theme) {
  return theme ? { from: theme.from, to: theme.to, accent: theme.accent } : null;
}

/**
 * Adds one design to the data overlay and its art to `data/backgrounds`.
 * Returns the normalised entry so the caller can report the new id.
 */
export async function createBackground({ name, price = 100, level = 1, image }) {
  const clean = cleanName(name);

  if (!clean) throw new WallpaperError('Give the background a name (1–40 characters).', 'name');
  if (!image) throw new WallpaperError('Attach an image for the background.', 'image');

  const id = uniqueId(clean);
  const saved = await saveBackgroundArt(id, image);

  let entry;
  try {
    entry = {
      id,
      name: clean,
      level: cleanLevel(level, 1),
      price: cleanPrice(price, 100),
      theme: plainTheme(saved.theme),
      artMode: 'wallpaper',
      auto: false,
    };
    await writeBackgroundOverrides(overridesWithEntry(id, entry));
    reloadBackgrounds();
  } catch (error) {
    await deleteBackgroundArt(id).catch(() => null);
    throw error;
  }

  logger.info(`Background "${id}" added from the Activity`);
  return backgroundById(id);
}

/**
 * Changes a design. Name/level/theme/art are written to the data overlay and
 * are shared by every server; the caller handles the per-guild price override.
 */
export async function updateBackground(id, { name, price, level, image }) {
  if (id === 'default' || id === 'custom') {
    throw new WallpaperError('The Classic and custom cards cannot be edited here.', 'path');
  }

  const current = backgroundById(id);

  if (!current) throw new WallpaperError('That background no longer exists.', 'unknown');
  if (!isValidBackgroundId(id)) throw new WallpaperError('That background cannot be edited.', 'path');

  let saved = null;

  if (image) saved = await saveBackgroundArt(id, image);

  let entry = {
    id,
    name: current.name,
    level: current.level,
    price: current.price,
    theme: plainTheme(current.theme),
    artMode: current.artMode,
    auto: current.auto,
  };

  if (name !== undefined) {
    const clean = cleanName(name);
    if (!clean) throw new WallpaperError('Give the background a name (1–40 characters).', 'name');
    entry.name = clean;
  }

  if (price !== undefined) entry.price = cleanPrice(price, current.price);
  if (level !== undefined) entry.level = cleanLevel(level, current.level);
  if (saved) entry.theme = plainTheme(saved.theme);

  // A paid design never auto-equips, even if it used to be free.
  if (entry.price > 0) entry.auto = false;

  await writeBackgroundOverrides(overridesWithEntry(id, entry));
  reloadBackgrounds();

  logger.info(`Background "${id}" updated from the Activity`);
  return backgroundById(id);
}

/**
 * Removes a design from the shop and the ladder. A bundled design stays on disk
 * but gets a `deleted` override, so it can be restored by editing the data
 * manifest; an uploaded design is removed completely.
 */
export async function deleteBackground(id) {
  if (id === 'default' || id === 'custom') {
    throw new WallpaperError('The Classic and custom cards cannot be deleted.', 'path');
  }

  const current = backgroundById(id);

  if (!current) throw new WallpaperError('That background no longer exists.', 'unknown');
  if (!isValidBackgroundId(id)) throw new WallpaperError('That background cannot be deleted.', 'path');

  const raw = readBackgroundOverrides();
  const backgrounds = (Array.isArray(raw.backgrounds) ? raw.backgrounds : []).filter(
    (item) => String(item?.id ?? '') !== id,
  );

  if (isBuiltInBackground(id)) {
    backgrounds.push({ id, deleted: true });
  } else {
    await deleteBackgroundArt(id);
  }

  await writeBackgroundOverrides({ ...raw, backgrounds });
  reloadBackgrounds();

  logger.info(`Background "${id}" deleted from the Activity`);
  return { id, builtIn: isBuiltInBackground(id) };
}
