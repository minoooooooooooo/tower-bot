import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger } from './logger.js';
import { normalizeForMatch } from './text.js';

const logger = createLogger('db');

let database = null;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS birthdays (
    guild_id   TEXT    NOT NULL,
    user_id    TEXT    NOT NULL,
    month      INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
    day        INTEGER NOT NULL CHECK (day BETWEEN 1 AND 31),
    year       INTEGER,
    timezone   TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_birthdays_month
    ON birthdays (guild_id, month);

  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id            TEXT PRIMARY KEY,
    birthday_role_id    TEXT,
    timezone            TEXT,
    birthday_channel_id TEXT,
    birthday_message    TEXT,
    birthday_gif_url    TEXT,
    updated_at          INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS birthday_assignments (
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    role_id  TEXT NOT NULL,
    date_key TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );

  -- One row per member per day, so a restart never posts a second greeting.
  CREATE TABLE IF NOT EXISTS birthday_greetings (
    guild_id   TEXT    NOT NULL,
    user_id    TEXT    NOT NULL,
    date_key   TEXT    NOT NULL,
    channel_id TEXT    NOT NULL,
    sent_at    INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id, date_key)
  );

  CREATE TABLE IF NOT EXISTS welcome_settings (
    guild_id           TEXT PRIMARY KEY,
    channel_id         TEXT,
    rules_channel_id   TEXT,
    general_channel_id TEXT,
    mode               TEXT,
    forced_style       TEXT,
    enabled            TEXT,
    last_style         TEXT,
    gif_url            TEXT,
    updated_at         INTEGER NOT NULL
  );

  -- Only edited pieces are stored; anything missing falls back to the style's
  -- default text in welcome-styles.js.
  CREATE TABLE IF NOT EXISTS welcome_texts (
    guild_id TEXT NOT NULL,
    style    TEXT NOT NULL,
    piece    TEXT NOT NULL,
    value    TEXT NOT NULL,
    PRIMARY KEY (guild_id, style, piece)
  );

  -- One optional GIF per card style.
  CREATE TABLE IF NOT EXISTS welcome_gifs (
    guild_id TEXT NOT NULL,
    style    TEXT NOT NULL,
    url      TEXT NOT NULL,
    PRIMARY KEY (guild_id, style)
  );

  -- The channel that receives summaries (the "management" room). The channel
  -- being summarized is a command option, never this one.
  CREATE TABLE IF NOT EXISTS summary_settings (
    guild_id   TEXT PRIMARY KEY,
    channel_id TEXT,
    updated_at INTEGER NOT NULL
  );

  -- Every generated report, with the exact range it covered, so a PDF/HTML
  -- export can be regenerated later without calling the model again.
  CREATE TABLE IF NOT EXISTS summaries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id      TEXT    NOT NULL,
    channel_id    TEXT    NOT NULL,
    kind          TEXT    NOT NULL,
    prompt        TEXT,
    range_start   INTEGER NOT NULL,
    range_end     INTEGER NOT NULL,
    message_count INTEGER NOT NULL,
    body          TEXT    NOT NULL,
    created_by    TEXT    NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_summaries_guild
    ON summaries (guild_id, created_at DESC);

  -- Server-wide keyword alerts. One shared list per guild; every alert is
  -- posted to the channel in watch_settings instead of being DMed to whoever
  -- added the term. created_by only records who added it.
  CREATE TABLE IF NOT EXISTS watch_terms (
    guild_id   TEXT    NOT NULL,
    term       TEXT    NOT NULL,
    created_by TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, term)
  );

  CREATE TABLE IF NOT EXISTS watch_settings (
    guild_id   TEXT PRIMARY KEY,
    channel_id TEXT,
    updated_at INTEGER NOT NULL
  );

  -- Channels and categories where keyword alerts must stay quiet. A category id
  -- also covers every channel underneath it.
  CREATE TABLE IF NOT EXISTS watch_ignored_channels (
    guild_id   TEXT    NOT NULL,
    channel_id TEXT    NOT NULL,
    created_by TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
  );

  -- Server jargon handed to the model so summaries use the right vocabulary.
  CREATE TABLE IF NOT EXISTS glossary (
    guild_id   TEXT NOT NULL,
    term       TEXT NOT NULL,
    meaning    TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, term)
  );

  -- Recurring reports, one row per channel. mode is 'interval' or 'daily';
  -- interval_ms or minute_of_day carries the cadence. last_run_at is both the
  -- window start for the next report and the "already ran" marker.
  CREATE TABLE IF NOT EXISTS summary_schedules (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id      TEXT    NOT NULL,
    channel_id    TEXT    NOT NULL,
    kind          TEXT    NOT NULL,
    prompt        TEXT,
    mode          TEXT    NOT NULL,
    interval_ms   INTEGER,
    minute_of_day INTEGER,
    enabled       INTEGER NOT NULL DEFAULT 1,
    last_run_at   INTEGER,
    created_by    TEXT    NOT NULL,
    created_at    INTEGER NOT NULL,
    UNIQUE (guild_id, channel_id)
  );

  -- Per-server shortcuts: a message whose first word is the trigger runs the
  -- named command with the rest of the message as arguments, so typing
  -- مسح 100 behaves like the prefixed clear command. trigger is the
  -- normalized form; label keeps what the admin typed so the list reads
  -- naturally.
  CREATE TABLE IF NOT EXISTS command_aliases (
    guild_id   TEXT    NOT NULL,
    trigger    TEXT    NOT NULL,
    label      TEXT    NOT NULL,
    command    TEXT    NOT NULL,
    created_by TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    channel_mode TEXT,
    PRIMARY KEY (guild_id, trigger)
  );

  -- Channels where an alias is allowed (mode 'allow') or blocked (mode 'deny').
  -- An empty list with a NULL mode means "everywhere".
  CREATE TABLE IF NOT EXISTS command_alias_channels (
    guild_id   TEXT NOT NULL,
    trigger    TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, trigger, channel_id)
  );

  -- Where exile actions are reported. Kept separate from the exile roles so the
  -- log survives re-running setup or remapping a level.
  CREATE TABLE IF NOT EXISTS exile_settings (
    guild_id       TEXT PRIMARY KEY,
    log_channel_id TEXT,
    updated_at     INTEGER NOT NULL
  );

  -- A role is "set up" once its channel rules have been applied. This is a
  -- separate table because a setup with no exceptions stores no channel rows,
  -- and "no rows" must not be read as "never configured".
  CREATE TABLE IF NOT EXISTS exile_setups (
    guild_id      TEXT    NOT NULL,
    role_id       TEXT    NOT NULL,
    configured_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, role_id)
  );

  -- One role per level: 'main', '1' … '10'.
  CREATE TABLE IF NOT EXISTS exile_roles (
    guild_id   TEXT    NOT NULL,
    level      TEXT    NOT NULL,
    role_id    TEXT    NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, level)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_exile_roles_role
    ON exile_roles (guild_id, role_id);

  -- Channels that stay visible for one role. Per role, so every level can have
  -- its own exception list.
  CREATE TABLE IF NOT EXISTS exile_channels (
    guild_id   TEXT NOT NULL,
    role_id    TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    PRIMARY KEY (guild_id, role_id, channel_id)
  );

  -- Active exiles (released_at IS NULL) plus their release record for the
  -- audit trail. The partial unique index allows a member to be exiled again
  -- after being released, but never twice at once.
  CREATE TABLE IF NOT EXISTS exiles (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id       TEXT    NOT NULL,
    user_id        TEXT    NOT NULL,
    level          TEXT    NOT NULL,
    role_id        TEXT    NOT NULL,
    reason         TEXT,
    created_by     TEXT    NOT NULL,
    created_at     INTEGER NOT NULL,
    released_by    TEXT,
    released_at    INTEGER,
    release_reason TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_exiles_guild
    ON exiles (guild_id, released_at, created_at DESC);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_exiles_one_active
    ON exiles (guild_id, user_id) WHERE released_at IS NULL;

  -- Roles allowed to run one command despite missing the Discord permission the
  -- command normally requires. Grants never bypass hierarchy checks inside the
  -- command itself.
  CREATE TABLE IF NOT EXISTS command_permissions (
    guild_id   TEXT    NOT NULL,
    command    TEXT    NOT NULL,
    role_id    TEXT    NOT NULL,
    created_by TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, command, role_id)
  );

  -- The role used for /mute. Stored so renaming it does not break unmute.
  -- The "configured" flag records whether the channel overwrites have been
  -- written, so adopting a hand-made Muted role still gets muted once, without
  -- re-editing every channel on every mute.
  CREATE TABLE IF NOT EXISTS mute_settings (
    guild_id    TEXT PRIMARY KEY,
    role_id     TEXT,
    configured  INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL
  );

  -- Temporary mutes and bans. The scheduler removes the role/ban when
  -- expires_at passes, so a restart cannot lose the expiry.
  CREATE TABLE IF NOT EXISTS moderation_expiries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT    NOT NULL,
    user_id    TEXT    NOT NULL,
    kind       TEXT    NOT NULL,
    role_id    TEXT,
    reason     TEXT,
    created_by TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_moderation_expiries_once
    ON moderation_expiries (guild_id, user_id, kind);

  CREATE INDEX IF NOT EXISTS idx_moderation_expiries_due
    ON moderation_expiries (expires_at);

  -- Activity totals per member. Live tracking starts when the bot first sees
  -- the server; older messages can be imported once with /backfill.
  CREATE TABLE IF NOT EXISTS activity_members (
    guild_id         TEXT    NOT NULL,
    user_id          TEXT    NOT NULL,
    messages         INTEGER NOT NULL DEFAULT 0,
    voice_seconds    INTEGER NOT NULL DEFAULT 0,
    first_message_at INTEGER,
    last_message_at  INTEGER,
    last_active_at   INTEGER,
    PRIMARY KEY (guild_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_activity_members_messages
    ON activity_members (guild_id, messages DESC);

  CREATE INDEX IF NOT EXISTS idx_activity_members_voice
    ON activity_members (guild_id, voice_seconds DESC);

  -- Per-channel totals. Thread messages are counted under their parent
  -- channel, so "most active channels" stays readable.
  CREATE TABLE IF NOT EXISTS activity_channels (
    guild_id        TEXT    NOT NULL,
    channel_id      TEXT    NOT NULL,
    messages        INTEGER NOT NULL DEFAULT 0,
    voice_seconds   INTEGER NOT NULL DEFAULT 0,
    last_message_at INTEGER,
    PRIMARY KEY (guild_id, channel_id)
  );

  -- Daily buckets power the 7d/30d leaderboards without losing all-time
  -- totals. day is YYYY-MM-DD in the bot's TIMEZONE.
  CREATE TABLE IF NOT EXISTS activity_member_days (
    guild_id      TEXT    NOT NULL,
    user_id       TEXT    NOT NULL,
    day           TEXT    NOT NULL,
    messages      INTEGER NOT NULL DEFAULT 0,
    voice_seconds INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id, day)
  );

  CREATE INDEX IF NOT EXISTS idx_activity_member_days_lookup
    ON activity_member_days (guild_id, day);

  CREATE TABLE IF NOT EXISTS activity_channel_days (
    guild_id      TEXT    NOT NULL,
    channel_id    TEXT    NOT NULL,
    day           TEXT    NOT NULL,
    messages      INTEGER NOT NULL DEFAULT 0,
    voice_seconds INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, channel_id, day)
  );

  CREATE INDEX IF NOT EXISTS idx_activity_channel_days_lookup
    ON activity_channel_days (guild_id, day);

  -- One open voice session per member. joined_at survives restarts; a
  -- last_seen_at heartbeat bounds how much time a crash can overcount.
  CREATE TABLE IF NOT EXISTS activity_voice_sessions (
    guild_id     TEXT    NOT NULL,
    user_id      TEXT    NOT NULL,
    channel_id   TEXT    NOT NULL,
    joined_at    INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );

  -- When tracking started, so the commands can say how complete the numbers
  -- are instead of implying they cover the server's whole history. messages_since
  -- moves back when older history is imported; voice_since stays at the live
  -- start because Discord cannot replay voice sessions.
  CREATE TABLE IF NOT EXISTS activity_meta (
    guild_id       TEXT PRIMARY KEY,
    tracking_since INTEGER NOT NULL,
    messages_since INTEGER,
    voice_since    INTEGER,
    updated_at     INTEGER NOT NULL
  );

  -- Resumable message backfill. One row per channel, with the oldest message id
  -- fetched so far. A restart resumes from the cursor instead of re-reading the
  -- whole channel, and the counters let /backfill status say how far it got.
  CREATE TABLE IF NOT EXISTS activity_backfill (
    guild_id   TEXT    NOT NULL,
    channel_id TEXT    NOT NULL,
    cursor_id  TEXT,
    oldest_at  INTEGER,
    done       INTEGER NOT NULL DEFAULT 0,
    fetched    INTEGER NOT NULL DEFAULT 0,
    error      TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
  );

  -- The numbers on a member's profile card. nightmare and vex are entered by
  -- staff and add up to XP; punish_mini counts raw punishment points so the
  -- card can show floor(punish_mini / 7) without losing the remainder.
  CREATE TABLE IF NOT EXISTS profiles (
    guild_id     TEXT    NOT NULL,
    user_id      TEXT    NOT NULL,
    title        TEXT,
    nightmare    INTEGER NOT NULL DEFAULT 0,
    vex          INTEGER NOT NULL DEFAULT 0,
    punish_mini  INTEGER NOT NULL DEFAULT 0,
    good_behavior INTEGER NOT NULL DEFAULT 0,
    show_birthday INTEGER NOT NULL DEFAULT 1,
    background   TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );

  -- One row per guild, so one-time imports (the exile history) never run twice.
  CREATE TABLE IF NOT EXISTS profile_meta (
    guild_id        TEXT PRIMARY KEY,
    exile_seeded_at INTEGER,
    updated_at      INTEGER NOT NULL
  );

  -- Dry-run counterpart to activity_backfill. It walks the same channels but
  -- only counts what it sees, so the totals can be checked without writing.
  CREATE TABLE IF NOT EXISTS activity_backfill_audit (
    guild_id   TEXT    NOT NULL,
    channel_id TEXT    NOT NULL,
    cursor_id  TEXT,
    oldest_at  INTEGER,
    done       INTEGER NOT NULL DEFAULT 0,
    seen       INTEGER NOT NULL DEFAULT 0,
    bots       INTEGER NOT NULL DEFAULT 0,
    system     INTEGER NOT NULL DEFAULT 0,
    newer      INTEGER NOT NULL DEFAULT 0,
    human      INTEGER NOT NULL DEFAULT 0,
    error      TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
  );

  -- Custom emoji usage per guild/emoji/day. A message made only of emoji
  -- increments standalone_count; an emoji inside ordinary text increments
  -- inline_count. The leaderboard adds both, so the split stays visible.
  CREATE TABLE IF NOT EXISTS emoji_usage (
    guild_id         TEXT    NOT NULL,
    emoji_id         TEXT    NOT NULL,
    day              TEXT    NOT NULL,
    inline_count     INTEGER NOT NULL DEFAULT 0,
    standalone_count INTEGER NOT NULL DEFAULT 0,
    last_used_at     INTEGER NOT NULL,
    PRIMARY KEY (guild_id, emoji_id, day)
  );

  CREATE INDEX IF NOT EXISTS idx_emoji_usage_day
    ON emoji_usage (guild_id, day);

  -- Latest known name/animation for an emoji, kept apart from the daily rows so
  -- a rename does not rewrite history and a deleted emoji still has a label.
  CREATE TABLE IF NOT EXISTS emoji_catalog (
    guild_id      TEXT    NOT NULL,
    emoji_id      TEXT    NOT NULL,
    emoji_name    TEXT    NOT NULL,
    animated      INTEGER NOT NULL DEFAULT 0,
    first_seen_at INTEGER NOT NULL,
    last_used_at  INTEGER NOT NULL,
    PRIMARY KEY (guild_id, emoji_id)
  );

  -- Emoji counting may start long after activity tracking, so it keeps its own
  -- live boundary. Backfill only reads older messages, which keeps live and
  -- imported counts from overlapping.
  CREATE TABLE IF NOT EXISTS emoji_meta (
    guild_id         TEXT PRIMARY KEY,
    tracking_since   INTEGER NOT NULL,
    backfilled_since INTEGER,
    updated_at       INTEGER NOT NULL
  );

  -- Resumable emoji-history import, one row per channel, separate from
  -- activity_backfill because the cursors and boundaries are independent.
  CREATE TABLE IF NOT EXISTS emoji_backfill (
    guild_id   TEXT    NOT NULL,
    channel_id TEXT    NOT NULL,
    cursor_id  TEXT,
    oldest_at  INTEGER,
    done       INTEGER NOT NULL DEFAULT 0,
    fetched    INTEGER NOT NULL DEFAULT 0,
    emoji_uses INTEGER NOT NULL DEFAULT 0,
    error      TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
  );

  -- Shared ticket settings: one customizable panel and the transcript log.
  CREATE TABLE IF NOT EXISTS ticket_settings (
    guild_id          TEXT PRIMARY KEY,
    log_channel_id    TEXT,
    panel_channel_id  TEXT,
    panel_message_id  TEXT,
    panel_title       TEXT,
    panel_description TEXT,
    panel_color       INTEGER,
    panel_footer      TEXT,
    panel_image       TEXT,
    panel_thumbnail   TEXT,
    legacy_cleared    INTEGER NOT NULL DEFAULT 0,
    panels_migrated   INTEGER NOT NULL DEFAULT 0,
    updated_at        INTEGER NOT NULL
  );

  -- Named ticket panels. Each panel is its own embed/message and owns the
  -- buttons assigned to it, so a server can post several separate panels.
  CREATE TABLE IF NOT EXISTS ticket_panels (
    guild_id    TEXT    NOT NULL,
    key         TEXT    NOT NULL,
    label       TEXT    NOT NULL,
    channel_id  TEXT,
    message_id  TEXT,
    title       TEXT,
    description TEXT,
    color       INTEGER,
    footer      TEXT,
    image       TEXT,
    thumbnail   TEXT,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (guild_id, key)
  );

  CREATE INDEX IF NOT EXISTS idx_ticket_panels_order
    ON ticket_panels (guild_id, position, key);

  -- One row per panel button. Each button chooses its panel, category, ping
  -- roles, welcome text, channel-name template and button appearance.
  CREATE TABLE IF NOT EXISTS ticket_types (
    guild_id         TEXT    NOT NULL,
    key              TEXT    NOT NULL,
    label            TEXT    NOT NULL,
    emoji            TEXT,
    panel_key        TEXT    NOT NULL DEFAULT 'main',
    category_id      TEXT,
    closed_category_id TEXT,
    support_role_ids TEXT,
    ping_role_ids    TEXT,
    log_channel_id   TEXT,
    welcome_message  TEXT,
    name_template    TEXT,
    max_open         INTEGER NOT NULL DEFAULT 1,
    number_start     INTEGER NOT NULL DEFAULT 0,
    color            INTEGER,
    close_action     TEXT    NOT NULL DEFAULT 'delete',
    position         INTEGER NOT NULL DEFAULT 0,
    button_label     TEXT,
    button_style     TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    PRIMARY KEY (guild_id, key)
  );

  CREATE INDEX IF NOT EXISTS idx_ticket_types_order
    ON ticket_types (guild_id, position, key);

  -- One row per ticket. The channel id is how buttons and commands find the
  -- owning ticket after a restart; status is open, closed (archived) or deleted.
  -- Numbers are unique per button, not per guild: two buttons may both hand out
  -- #1 because each has its own counter (see ticket_types.number_start).
  CREATE TABLE IF NOT EXISTS tickets (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id              TEXT    NOT NULL,
    channel_id            TEXT,
    number                INTEGER NOT NULL,
    type_key              TEXT    NOT NULL,
    opener_id             TEXT    NOT NULL,
    opener_tag            TEXT,
    status                TEXT    NOT NULL DEFAULT 'open',
    claimed_by            TEXT,
    created_at            INTEGER NOT NULL,
    closed_by             TEXT,
    closed_at             INTEGER,
    close_reason          TEXT,
    transcript_message_id TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_tickets_channel
    ON tickets (guild_id, channel_id);

  CREATE INDEX IF NOT EXISTS idx_tickets_status
    ON tickets (guild_id, status, created_at DESC);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_number
    ON tickets (guild_id, type_key, number);
`;

// Columns added after the first release. `CREATE TABLE IF NOT EXISTS` does not
// touch existing tables, so they are applied with ALTER TABLE on startup.
const COLUMN_MIGRATIONS = [
  ['guild_settings', 'birthday_channel_id', 'TEXT'],
  ['guild_settings', 'birthday_message', 'TEXT'],
  ['guild_settings', 'birthday_gif_url', 'TEXT'],
  ['birthdays', 'timezone', 'TEXT'],
  ['welcome_settings', 'gif_url', 'TEXT'],
  ['activity_meta', 'messages_since', 'INTEGER'],
  ['activity_meta', 'voice_since', 'INTEGER'],
  ['ticket_settings', 'panel_channel_id', 'TEXT'],
  ['ticket_settings', 'panel_message_id', 'TEXT'],
  ['ticket_settings', 'panel_title', 'TEXT'],
  ['ticket_settings', 'panel_description', 'TEXT'],
  ['ticket_settings', 'panel_color', 'INTEGER'],
  ['ticket_settings', 'panel_footer', 'TEXT'],
  ['ticket_settings', 'panel_image', 'TEXT'],
  ['ticket_settings', 'panel_thumbnail', 'TEXT'],
  ['ticket_settings', 'legacy_cleared', 'INTEGER NOT NULL DEFAULT 0'],
  ['ticket_settings', 'panels_migrated', 'INTEGER NOT NULL DEFAULT 0'],
  ['ticket_types', 'button_label', 'TEXT'],
  ['ticket_types', 'button_style', 'TEXT'],
  ['ticket_types', 'panel_key', "TEXT NOT NULL DEFAULT 'main'"],
  ['ticket_types', 'number_start', 'INTEGER NOT NULL DEFAULT 0'],
  ['ticket_types', 'closed_category_id', 'TEXT'],
  ['command_aliases', 'channel_mode', 'TEXT'],
  ['profiles', 'show_birthday', 'INTEGER NOT NULL DEFAULT 1'],
  ['profiles', 'background', 'TEXT'],
];

function applyMigrations(db) {
  for (const [table, column, type] of COLUMN_MIGRATIONS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();

    if (columns.some((entry) => entry.name === column)) continue;

    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    logger.info(`Migrated SQLite: added ${table}.${column}`);
  }
}

/**
 * Keyword alerts moved from per-member DMs to one shared list posted in one
 * channel. The first table keyed every term by `user_id`, so it is rebuilt
 * once: duplicate words are merged (the earliest add wins) and nothing else is
 * carried over, because the old `broken` flag described a DM that no longer
 * exists.
 */
function migrateWatchTerms(db) {
  const columns = db.prepare('PRAGMA table_info(watch_terms)').all();

  if (columns.length === 0) return;
  if (!columns.some((entry) => entry.name === 'user_id')) return;

  const rows = db
    .prepare('SELECT guild_id, user_id, term, created_at FROM watch_terms ORDER BY created_at ASC, id ASC')
    .all();

  db.exec('BEGIN');

  try {
    db.exec(`
      CREATE TABLE watch_terms_v2 (
        guild_id   TEXT    NOT NULL,
        term       TEXT    NOT NULL,
        created_by TEXT    NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, term)
      )
    `);

    const insert = db.prepare(
      'INSERT INTO watch_terms_v2 (guild_id, term, created_by, created_at) VALUES (?, ?, ?, ?)',
    );
    const seen = new Set();
    let merged = 0;

    // Deduplicate the way the matcher compares terms: `Leak`, `leak` and
    // `مُحَمّد`/`محمد` are one word. The earliest add wins, so the spelling and
    // author that started the watch are the ones kept.
    for (const row of rows) {
      const key = `${row.guild_id}\u0000${normalizeForMatch(row.term)}`;

      if (seen.has(key)) {
        merged += 1;
        continue;
      }

      seen.add(key);
      insert.run(row.guild_id, row.term, row.user_id, row.created_at);
    }

    db.exec('DROP TABLE watch_terms');
    db.exec('ALTER TABLE watch_terms_v2 RENAME TO watch_terms');
    db.exec('COMMIT');

    logger.info(
      `Migrated SQLite: watch_terms is now shared per guild (${rows.length} row(s), ${merged} merged)`,
    );
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * The first welcome GIF lived in `welcome_settings.gif_url` and only Classic
 * used it. Per-style GIFs moved to `welcome_gifs`, so the old value is carried
 * over once and the column blanked — otherwise "reset" would resurrect it.
 */
function migrateLegacyWelcomeGifs(db) {
  const columns = db.prepare('PRAGMA table_info(welcome_settings)').all();

  if (!columns.some((entry) => entry.name === 'gif_url')) return;

  const rows = db
    .prepare('SELECT guild_id, gif_url FROM welcome_settings WHERE gif_url IS NOT NULL')
    .all();

  if (rows.length === 0) return;

  const insert = db.prepare(
    `INSERT INTO welcome_gifs (guild_id, style, url) VALUES (?, 'classic', ?)
     ON CONFLICT (guild_id, style) DO NOTHING`,
  );
  const clear = db.prepare('UPDATE welcome_settings SET gif_url = NULL WHERE guild_id = ?');

  for (const row of rows) {
    insert.run(row.guild_id, row.gif_url);
    clear.run(row.guild_id);
  }

  logger.info(`Migrated SQLite: moved ${rows.length} welcome GIF(s) into welcome_gifs`);
}

/**
 * Ticket numbers used to be unique per guild (`UNIQUE (guild_id, number)`), from
 * when every button shared one counter. Buttons now count on their own, so two
 * buttons legitimately hand out the same number and the old constraint aborted
 * the insert *after* the channel was created. Rebuild the table once: SQLite
 * cannot drop a table-level constraint in place.
 */
function migrateTicketNumberScope(db) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tickets'")
    .get();

  if (!row?.sql || !/UNIQUE\s*\(\s*guild_id\s*,\s*number\s*\)/i.test(row.sql)) return;

  db.exec('BEGIN');

  try {
    db.exec(`
      CREATE TABLE tickets_v2 (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id              TEXT    NOT NULL,
        channel_id            TEXT,
        number                INTEGER NOT NULL,
        type_key              TEXT    NOT NULL,
        opener_id             TEXT    NOT NULL,
        opener_tag            TEXT,
        status                TEXT    NOT NULL DEFAULT 'open',
        claimed_by            TEXT,
        created_at            INTEGER NOT NULL,
        closed_by             TEXT,
        closed_at             INTEGER,
        close_reason          TEXT,
        transcript_message_id TEXT
      );

      INSERT INTO tickets_v2
        (id, guild_id, channel_id, number, type_key, opener_id, opener_tag,
         status, claimed_by, created_at, closed_by, closed_at, close_reason,
         transcript_message_id)
      SELECT
         id, guild_id, channel_id, number, type_key, opener_id, opener_tag,
         status, claimed_by, created_at, closed_by, closed_at, close_reason,
         transcript_message_id
      FROM tickets;

      DROP TABLE tickets;
      ALTER TABLE tickets_v2 RENAME TO tickets;

      CREATE INDEX IF NOT EXISTS idx_tickets_channel
        ON tickets (guild_id, channel_id);
      CREATE INDEX IF NOT EXISTS idx_tickets_status
        ON tickets (guild_id, status, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_number
        ON tickets (guild_id, type_key, number);
    `);

    db.exec('COMMIT');
    logger.info('Migrated SQLite: ticket numbers are now unique per button');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Older builds only stored `tracking_since`. Seed the two coverage dates so
 * commands can read them unconditionally; a completed backfill moves
 * `messages_since` further back later.
 */
function migrateActivitySince(db) {
  const result = db
    .prepare(
      `UPDATE activity_meta
       SET messages_since = COALESCE(messages_since, tracking_since),
           voice_since = COALESCE(voice_since, tracking_since)
       WHERE messages_since IS NULL OR voice_since IS NULL`,
    )
    .run();

  if (result.changes > 0) {
    logger.info(`Migrated SQLite: seeded activity coverage dates (${result.changes} guild(s))`);
  }
}

/**
 * Lazily opens the SQLite database and applies the schema.
 * Uses Node's built-in SQLite so there is no native build step.
 */
export function getDb() {
  if (database) return database;

  mkdirSync(config.dataDir, { recursive: true });

  const file = path.join(config.dataDir, 'bot.db');
  database = new DatabaseSync(file);

  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec(SCHEMA);
  applyMigrations(database);
  migrateTicketNumberScope(database);
  migrateActivitySince(database);
  migrateWatchTerms(database);
  migrateLegacyWelcomeGifs(database);

  logger.info(`SQLite ready at ${file}`);
  return database;
}

export function closeDb() {
  if (!database) return;
  database.close();
  database = null;
}
