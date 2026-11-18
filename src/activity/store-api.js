import { existsSync } from 'node:fs';
import path from 'node:path';
import { config, rootDir } from '../config.js';
import { createLogger } from '../lib/logger.js';
import {
  BACKGROUNDS,
  backgroundById,
  isBackgroundUnlocked,
} from '../services/profile-backgrounds.js';
import {
  getProfile,
  profileLevel,
  setProfileBackground,
} from '../services/profile-store.js';
import {
  MAX_STACK,
  buyStoreItem,
  memberPurchases,
  ownedBackgroundIds,
  storeBalance,
  storeCatalog,
} from '../services/store.js';
import { MAX_EMOJI_BYTES } from '../services/store-catalog.js';

const logger = createLogger('activity-store');

const ART_DIR = path.join(rootDir, 'assets', 'profile', 'backgrounds');
const ART_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const TOKEN_TTL_MS = 5 * 60_000;
const MEMBER_TTL_MS = 60_000;

const userCache = new Map();
const memberCache = new Map();

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

export function backgroundArtFile(id) {
  for (const extension of ART_EXTENSIONS) {
    const file = path.join(ART_DIR, `${id}.${extension}`);

    if (existsSync(file)) return { file, extension };
  }

  return null;
}

function artUrl(id) {
  const art = backgroundArtFile(id);

  return art ? `/assets/backgrounds/${id}.${art.extension}` : null;
}

function avatarUrl(user) {
  if (!user?.avatar) {
    const index = Number(BigInt(user?.id ?? 0) % 5n);
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
  }

  const extension = String(user.avatar).startsWith('a_') ? 'gif' : 'png';

  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${extension}?size=128`;
}

/* ── Catalogue ────────────────────────────────────────────────────────────── */

function rarityFor(price) {
  if (price >= 200) return 'legendary';
  if (price >= 120) return 'epic';
  if (price >= 60) return 'rare';

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

function shapeBackground(background, level, owned, selected) {
  const price = Math.max(0, Math.trunc(Number(background.price) || 0));

  return {
    id: background.id,
    name: background.name,
    level: background.level,
    price,
    rarity: rarityFor(price),
    art: artUrl(background.id),
    theme: background.theme ?? null,
    unlocked: isBackgroundUnlocked(background, level, owned),
    owned: owned.has(background.id) || price === 0,
    selected: selected === background.id,
  };
}

/**
 * Everything the storefront needs in one response: who is looking, the balance,
 * the sellable items and the full background collection.
 */
export function storefront(client, guild, member, user) {
  const guildId = guild.id;
  const userId = user.id;
  const balance = storeBalance(guildId, userId);
  const purchases = memberPurchases(guildId, userId);
  const owned = ownedBackgroundIds(guildId, userId);
  const counts = purchaseCounts(purchases);
  const level = profileLevel(guildId, userId);
  const profile = getProfile(guildId, userId);
  const selected = profile.background ?? 'default';

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
    items: storeCatalog(guildId)
      .filter((item) => item.enabled)
      .map((item) => shapeItem(item, counts)),
    backgrounds: BACKGROUNDS.map((background) =>
      shapeBackground(background, level, owned, selected),
    ),
  };
}

/* ── Buying ───────────────────────────────────────────────────────────────── */

function parseImage(raw, name) {
  const text = String(raw ?? '').trim();

  if (!text) return { error: null, attachment: null };

  const match = /^data:([^;,]+);base64,(.+)$/is.exec(text);

  if (!match) {
    return { error: { reason: 'image', message: 'The image could not be read.' } };
  }

  const contentType = match[1].toLowerCase();

  if (!IMAGE_TYPES.has(contentType)) {
    return { error: { reason: 'image', message: 'Use a PNG, JPEG, WebP or GIF image.' } };
  }

  let buffer;

  try {
    buffer = Buffer.from(match[2], 'base64');
  } catch {
    return { error: { reason: 'image', message: 'The image could not be read.' } };
  }

  if (buffer.length === 0) {
    return { error: { reason: 'image', message: 'The image is empty.' } };
  }

  if (buffer.length > MAX_EMOJI_BYTES) {
    return {
      error: {
        reason: 'size',
        message: `The image is ${Math.ceil(buffer.length / 1024)} KB; the limit is 256 KB.`,
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
      name: String(name ?? 'emoji.png').slice(0, 100),
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
    return { ok: false, reason: 'guild', message: 'The bot is not in this server.' };
  }

  if (context.error === 'member') {
    return { ok: false, reason: 'member', message: 'You are not a member of this server.' };
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

export function equipFromActivity(client, guildId, userId, backgroundId) {
  const context = client.guilds.cache.get(String(guildId ?? ''));
  if (!context) return { ok: false, reason: 'guild', message: 'The bot is not in this server.' };

  const background = backgroundById(String(backgroundId ?? ''));

  if (!background) return { ok: false, reason: 'unknown', message: 'Unknown background.' };

  const owned = ownedBackgroundIds(guildId, userId);
  const level = profileLevel(guildId, userId);

  if (!isBackgroundUnlocked(background, level, owned)) {
    return {
      ok: false,
      reason: 'locked',
      message:
        background.price > 0
          ? `Buy **${background.name}** in the store first.`
          : `**${background.name}** unlocks at level ${background.level}.`,
      level: background.level,
      price: background.price,
    };
  }

  setProfileBackground(guildId, userId, background.id);

  return { ok: true, backgroundId: background.id, name: background.name };
}
