import { readFile, stat } from 'node:fs/promises';
import { PermissionFlagsBits } from 'discord.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { config } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { linkedPoints } from '../services/ebot-vex.js';
import {
  BACKGROUNDS,
  CUSTOM_ID,
  CUSTOM_LEVEL,
  MAX_WALLPAPER_BYTES,
  WallpaperError,
  backgroundArtUrl,
  backgroundById,
  customWallpaperPath,
  hasCustomWallpaper,
  isBackgroundUnlocked,
  saveCustomWallpaper,
} from '../services/profile-backgrounds.js';
import { createBackground, deleteBackground, updateBackground } from '../services/background-admin.js';
import {
  CHARACTERS,
  buyCharacter,
  characterArtUrl,
  createCharacter,
  deleteCharacter,
  ownedCharacterIds,
  updateCharacter,
} from '../services/character-store.js';
import {
  MAX_RESERVE_PRICE,
  pendingReservationFor,
  pendingReservations,
  renameReservation,
  reservationSettings,
  reserveCharacter,
  setReservationSettings,
} from '../services/character-reservations.js';
import {
  getProfile,
  profileLevel,
  setProfileBackground,
} from '../services/profile-store.js';
import {
  MAX_STACK,
  buyStoreItem,
  clearStoreOverride,
  designItemKey,
  memberPurchases,
  ownedBackgroundIds,
  storeBalance,
  storeCatalog,
} from '../services/store.js';
import { MAX_EMOJI_BYTES } from '../services/store-catalog.js';

const logger = createLogger('activity-store');

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);

const TOKEN_TTL_MS = 5 * 60_000;
const MEMBER_TTL_MS = 60_000;

const userCache = new Map();
const memberCache = new Map();
const previewCache = new Map();

/* ── Discord auth ─────────────────────────────────────────────────────────── */

/** Activity is usable only when the bot has a client id and secret. */
export function activityConfigured() {
  return Boolean(config.clientId && config.activity.clientSecret);
}

/**
 * Swaps the one-time `code` from the Embedded App SDK for an OAuth2 access
 * token. The secret never leaves this process.
 */
export async function exchangeCode(code) {
  if (!activityConfigured()) {
    throw Object.assign(new Error('Activity OAuth is not configured.'), { reason: 'config' });
  }

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.activity.clientSecret,
    grant_type: 'authorization_code',
    code: String(code ?? ''),
  });

  const response = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    logger.warn(`Activity token exchange failed: ${payload.error ?? response.status}`);
    throw Object.assign(new Error('Discord refused the activity code.'), {
      reason: 'token',
      status: response.status,
    });
  }

  return payload;
}

/** Resolves an OAuth2 bearer token to the member behind it, with a short cache. */
export async function authUser(accessToken) {
  const token = String(accessToken ?? '').trim();
  if (!token) return null;

  const cached = userCache.get(token);

  if (cached && cached.expires > Date.now()) return cached.user;

  const response = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    userCache.delete(token);
    return null;
  }

  const user = await response.json();
  userCache.set(token, { user, expires: Date.now() + TOKEN_TTL_MS });

  // Keep the cache from growing forever if many members open the activity.
  if (userCache.size > 500) {
    const now = Date.now();
    for (const [key, value] of userCache) if (value.expires <= now) userCache.delete(key);
  }

  return user;
}

/* ── Guild context ────────────────────────────────────────────────────────── */

function cacheKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

/** Confirms the bot is in the guild and the caller is still a member. */
export async function guildContext(client, guildId, userId) {
  const cached = memberCache.get(cacheKey(guildId, userId));

  if (cached && cached.expires > Date.now()) return cached.context;

  const guild = client.guilds.cache.get(String(guildId ?? ''));

  if (!guild) return { error: 'guild' };

  let member = null;

  try {
    member = await guild.members.fetch(userId);
  } catch {
    member = null;
  }

  if (!member) return { error: 'member' };

  const context = { guild, member };
  memberCache.set(cacheKey(guildId, userId), { context, expires: Date.now() + MEMBER_TTL_MS });

  return context;
}

/* ── Artwork ──────────────────────────────────────────────────────────────── */

function artUrl(id) {
  return backgroundArtUrl(id);
}

