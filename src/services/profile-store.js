import { randomUUID } from 'node:crypto';
import { getDb } from '../lib/db.js';
import { createLogger } from '../lib/logger.js';
import { recordCoinTransaction } from './coin-ledger.js';

const logger = createLogger('profile');

/** How many raw points each bot punishment is worth on the card. */
export const PUNISHMENT_WEIGHTS = {
  mute: 1,
  timeout: 1,
  kick: 1,
  ban: 1,
};

/** Seven raw points make one displayed punishment. */
export const PUNISHMENT_POINTS_PER_UNIT = 7;

/**
 * Mini points an exile level is worth. `main` is a holding level and scores
 * nothing; levels 1–9 score their number; level 10 scores ten whole
 * punishments (10 × 7 mini points).
 */
export function exilePointsFor(level) {
  if (level === 'main') return 0;

  const number = Number.parseInt(level, 10);

  if (!Number.isInteger(number) || number < 1 || number > 10) return 0;

  return number === 10 ? 10 * PUNISHMENT_POINTS_PER_UNIT : number;
}

/** XP is one point for every five nightmare + vex points. */
export const POINTS_PER_XP = 5;

/** Every level costs exactly this much XP. */
export const XP_PER_LEVEL = 100;

/** Each level gained pays this many coins; level 1 is the starting level. */
export const COINS_PER_LEVEL = 5;

/**
 * Every XP gain costs this much XP per displayed punishment. A member with 3
 * punishments turns a +10 XP gain into +4.
 */
export const XP_PENALTY_PER_PUNISHMENT = 2;

export const MAX_TITLE_LENGTH = 32;

const EMPTY_PROFILE = Object.freeze({
  title: null,
  nightmare: 0,
  vex: 0,
  punishMini: 0,
  goodBehavior: 0,
  showBirthday: true,
  background: null,
  coins: 0,
  levelCoinsPaid: 0,
  xpPenalty: 0,
  xpSeen: 0,
  createdAt: null,
  updatedAt: null,
});

// Seeding the exile history and the coin backfill is a one-time job per guild.
// Caching the answer keeps the common path (a mute, a profile view) from
// touching the meta table.
const seededGuilds = new Set();
const coinSeededGuilds = new Set();
const coinSeededCache = new Map();

/**
 * Whether this guild already ran the one-time coin import. Until it has, a
 * profile's first observation seeds its history instead of charging the
 * punishment toll; afterwards a row without a paid level is simply new.
 */
function coinsSeeded(guildId) {
  if (coinSeededGuilds.has(guildId)) return true;
  if (coinSeededCache.has(guildId)) return coinSeededCache.get(guildId);

  const row = getDb()
    .prepare('SELECT coins_seeded_at FROM profile_meta WHERE guild_id = ?')
    .get(guildId);
  const seeded = Boolean(row?.coins_seeded_at);

  coinSeededCache.set(guildId, seeded);
  return seeded;
}

