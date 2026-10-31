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

  logger.info(`SQLite ready at ${file}`);
  return database;
}

export function closeDb() {
  if (!database) return;
  database.close();
  database = null;
}
