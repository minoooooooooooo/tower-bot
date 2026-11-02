import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger } from './logger.js';

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

  -- Personal keyword alerts: the subscriber gets a DM with a jump link.
  CREATE TABLE IF NOT EXISTS watch_terms (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id   TEXT    NOT NULL,
    user_id    TEXT    NOT NULL,
    term       TEXT    NOT NULL,
    broken     INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE (guild_id, user_id, term)
  );

  CREATE INDEX IF NOT EXISTS idx_watch_terms_guild
    ON watch_terms (guild_id);

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
    PRIMARY KEY (guild_id, trigger)
  );
`;

// Columns added after the first release. `CREATE TABLE IF NOT EXISTS` does not
// touch existing tables, so they are applied with ALTER TABLE on startup.
const COLUMN_MIGRATIONS = [
  ['guild_settings', 'birthday_channel_id', 'TEXT'],
  ['guild_settings', 'birthday_message', 'TEXT'],
  ['guild_settings', 'birthday_gif_url', 'TEXT'],
  ['birthdays', 'timezone', 'TEXT'],
  ['welcome_settings', 'gif_url', 'TEXT'],
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
  migrateLegacyWelcomeGifs(database);

  logger.info(`SQLite ready at ${file}`);
  return database;
}

export function closeDb() {
  if (!database) return;
  database.close();
  database = null;
}