function avatarUrl(user) {
  if (!user?.avatar) {
    const index = Number(BigInt(user?.id ?? 0) % 5n);
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
  }

  const extension = String(user.avatar).startsWith('a_') ? 'gif' : 'png';

  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${extension}?size=128`;
}

const PREVIEW_WIDTH = 480;
const PREVIEW_HEIGHT = Math.round((PREVIEW_WIDTH * 1200) / 1868);

/**
 * A small data-URL preview of a member's uploaded wallpaper. The Activity cannot
 * put an Authorization header on an `<img>`, and the card renderer needs the
 * full file, so the storefront ships a thumbnail instead of a public URL.
 */
async function customPreview(guildId, userId) {
  const file = customWallpaperPath(guildId, userId);
  let info;

  try {
    info = await stat(file);
  } catch {
    return null;
  }

  const key = `${guildId}:${userId}`;
  const cached = previewCache.get(key);

  if (cached && cached.mtimeMs === info.mtimeMs) return cached.dataUrl;

  try {
    const image = await loadImage(await readFile(file));
    const canvas = createCanvas(PREVIEW_WIDTH, PREVIEW_HEIGHT);
    const ctx = canvas.getContext('2d');
    const scale = Math.max(PREVIEW_WIDTH / image.width, PREVIEW_HEIGHT / image.height);
    const width = image.width * scale;
    const height = image.height * scale;

    ctx.drawImage(image, (PREVIEW_WIDTH - width) / 2, (PREVIEW_HEIGHT - height) / 2, width, height);

    const dataUrl = `data:image/jpeg;base64,${canvas
      .toBuffer('image/jpeg', 80)
      .toString('base64')}`;

    previewCache.set(key, { mtimeMs: info.mtimeMs, dataUrl });
    if (previewCache.size > 200) previewCache.delete(previewCache.keys().next().value);

    return dataUrl;
  } catch {
    return null;
  }
}

/* ── Catalogue ────────────────────────────────────────────────────────────── */

function rarityFor(price) {
  if (price >= 300) return 'legendary';
  if (price >= 180) return 'epic';
  if (price >= 100) return 'rare';

  return 'common';
}

function purchaseCounts(purchases) {
  const counts = new Map();

  for (const row of purchases) {
    counts.set(row.item_key, (counts.get(row.item_key) ?? 0) + 1);
  }

  return counts;
}

function shapeItem(item, counts) {
  const ownedCount = counts.get(item.key) ?? 0;

  return {
    key: item.key,
    type: item.type,
    name: item.name,
    summary: item.summary ?? '',
    price: item.price,
    defaultPrice: item.defaultPrice,
    amount: item.amount ?? 1,
    limit: item.limit ?? 0,
    stackable: Boolean(item.stackable),
    needs: item.needs ?? [],
    backgroundId: item.backgroundId ?? null,
    level: item.level ?? null,
    ownedCount,
    atLimit: item.limit > 0 && ownedCount >= item.limit,
    rarity: rarityFor(item.price),
    art: item.type === 'background' && item.backgroundId ? artUrl(item.backgroundId) : null,
    theme: item.backgroundId ? (backgroundById(item.backgroundId)?.theme ?? null) : null,
  };
}

function shapeBackground(background, level, owned, selected, priceOverride = background.price) {
  const price = Math.max(0, Math.trunc(Number(priceOverride) || 0));

  return {
    id: background.id,
    name: background.name,
    level: background.level,
    price,
    rarity: rarityFor(price),
    art: artUrl(background.id),
    theme: background.theme ?? null,
    unlocked: isBackgroundUnlocked(background, level, owned),
    owned: owned.has(background.id) || Number(background.price) === 0,
    selected: selected === background.id,
  };
}

function shapeCharacter(character, owned) {
  return {
    id: character.id,
    name: character.name,
    price: character.price,
    rarity: rarityFor(character.price),
    art: characterArtUrl(character.id),
    owned: owned.has(character.id),
  };
}

/**
 * Everything the storefront needs in one response: who is looking, the balance,
 * the sellable items and the full background collection.
 */
export async function storefront(client, guild, member, user) {
  const guildId = guild.id;
  const userId = user.id;
  const balance = storeBalance(guildId, userId);
  const purchases = memberPurchases(guildId, userId);
  const owned = ownedBackgroundIds(guildId, userId);
  const counts = purchaseCounts(purchases);
  // Match `/background` and the card: linked VEX/Nightmare points count toward
  // the level, so a design unlocked on the card is never locked in the store.
  const linked = await linkedPoints(client, guildId);
  const level = profileLevel(guildId, userId, linked);
  const profile = getProfile(guildId, userId);
  const selected = profile.background ?? 'default';
  const catalog = storeCatalog(guildId);
  const designPrices = new Map(
    catalog
      .filter((item) => item.type === 'background' && item.backgroundId)
      .map((item) => [item.backgroundId, item.price]),
  );
  const manager = Boolean(member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
  const hasCustom = hasCustomWallpaper(guildId, userId);
  const customArt = hasCustom ? await customPreview(guildId, userId) : null;
  const canUploadCustom = manager || hasCustom || level >= CUSTOM_LEVEL;
  // Characters are a Manage Server surface for now: only managers get the
  // catalogue and reservation state, so a regular member never sees the tab.
  const ownedCharacters = manager ? ownedCharacterIds(guildId, userId) : new Set();
  const reserveSettings = manager ? reservationSettings(guildId) : null;
  const myReservation = manager ? pendingReservationFor(guildId, userId) : null;
  const managerReservations = manager ? pendingReservations(guildId) : [];

  const custom = {
    id: CUSTOM_ID,
    name: 'خلفية مخصصة',
    level: CUSTOM_LEVEL,
    price: 0,
    rarity: 'epic',
    art: customArt,
    theme: null,
    custom: true,
    hasImage: hasCustom,
    canUpload: canUploadCustom,
    unlocked: canUploadCustom,
    owned: hasCustom,
    selected: hasCustom && selected === CUSTOM_ID,
  };

  // The shop reads best with the personal item first, then paid designs by
  // price, then the free level ladder.
  const ordered = [...BACKGROUNDS].sort((a, b) => {
    if (a.id === 'default') return -1;
    if (b.id === 'default') return 1;

    const paidA = a.price > 0 ? 1 : 0;
    const paidB = b.price > 0 ? 1 : 0;

    if (paidA !== paidB) return paidB - paidA;
    if (paidA) return a.price - b.price || a.name.localeCompare(b.name);

    return a.level - b.level || a.name.localeCompare(b.name);
  });

  const backgrounds = [
    custom,
    ...ordered.map((background) =>
      shapeBackground(
        background,
        level,
        owned,
        selected,
        designPrices.get(background.id) ?? background.price,
      ),
    ),
  ];

  return {
    guild: {
      id: guild.id,
      name: guild.name,
      icon: guild.iconURL({ size: 128 }),
    },
    user: {
      id: userId,
      name: member.displayName || user.global_name || user.username,
      username: user.username,
      avatar: avatarUrl(user),
    },
    balance,
    level,
    maxStack: MAX_STACK,
    currency: 'coins',
    canManage: manager,
    customLevel: CUSTOM_LEVEL,
    items: catalog.filter((item) => item.enabled).map((item) => shapeItem(item, counts)),
    backgrounds,
    characters: manager
      ? CHARACTERS.map((character) => shapeCharacter(character, ownedCharacters))
      : [],
    // Null for non-managers on purpose: the Characters tab is manager-only, and
    // an empty shape would only invite a future UI to render it by accident.
    reserve: manager
      ? {
          enabled: reserveSettings.enabled,
          price: reserveSettings.price,
          hasPending: Boolean(myReservation),
          reservation: myReservation,
          pendingCount: managerReservations.length,
          reservations: managerReservations,
        }
      : null,
  };
}

/* ── Buying ───────────────────────────────────────────────────────────────── */

function parseImage(
  raw,
  name,
  { maxBytes = MAX_EMOJI_BYTES, limitLabel = '256 كيلوبايت', defaultName = 'emoji.png' } = {},
) {
  const text = String(raw ?? '').trim();

  if (!text) return { error: null, attachment: null };

  const match = /^data:([^;,]+);base64,(.+)$/is.exec(text);

  if (!match) {
    return { error: { reason: 'image', message: 'ما قدرنا نقرأ الصورة.' } };
  }

  const contentType = match[1].toLowerCase();

  if (!IMAGE_TYPES.has(contentType)) {
    return { error: { reason: 'image', message: 'استخدم صورة PNG أو JPEG أو WebP أو GIF.' } };
  }

  let buffer;

  try {
    buffer = Buffer.from(match[2], 'base64');
  } catch {
    return { error: { reason: 'image', message: 'ما قدرنا نقرأ الصورة.' } };
  }

  if (buffer.length === 0) {
    return { error: { reason: 'image', message: 'الصورة فاضية.' } };
  }

  if (buffer.length > maxBytes) {
    return {
      error: {
        reason: 'size',
        message: `حجم الصورة ${Math.ceil(buffer.length / 1024)} كيلوبايت، والحد ${limitLabel}.`,
      },
    };
  }

  return {
    error: null,
    attachment: {
      url: text,
      buffer,
      size: buffer.length,
      contentType,
      name: String(name ?? defaultName).slice(0, 100),
    },
  };
}

export async function buyFromActivity({
  client,
  guildId,
  user,
  key,
  quantity = 1,
  name = null,
  color = null,
  image = null,
  imageName = null,
}) {
  const context = await guildContext(client, guildId, user.id);

  if (context.error === 'guild') {
    return { ok: false, reason: 'guild', message: 'البوت مو موجود في هذا السيرفر.' };
  }

  if (context.error === 'member') {
    return { ok: false, reason: 'member', message: 'إنت مو عضو في هذا السيرفر.' };
  }

  const parsed = parseImage(image, imageName);

  if (parsed.error) return { ok: false, ...parsed.error };

  const result = await buyStoreItem({
    guild: context.guild,
    guildId: context.guild.id,
    userId: user.id,
    member: context.member,
    key,
    name,
    color,
    attachment: parsed.attachment,
    quantity,
  });

  // The internal item object includes fields the browser does not need.
  const item = result.item
    ? { key: result.item.key, name: result.item.name, type: result.item.type }
    : null;

  return { ...result, item };
}

/* ── Backgrounds ──────────────────────────────────────────────────────────── */

export async function equipFromActivity(client, guildId, userId, backgroundId) {
  const guild = client.guilds.cache.get(String(guildId ?? ''));
  if (!guild) return { ok: false, reason: 'guild', message: 'البوت مو موجود في هذا السيرفر.' };

  if (String(backgroundId ?? '') === CUSTOM_ID) {
    if (!hasCustomWallpaper(guildId, userId)) {
      return {
        ok: false,
        reason: 'custom',
        message: `ارفع خلفية مخصصة أول (المستوى ${CUSTOM_LEVEL} أو أعلى، أو إدارة السيرفر).`,
      };
    }

    setProfileBackground(guildId, userId, CUSTOM_ID);
    return { ok: true, backgroundId: CUSTOM_ID, name: 'خلفية مخصصة' };
  }

  const background = backgroundById(String(backgroundId ?? ''));

  if (!background) return { ok: false, reason: 'unknown', message: 'الخلفية مو معروفة.' };

  const owned = ownedBackgroundIds(guildId, userId);
  // Re-check with the same merged level the storefront displayed, otherwise a
  // member whose points come from a linked bot can see a design unlocked but
  // have the equip request refused.
  const linked = await linkedPoints(client, guildId);
  const level = profileLevel(guildId, userId, linked);

  if (!isBackgroundUnlocked(background, level, owned)) {
    return {
      ok: false,
      reason: 'locked',
      message:
        background.price > 0
          ? `اشترِ **${background.name}** من المتجر أول.`
          : `**${background.name}** تنفتح عند المستوى ${background.level}.`,
      level: background.level,
      price: background.price,
    };
  }

  setProfileBackground(guildId, userId, background.id);

  return { ok: true, backgroundId: background.id, name: background.name };
}

/** Uploads/replaces a member's custom wallpaper from the Activity. */
export async function saveCustomFromActivity({ client, guildId, user, image, imageName }) {
  const context = await guildContext(client, guildId, user.id);

  if (context.error === 'guild') {
    return { ok: false, reason: 'guild', message: 'البوت مو موجود في هذا السيرفر.' };
  }

  if (context.error === 'member') {
    return { ok: false, reason: 'member', message: 'إنت مو عضو في هذا السيرفر.' };
  }

  const manager = Boolean(context.member.permissions?.has?.(PermissionFlagsBits.ManageGuild));
  const hasCustom = hasCustomWallpaper(guildId, user.id);
  const linked = await linkedPoints(client, guildId);
  const level = profileLevel(guildId, user.id, linked);

  if (!manager && !hasCustom && level < CUSTOM_LEVEL) {
    return {
      ok: false,
      reason: 'level',
      message: `الخلفيات المخصصة تنفتح عند المستوى ${CUSTOM_LEVEL}. إنت الحين المستوى ${level}.`,
      level: CUSTOM_LEVEL,
    };
  }

  const parsed = parseImage(image, imageName, {
    maxBytes: MAX_WALLPAPER_BYTES,
    limitLabel: '10 ميجابايت',
    defaultName: 'wallpaper.jpg',
  });

  if (parsed.error) return { ok: false, ...parsed.error };

  if (!parsed.attachment) {
    return { ok: false, reason: 'image', message: 'اختر صورة PNG أو JPEG أو WebP أو GIF.' };
  }

  try {
    const saved = await saveCustomWallpaper(guildId, user.id, parsed.attachment, {
      fetchImpl: async () => ({ ok: true, arrayBuffer: async () => parsed.attachment.buffer }),
    });

    setProfileBackground(guildId, user.id, CUSTOM_ID);

    return {
      ok: true,
      animated: saved.animated,
      frames: saved.frames,
      wasGif: saved.wasGif,
      width: saved.sourceWidth,
      height: saved.sourceHeight,
    };
  } catch (error) {
    if (error instanceof WallpaperError) {
      return { ok: false, reason: error.code, message: error.message };
    }

    logger.warn(`Could not save a custom wallpaper for ${user.id}: ${error?.message ?? error}`);
    return {
      ok: false,
      reason: 'server',
      message: 'ما قدرنا نخزّن الصورة. جرّب بعد لحظة.',
    };
  }
}

/** Manage Server only: add, edit or delete a design from the shop. */
export async function adminBackground({
  client,
  guildId,
  user,
  action,
  id = null,
  name = null,
  price = null,
  level = null,
  image = null,
  imageName = null,
}) {
  const context = await guildContext(client, guildId, user.id);

  if (context.error === 'guild') {
    return { ok: false, reason: 'guild', message: 'البوت مو موجود في هذا السيرفر.' };
  }

  if (context.error === 'member') {
    return { ok: false, reason: 'member', message: 'إنت مو عضو في هذا السيرفر.' };
  }

  if (!context.member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) {
    return {
      ok: false,
      reason: 'permission',
      message: 'تحتاج **إدارة السيرفر** عشان تعدّل المتجر.',
    };
  }

  const parsed = image
    ? parseImage(image, imageName, {
        maxBytes: MAX_WALLPAPER_BYTES,
        limitLabel: '10 ميجابايت',
        defaultName: 'background.jpg',
      })
    : { error: null, attachment: null };

  if (parsed.error) return { ok: false, ...parsed.error };

  const priceValue = price === null || price === undefined ? undefined : Number(price);
  const levelValue = level === null || level === undefined ? undefined : Number(level);

  try {
    if (action === 'create') {
      const created = await createBackground({
        name,
        price: priceValue,
        level: levelValue,
        image: parsed.attachment?.buffer ?? null,
      });

      return {
        ok: true,
        background: created
          ? { id: created.id, name: created.name, price: created.price, level: created.level }
          : null,
      };
    }

    if (action === 'update') {
      const updated = await updateBackground(String(id ?? ''), {
        name: name === null ? undefined : name,
        price: priceValue,
        level: levelValue,
        image: parsed.attachment?.buffer ?? null,
      });

      if (priceValue !== undefined) {
        clearStoreOverride(guildId, designItemKey(updated.id));
      }

      return {
        ok: true,
        background: { id: updated.id, name: updated.name, price: updated.price, level: updated.level },
      };
    }

    if (action === 'delete') {
      const deleted = await deleteBackground(String(id ?? ''));
      clearStoreOverride(guildId, designItemKey(String(id ?? '')));
      return { ok: true, ...deleted };
    }

    return { ok: false, reason: 'action', message: 'إجراء الخلفية مو معروف.' };
  } catch (error) {
    if (error instanceof WallpaperError) {
      return { ok: false, reason: error.code, message: error.message };
    }

    logger.warn(`Background admin action ${action} failed: ${error?.message ?? error}`);
    return {
      ok: false,
      reason: 'server',
      message: 'ما انحفظت الخلفية. جرّب مرة ثانية.',
    };
  }
}

/* ── Characters ───────────────────────────────────────────────────────────── */

/** Charges for one character from the Characters tab. */
export async function buyCharacterFromActivity({ client, guildId, user, characterId }) {
  const context = await guildContext(client, guildId, user.id);

  if (context.error === 'guild') {
    return { ok: false, reason: 'guild', message: 'البوت مو موجود في هذا السيرفر.' };
  }

  if (context.error === 'member') {
    return { ok: false, reason: 'member', message: 'إنت مو عضو في هذا السيرفر.' };
  }

  return buyCharacter({
    guildId: context.guild.id,
    userId: user.id,
    characterId,
  });
}

/** Creates or renames the caller's paid character reservation. */
export async function reserveFromActivity({ client, guildId, user, action = 'create', id = null, name = null }) {
  const context = await guildContext(client, guildId, user.id);

  if (context.error === 'guild') {
    return { ok: false, reason: 'guild', message: 'البوت مو موجود في هذا السيرفر.' };
  }

  if (context.error === 'member') {
    return { ok: false, reason: 'member', message: 'إنت مو عضو في هذا السيرفر.' };
  }

  if (action === 'update') {
    return renameReservation({
      guildId: context.guild.id,
      userId: user.id,
      id,
      name,
    });
  }

  if (action !== 'create') {
    return { ok: false, reason: 'action', message: 'إجراء الحجز مو معروف.' };
  }

  return reserveCharacter({
    guildId: context.guild.id,
    userId: user.id,
    userName: context.member.displayName || user.global_name || user.username,
    name,
  });
}

/** Manage Server only: add, edit or delete a character. */
export async function adminCharacter({
  client,
  guildId,
  user,
  action,
  id = null,
  name = null,
  price = null,
  image = null,
  imageName = null,
}) {
  const context = await guildContext(client, guildId, user.id);

  if (context.error === 'guild') {
    return { ok: false, reason: 'guild', message: 'البوت مو موجود في هذا السيرفر.' };
  }

  if (context.error === 'member') {
    return { ok: false, reason: 'member', message: 'إنت مو عضو في هذا السيرفر.' };
  }

  if (!context.member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) {
    return {
      ok: false,
      reason: 'permission',
      message: 'تحتاج **إدارة السيرفر** عشان تعدّل المتجر.',
    };
  }

  const parsed = image
    ? parseImage(image, imageName, {
        maxBytes: MAX_WALLPAPER_BYTES,
        limitLabel: '10 ميجابايت',
        defaultName: 'character.jpg',
      })
    : { error: null, attachment: null };

  if (parsed.error) return { ok: false, ...parsed.error };

  const priceValue = price === null || price === undefined ? undefined : Number(price);

  try {
    if (action === 'create') {
      const created = await createCharacter({
        name,
        price: priceValue,
        image: parsed.attachment?.buffer ?? null,
      });

      return {
        ok: true,
        character: created
          ? { id: created.id, name: created.name, price: created.price }
          : null,
      };
    }

    if (action === 'update') {
      const updated = await updateCharacter(String(id ?? ''), {
        name: name === null ? undefined : name,
        price: priceValue,
        image: parsed.attachment?.buffer ?? null,
      });

      return {
        ok: true,
        character: { id: updated.id, name: updated.name, price: updated.price },
      };
    }

    if (action === 'delete') {
      const deleted = await deleteCharacter(String(id ?? ''));
      return { ok: true, ...deleted };
    }

    return { ok: false, reason: 'action', message: 'إجراء الشخصية مو معروف.' };
  } catch (error) {
    if (error instanceof WallpaperError) {
      return { ok: false, reason: error.code, message: error.message };
    }

    logger.warn(`Character admin action ${action} failed: ${error?.message ?? error}`);
    return {
      ok: false,
      reason: 'server',
      message: 'ما انحفظت الشخصية. جرّب مرة ثانية.',
    };
  }
}

/** Manage Server only: reserve price and whether the option is visible. */
export async function adminReserve({ client, guildId, user, enabled, price }) {
  const context = await guildContext(client, guildId, user.id);

  if (context.error === 'guild') {
    return { ok: false, reason: 'guild', message: 'البوت مو موجود في هذا السيرفر.' };
  }

  if (context.error === 'member') {
    return { ok: false, reason: 'member', message: 'إنت مو عضو في هذا السيرفر.' };
  }

  if (!context.member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) {
    return {
      ok: false,
      reason: 'permission',
      message: 'تحتاج **إدارة السيرفر** عشان تعدّل المتجر.',
    };
  }

  let priceValue;

  if (price !== null && price !== undefined) {
    priceValue = Math.trunc(Number(price));

    if (!Number.isInteger(priceValue) || priceValue < 0 || priceValue > MAX_RESERVE_PRICE) {
      return {
        ok: false,
        reason: 'price',
        message: `السعر لازم يكون رقم صحيح من 0 إلى ${MAX_RESERVE_PRICE}.`,
      };
    }
  }

  const settings = setReservationSettings(context.guild.id, {
    enabled: enabled === undefined ? undefined : Boolean(enabled),
    price: priceValue,
  });

  return { ok: true, reserve: { enabled: settings.enabled, price: settings.price } };
}