function toProfile(row) {
  if (!row) return { ...EMPTY_PROFILE };

  return {
    title: row.title ?? null,
    nightmare: row.nightmare,
    vex: row.vex,
    punishMini: row.punish_mini,
    goodBehavior: row.good_behavior,
    showBirthday: row.show_birthday !== 0,
    background: row.background ?? null,
    coins: Number(row.coins) || 0,
    levelCoinsPaid: Number(row.level_coins_paid) || 0,
    xpPenalty: Number(row.xp_penalty) || 0,
    xpSeen: Number(row.xp_seen) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A missing row reads as zeroes, so the card never needs a write to render. */
export function getProfile(guildId, userId) {
  const row = getDb()
    .prepare(
      `SELECT title, nightmare, vex, punish_mini, good_behavior, show_birthday,
              background, coins, level_coins_paid, xp_penalty, xp_seen,
              created_at, updated_at
         FROM profiles WHERE guild_id = ? AND user_id = ?`,
    )
    .get(guildId, userId);

  return toProfile(row);
}

function upsertProfile(db, guildId, userId, now) {
  db.prepare(
    `INSERT INTO profiles (guild_id, user_id, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (guild_id, user_id) DO NOTHING`,
  ).run(guildId, userId, now, now);
}

/**
 * Adds (or subtracts) points. Every stored field is clamped at zero: a
 * correction can take a member back to nothing, never below it.
 */
export function addProfilePoints(
  guildId,
  userId,
  { nightmare = 0, vex = 0, punishMini = 0, goodBehavior = 0, coins = 0 } = {},
  { coinType = 'adjust', coinDetail = null, actorId = null } = {},
) {
  const deltas = {
    nightmare: Math.trunc(Number(nightmare) || 0),
    vex: Math.trunc(Number(vex) || 0),
    punish_mini: Math.trunc(Number(punishMini) || 0),
    good_behavior: Math.trunc(Number(goodBehavior) || 0),
    coins: Math.trunc(Number(coins) || 0),
  };

  const db = getDb();
  const now = Date.now();

  db.exec('BEGIN');

  try {
    upsertProfile(db, guildId, userId, now);

    const read = db
      .prepare('SELECT coins FROM profiles WHERE guild_id = ? AND user_id = ?');
    const before = Number(read.get(guildId, userId)?.coins) || 0;

    db.prepare(
      `UPDATE profiles
          SET nightmare = MAX(0, nightmare + ?),
              vex = MAX(0, vex + ?),
              punish_mini = MAX(0, punish_mini + ?),
              good_behavior = MAX(0, good_behavior + ?),
              coins = MAX(0, coins + ?),
              updated_at = ?
        WHERE guild_id = ? AND user_id = ?`,
    ).run(
      deltas.nightmare,
      deltas.vex,
      deltas.punish_mini,
      deltas.good_behavior,
      deltas.coins,
      now,
      guildId,
      userId,
    );

    const after = Number(read.get(guildId, userId)?.coins) || 0;
    const actual = after - before;

    if (actual !== 0) {
      recordCoinTransaction({
        guildId,
        userId,
        amount: actual,
        balanceAfter: after,
        type: coinType,
        actorId,
        detail: coinDetail ?? { source: 'profile points' },
      });
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return getProfile(guildId, userId);
}

/** Whether members may send coins to each other in this guild. Defaults to on. */
export function transferEnabled(guildId) {
  const row = getDb()
    .prepare('SELECT transfer_enabled FROM coin_settings WHERE guild_id = ?')
    .get(guildId);

  return row ? row.transfer_enabled !== 0 : true;
}

/** Turns coin transfers on or off for this guild. */
export function setTransferEnabled(guildId, enabled) {
  const now = Date.now();

  getDb()
    .prepare(
      `INSERT INTO coin_settings (guild_id, transfer_enabled, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET
         transfer_enabled = excluded.transfer_enabled,
         updated_at = excluded.updated_at`,
    )
    .run(guildId, enabled ? 1 : 0, now);

  return Boolean(enabled);
}

/**
 * Moves coins between two members. The whole move is one transaction, and the
 * sender's balance is checked first, so a failed transfer leaves both sides
 * untouched. Returns the new balances.
 */
export function transferCoins(guildId, fromUserId, toUserId, amount) {
  const value = Number(amount);

  if (!Number.isSafeInteger(value) || value <= 0) {
    return { ok: false, reason: 'amount' };
  }

  if (fromUserId === toUserId) {
    return { ok: false, reason: 'self' };
  }

  const db = getDb();
  const now = Date.now();
  const transferId = randomUUID();
  const read = db.prepare(
    'SELECT coins FROM profiles WHERE guild_id = ? AND user_id = ?',
  );
  let fromBalance = 0;
  let toBalance = 0;

  db.exec('BEGIN');

  try {
    upsertProfile(db, guildId, fromUserId, now);
    upsertProfile(db, guildId, toUserId, now);

    const balance = Number(read.get(guildId, fromUserId)?.coins) || 0;

    if (balance < value) {
      db.exec('ROLLBACK');
      return { ok: false, reason: 'funds', balance };
    }

    const target = Number(read.get(guildId, toUserId)?.coins) || 0;
    const update = db.prepare(
      `UPDATE profiles SET coins = ?, updated_at = ?
        WHERE guild_id = ? AND user_id = ?`,
    );

    update.run(balance - value, now, guildId, fromUserId);
    update.run(target + value, now, guildId, toUserId);

    recordCoinTransaction({
      guildId,
      userId: fromUserId,
      amount: -value,
      balanceAfter: balance - value,
      type: 'transfer_out',
      actorId: fromUserId,
      detail: { transferId, toUserId },
    });

    recordCoinTransaction({
      guildId,
      userId: toUserId,
      amount: value,
      balanceAfter: target + value,
      type: 'transfer_in',
      actorId: fromUserId,
      detail: { transferId, fromUserId },
    });

    db.exec('COMMIT');
    fromBalance = balance - value;
    toBalance = target + value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  logger.info(`Coins: ${fromUserId} sent ${value} to ${toUserId} in ${guildId}`);
  return { ok: true, fromBalance, toBalance };
}

/** Sets or clears the title. `null` makes the card show "No Title". */
export function setProfileTitle(guildId, userId, title) {
  const cleaned = title === null || title === undefined
    ? null
    : String(title).trim().slice(0, MAX_TITLE_LENGTH) || null;
  const now = Date.now();
  const db = getDb();

  db.exec('BEGIN');

  try {
    upsertProfile(db, guildId, userId, now);
    db.prepare(
      'UPDATE profiles SET title = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
    ).run(cleaned, now, guildId, userId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return getProfile(guildId, userId);
}

/**
 * Shows or hides the birthday, age and time zone block on the member's card.
 * The preference lives on the profile row so it survives a birthday change and
 * can be set before a birthday exists.
 */
export function setBirthdayVisible(guildId, userId, visible) {
  const now = Date.now();
  const db = getDb();

  db.exec('BEGIN');

  try {
    upsertProfile(db, guildId, userId, now);
    db.prepare(
      'UPDATE profiles SET show_birthday = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
    ).run(visible ? 1 : 0, now, guildId, userId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return getProfile(guildId, userId);
}

/**
 * Stores the chosen card background. `null` means the classic template; a
 * design id (for example `tier-15`) or `custom` selects an unlocked option.
 * The command validates the unlock before calling this.
 */
export function setProfileBackground(guildId, userId, background) {
  const value = background === null || background === undefined
    ? null
    : String(background).trim().slice(0, 40) || null;
  const now = Date.now();
  const db = getDb();

  db.exec('BEGIN');

  try {
    upsertProfile(db, guildId, userId, now);
    db.prepare(
      'UPDATE profiles SET background = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
    ).run(value, now, guildId, userId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return getProfile(guildId, userId);
}

/**
 * Gives a member the points for a punishment the bot actually applied. The
 * caller is responsible for not calling this when the same punishment is
 * already active, so a mute that is re-applied without an unmute in between
 * does not count twice.
 */
export function recordPunishment(guildId, userId, kind) {
  const weight = PUNISHMENT_WEIGHTS[kind];

  if (!weight) return null;

  try {
    return addProfilePoints(guildId, userId, { punishMini: weight });
  } catch (error) {
    // The punishment already happened; a database problem must not turn a
    // successful moderation action into a failed command.
    logger.warn(`Could not record ${kind} points for ${userId}: ${error.message}`);
    return null;
  }
}

/**
 * Awards the increase when an exile is created or escalated. The points follow
 * the highest level the exile reached: raising 3 → 6 adds 3, lowering 6 → 3
 * adds nothing, and repeating the same level adds nothing. `main` is worth 0,
 * so a main exile only scores once it is forwarded to a numbered level.
 */
export function recordExilePoints(guildId, userId, previousLevel, level) {
  const delta = exilePointsFor(level) - exilePointsFor(previousLevel);

  if (delta <= 0) return null;

  try {
    return addProfilePoints(guildId, userId, { punishMini: delta });
  } catch (error) {
    // The exile already happened; a database problem must not turn a
    // successful moderation action into a failed command.
    logger.warn(`Could not record exile points for ${userId}: ${error.message}`);
    return null;
  }
}

/**
 * Imports the existing exile history once per guild. Each row is worth its
 * level's value at the time it was recorded; `main` rows are worth nothing.
 * Mutes, timeouts, kicks and bans have no history table, which is why only
 * exiles can be recovered.
 *
 * Callers that create a new exile must call this first, otherwise the new row
 * would be counted by the import and again by the live hook.
 */
export function ensureExileBackfill(guildId) {
  if (seededGuilds.has(guildId)) return 0;

  const db = getDb();
  const existing = db
    .prepare('SELECT exile_seeded_at FROM profile_meta WHERE guild_id = ?')
    .get(guildId);

  if (existing?.exile_seeded_at) {
    seededGuilds.add(guildId);
    return 0;
  }

  const now = Date.now();
  const users = new Set();

  db.exec('BEGIN');

  try {
    db.prepare(
      `INSERT INTO profile_meta (guild_id, exile_seeded_at, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET
         exile_seeded_at = excluded.exile_seeded_at,
         updated_at = excluded.updated_at`,
    ).run(guildId, now, now);

    const rows = db
      .prepare(
        `SELECT user_id, level, COUNT(*) AS total FROM exiles
          WHERE guild_id = ? GROUP BY user_id, level`,
      )
      .all(guildId);

    for (const row of rows) {
      users.add(row.user_id);

      const points = row.total * exilePointsFor(row.level);

      if (points <= 0) continue;

      upsertProfile(db, guildId, row.user_id, now);
      db.prepare(
        `UPDATE profiles
            SET punish_mini = punish_mini + ?, updated_at = ?
          WHERE guild_id = ? AND user_id = ?`,
      ).run(points, now, guildId, row.user_id);
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  seededGuilds.add(guildId);
  return users.size;
}

/** Total coins a member has earned by reaching `level` (level 1 pays nothing). */
export function coinsForLevel(level) {
  const number = Math.trunc(Number(level) || 0);
  return Math.max(0, number - 1) * COINS_PER_LEVEL;
}

/**
 * Imports the coin balance of everybody who already levelled once per guild.
 *
 * The balance is the same one level-ups would have produced: 5 coins for every
 * level above 1. `linked` (the optional `{ vex, nightmare }` maps from the
 * linked bots) is folded in so the imported level matches the card. The
 * high-water XP mark is stored too, so nobody is charged the punishment toll
 * retroactively for experience they already had.
 */
export function ensureCoinBackfill(guildId, linked = null) {
  if (coinSeededGuilds.has(guildId)) return 0;

  const db = getDb();
  const existing = db
    .prepare('SELECT coins_seeded_at FROM profile_meta WHERE guild_id = ?')
    .get(guildId);

  if (existing?.coins_seeded_at) {
    coinSeededGuilds.add(guildId);
    coinSeededCache.set(guildId, true);
    return 0;
  }

  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT user_id, nightmare, vex, coins, level_coins_paid
         FROM profiles WHERE guild_id = ?`,
    )
    .all(guildId);
  const stored = new Map(rows.map((row) => [row.user_id, row]));

  // Members without a row can still hold linked points, so they are included.
  const ids = new Set(stored.keys());

  for (const points of [linked?.vex, linked?.nightmare]) {
    for (const id of Object.keys(points ?? {})) ids.add(id);
  }

  const seeded = [];

  for (const id of ids) {
    const row = stored.get(id);

    // A row that already settled its level keeps its balance.
    if (row && row.level_coins_paid > 0) continue;

    const nightmare = (row?.nightmare ?? 0) + (linked?.nightmare?.[id] ?? 0);
    const vex = (row?.vex ?? 0) + (linked?.vex?.[id] ?? 0);
    const xp = Math.floor((nightmare + vex) / POINTS_PER_XP);

    if (!row && xp <= 0) continue;

    const level = levelFor(xp);

    seeded.push({
      id,
      coins: Math.max(Number(row?.coins) || 0, coinsForLevel(level)),
      level,
      xp,
    });
  }

  const update = db.prepare(
    `UPDATE profiles
        SET coins = ?, level_coins_paid = ?, xp_seen = ?, updated_at = ?
      WHERE guild_id = ? AND user_id = ?`,
  );

  db.exec('BEGIN');

  try {
    db.prepare(
      `INSERT INTO profile_meta (guild_id, coins_seeded_at, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET
         coins_seeded_at = excluded.coins_seeded_at,
         updated_at = excluded.updated_at`,
    ).run(guildId, now, now);

    for (const entry of seeded) {
      upsertProfile(db, guildId, entry.id, now);
      update.run(entry.coins, entry.level, entry.xp, now, guildId, entry.id);

      const previous = Number(stored.get(entry.id)?.coins) || 0;
      const delta = entry.coins - previous;

      if (delta !== 0) {
        recordCoinTransaction({
          guildId,
          userId: entry.id,
          amount: delta,
          balanceAfter: entry.coins,
          type: 'backfill',
          detail: { level: entry.level, xp: entry.xp, source: 'coin import' },
        });
      }
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  coinSeededGuilds.add(guildId);
  coinSeededCache.set(guildId, true);
  return seeded.length;
}

/** XP earned by the raw points alone, before the punishment toll. */
export function rawXpFor(profile) {
  return Math.floor((profile.nightmare + profile.vex) / POINTS_PER_XP);
}

/**
 * XP after the punishment toll. `xpPenalty` only grows when experience is
 * gained, so an old punishment never rewrites history — it makes the next
 * gains smaller.
 */
export function xpFor(profile) {
  const penalty = Math.max(0, Math.trunc(Number(profile.xpPenalty) || 0));
  return Math.max(0, rawXpFor(profile) - penalty);
}

export function levelFor(xp) {
  return Math.floor(xp / XP_PER_LEVEL) + 1;
}

/** Progress inside the current level, 0–99. */
export function progressFor(xp) {
  return xp % XP_PER_LEVEL;
}

export function displayedPunishments(profile) {
  return Math.floor(profile.punishMini / PUNISHMENT_POINTS_PER_UNIT);
}

/**
 * Works out the coin balance and the punishment toll without touching the
 * database. `stored` is a profile from `getProfile`; `linked` is the optional
 * `{ vex, nightmare }` maps from the linked bots; `seeded` says whether the
 * guild already ran the one-time import.
 *
 * Before the import has run, the first time a profile is seen its history is
 * seeded instead of charged: existing points, including linked ones, were
 * earned before the system existed. Once the import is done, a new profile has
 * no history, so its first gain is charged like any other. Every new XP
 * high-water mark pays `2 × punishments` XP, capped at the XP gained so a
 * member never goes backwards.
 */
function applySettlement(stored, linked, userId, seeded) {
  const profile = withLinkedPoints(stored, linked, userId);
  const xp = rawXpFor(profile);

  let coins = stored.coins;
  let levelCoinsPaid = stored.levelCoinsPaid;
  let xpPenalty = stored.xpPenalty;
  let xpSeen = stored.xpSeen;
  let changed = false;
  let coinDelta = 0;
  let coinType = null;
  let coinLevel = null;

  const fresh = !seeded && levelCoinsPaid <= 0 && xpSeen <= 0;

  if (xp > xpSeen) {
    if (fresh) {
      const level = levelFor(xp);
      const before = coins;

      coins = Math.max(coins, coinsForLevel(level));
      if (coins !== before) {
        coinDelta += coins - before;
        coinType = 'backfill';
        coinLevel = level;
      }

      levelCoinsPaid = level;
    } else {
      const gained = xp - xpSeen;
      const toll = Math.min(
        gained,
        displayedPunishments(profile) * XP_PENALTY_PER_PUNISHMENT,
      );

      if (toll > 0) xpPenalty += toll;
    }

    xpSeen = xp;
    changed = true;
  }

  const level = levelFor(Math.max(0, xp - xpPenalty));

  if (level > levelCoinsPaid) {
    const before = coins;

    coins += Math.max(0, level - Math.max(levelCoinsPaid, 1)) * COINS_PER_LEVEL;
    if (coins !== before) {
      coinDelta += coins - before;
      if (!coinType) coinType = 'earn';
      coinLevel = level;
    }

    levelCoinsPaid = level;
    changed = true;
  }

  if (!changed) {
    return { profile: stored, changed: false, coinDelta: 0, coinType: null, coinLevel: null };
  }

  return {
    profile: { ...stored, coins, levelCoinsPaid, xpPenalty, xpSeen },
    changed: true,
    coinDelta,
    coinType,
    coinLevel,
  };
}

function writeSettlement(db, guildId, userId, profile, now) {
  upsertProfile(db, guildId, userId, now);
  db.prepare(
    `UPDATE profiles
        SET coins = ?, level_coins_paid = ?, xp_penalty = ?, xp_seen = ?,
            updated_at = ?
      WHERE guild_id = ? AND user_id = ?`,
  ).run(
    profile.coins,
    profile.levelCoinsPaid,
    profile.xpPenalty,
    profile.xpSeen,
    now,
    guildId,
    userId,
  );
}

/** Settles one member and stores the result. Never throws into a card render. */
export function settleProfile(guildId, userId, linked = null) {
  const stored = getProfile(guildId, userId);
  const settled = applySettlement(stored, linked, userId, coinsSeeded(guildId));

  if (!settled.changed) return stored;

  try {
    const db = getDb();
    const now = Date.now();

    db.exec('BEGIN');

    try {
      writeSettlement(db, guildId, userId, settled.profile, now);

      if (settled.coinDelta) {
        recordCoinTransaction({
          guildId,
          userId,
          amount: settled.coinDelta,
          balanceAfter: settled.profile.coins,
          type: settled.coinType ?? 'earn',
          detail: {
            level: settled.coinLevel ?? null,
            xp: settled.profile.xpSeen,
          },
        });
      }

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    logger.warn(`Could not settle coins for ${userId}: ${error.message}`);
  }

  return { ...settled.profile };
}

/**
 * Points another bot adds on top of the stored ones:
 * `{ vex, nightmare }` maps of userId → points (either may be missing).
 */
function linkedScore(linked, userId) {
  return (linked?.vex?.[userId] ?? 0) + (linked?.nightmare?.[userId] ?? 0);
}

/** Stored points plus whatever the linked bots currently report. */
function withLinkedPoints(profile, linked, userId) {
  return {
    ...profile,
    vex: profile.vex + (linked?.vex?.[userId] ?? 0),
    nightmare: profile.nightmare + (linked?.nightmare?.[userId] ?? 0),
  };
}

/**
 * The member's level only, for commands that do not need the card or the rank.
 * Linked points count here exactly as they do on the card.
 */
export function profileLevel(guildId, userId, linked = null) {
  const settled = settleProfile(guildId, userId, linked);
  return levelFor(xpFor(withLinkedPoints(settled, linked, userId)));
}

/**
 * Every current member with points, ordered for `/rank`: level descending,
 * then total points descending. Members without a profile row are included when
 * the linked bots report points for them, and members who left are skipped.
 *
 * `linked` is the optional `{ vex, nightmare }` map from E Bot 1 and Al-Kabus,
 * added on top of the stored points exactly as the profile card does.
 */
export function rankedProfiles(guildId, memberIds, linked = null) {
  const present = new Set(memberIds);
  const local = new Map(
    getDb()
      .prepare(
        `SELECT title, user_id, nightmare, vex, punish_mini, good_behavior,
                show_birthday, background, coins, level_coins_paid, xp_penalty,
                xp_seen, created_at, updated_at
           FROM profiles WHERE guild_id = ?`,
      )
      .all(guildId)
      .map((row) => [row.user_id, toProfile(row)]),
  );

  const ids = new Set(local.keys());

  for (const points of [linked?.vex, linked?.nightmare]) {
    for (const id of Object.keys(points ?? {})) ids.add(id);
  }

  const rows = [];
  const pending = new Map();
  const seeded = coinsSeeded(guildId);

  for (const id of ids) {
    if (!present.has(id)) continue;

    const settled = applySettlement(
      local.get(id) ?? { ...EMPTY_PROFILE },
      linked,
      id,
      seeded,
    );

    if (settled.changed) pending.set(id, settled.profile);

    const profile = withLinkedPoints(settled.profile, linked, id);
    const score = profile.nightmare + profile.vex;

    // A zero-score member is level 1 with nothing to show; the card gives them
    // no rank either, so they stay out of the list.
    if (score <= 0) continue;

    const xp = xpFor(profile);

    rows.push({
      userId: id,
      nightmare: profile.nightmare,
      vex: profile.vex,
      coins: profile.coins,
      score,
      level: levelFor(xp),
      progress: progressFor(xp),
    });
  }

  if (pending.size > 0) {
    const db = getDb();
    const now = Date.now();

    db.exec('BEGIN');

    try {
      for (const [id, profile] of pending) {
        writeSettlement(db, guildId, id, profile, now);
      }

      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      logger.warn(`Could not settle the rank page: ${error.message}`);
    }
  }

  rows.sort(
    (a, b) => b.level - a.level || b.score - a.score || a.userId.localeCompare(b.userId),
  );

  return rows;
}

/**
 * Rank by nightmare + vex among the members who are still in the server. Ties
 * share a rank (there is no tie-breaker), and a score of zero has no rank at
 * all — the card leaves that field empty.
 *
 * `linked` (optional) is `{ vex, nightmare }` from the linked bots (E Bot 1
 * and Al-Kabus); when given, every member's score includes them so the
 * ranking matches the numbers on the cards.
 */
export function rankFor(guildId, userId, memberIds, score, linked = null) {
  if (!score) return null;

  const present = new Set(memberIds);

  // Members who left keep their points, but they are not in the ranking.
  if (!present.has(userId)) return null;

  // Without linked bots the query can stay in SQL.
  if (!linked?.vex && !linked?.nightmare) {
    const higher = getDb()
      .prepare(
        `SELECT user_id FROM profiles
          WHERE guild_id = ? AND (nightmare + vex) > ?`,
      )
      .all(guildId, score);

    let above = 0;

    for (const row of higher) {
      if (present.has(row.user_id)) above += 1;
    }

    return above + 1;
  }

  const local = new Map(
    getDb()
      .prepare(`SELECT user_id, nightmare + vex AS score FROM profiles WHERE guild_id = ?`)
      .all(guildId)
      .map((row) => [row.user_id, Number(row.score) || 0]),
  );

  let above = 0;

  for (const id of present) {
    if (id === userId) continue;
    if ((local.get(id) ?? 0) + linkedScore(linked, id) > score) above += 1;
  }

  return above + 1;
}

/**
 * Everything the card needs for one member. `linked` is the optional
 * `{ vex, nightmare }` from E Bot 1 and Al-Kabus, added on top of what staff
 * entered.
 */
export function profileStats(guildId, userId, memberIds, linked = null) {
  const settled = settleProfile(guildId, userId, linked);
  const profile = withLinkedPoints(settled, linked, userId);
  const score = profile.nightmare + profile.vex;
  const xp = xpFor(profile);

  return {
    ...profile,
    score,
    xp,
    level: levelFor(xp),
    progress: progressFor(xp),
    punishments: displayedPunishments(profile),
    rank: rankFor(guildId, userId, memberIds, score, linked),
  };
}
