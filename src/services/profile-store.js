import { getDb } from '../lib/db.js';
import { createLogger } from '../lib/logger.js';

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

export const MAX_TITLE_LENGTH = 32;

const EMPTY_PROFILE = Object.freeze({
  title: null,
  nightmare: 0,
  vex: 0,
  punishMini: 0,
  goodBehavior: 0,
  showBirthday: true,
  background: null,
  createdAt: null,
  updatedAt: null,
});

// Seeding the exile history is a one-time import per guild. Caching the answer
// keeps the common path (a mute, a profile view) from touching the meta table.
const seededGuilds = new Set();

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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A missing row reads as zeroes, so the card never needs a write to render. */
export function getProfile(guildId, userId) {
  const row = getDb()
    .prepare(
      `SELECT title, nightmare, vex, punish_mini, good_behavior, show_birthday,
              background, created_at, updated_at
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
  { nightmare = 0, vex = 0, punishMini = 0, goodBehavior = 0 } = {},
) {
  const deltas = {
    nightmare: Math.trunc(Number(nightmare) || 0),
    vex: Math.trunc(Number(vex) || 0),
    punish_mini: Math.trunc(Number(punishMini) || 0),
    good_behavior: Math.trunc(Number(goodBehavior) || 0),
  };

  const db = getDb();
  const now = Date.now();

  db.exec('BEGIN');

  try {
    upsertProfile(db, guildId, userId, now);

    db.prepare(
      `UPDATE profiles
          SET nightmare = MAX(0, nightmare + ?),
              vex = MAX(0, vex + ?),
              punish_mini = MAX(0, punish_mini + ?),
              good_behavior = MAX(0, good_behavior + ?),
              updated_at = ?
        WHERE guild_id = ? AND user_id = ?`,
    ).run(
      deltas.nightmare,
      deltas.vex,
      deltas.punish_mini,
      deltas.good_behavior,
      now,
      guildId,
      userId,
    );

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return getProfile(guildId, userId);
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

export function xpFor(profile) {
  return Math.floor((profile.nightmare + profile.vex) / POINTS_PER_XP);
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
  return levelFor(xpFor(withLinkedPoints(getProfile(guildId, userId), linked, userId)));
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
      .prepare('SELECT user_id, nightmare, vex FROM profiles WHERE guild_id = ?')
      .all(guildId)
      .map((row) => [
        row.user_id,
        { nightmare: Number(row.nightmare) || 0, vex: Number(row.vex) || 0 },
      ]),
  );

  const ids = new Set(local.keys());

  for (const points of [linked?.vex, linked?.nightmare]) {
    for (const id of Object.keys(points ?? {})) ids.add(id);
  }

  const rows = [];

  for (const id of ids) {
    if (!present.has(id)) continue;

    const stored = local.get(id);
    const nightmare = (stored?.nightmare ?? 0) + (linked?.nightmare?.[id] ?? 0);
    const vex = (stored?.vex ?? 0) + (linked?.vex?.[id] ?? 0);
    const score = nightmare + vex;

    // A zero-score member is level 1 with nothing to show; the card gives them
    // no rank either, so they stay out of the list.
    if (score <= 0) continue;

    const xp = xpFor({ nightmare, vex });

    rows.push({
      userId: id,
      nightmare,
      vex,
      score,
      level: levelFor(xp),
      progress: progressFor(xp),
    });
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
  const stored = getProfile(guildId, userId);
  const profile = withLinkedPoints(stored, linked, userId);
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
