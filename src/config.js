import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidTimeZone } from './lib/dates.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const rootDir = path.resolve(here, '..');

function readList(value) {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const token = process.env.DISCORD_TOKEN?.trim() ?? '';

if (!token) {
  console.error(
    [
      '',
      '[config] DISCORD_TOKEN is missing.',
      '  1. Copy .env.example to .env',
      '  2. Paste your bot token after DISCORD_TOKEN=',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const timezone = process.env.TIMEZONE?.trim() || 'UTC';

if (!isValidTimeZone(timezone)) {
  console.error(
    [
      '',
      `[config] Invalid TIMEZONE "${timezone}".`,
      '  Use an IANA time zone name, for example Europe/Berlin or America/New_York.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const interval = Number.parseInt(process.env.BIRTHDAY_CHECK_INTERVAL_MS ?? '', 10);

export const config = {
  token,
  clientId: process.env.CLIENT_ID?.trim() || null,
  guildId: process.env.GUILD_ID?.trim() || null,
  prefix: process.env.PREFIX?.trim() || ':-',
  ownerIds: readList(process.env.OWNER_IDS),
  logLevel: (process.env.LOG_LEVEL?.trim() || 'info').toLowerCase(),
  timezone,
  dataDir: process.env.DATA_DIR?.trim() || path.join(rootDir, 'data'),
  birthdayCheckIntervalMs: Number.isFinite(interval) && interval >= 10_000 ? interval : 60_000,
  commandsDir: path.join(rootDir, 'src', 'commands'),
  eventsDir: path.join(rootDir, 'src', 'events'),
};

export function requireClientId() {
  if (!config.clientId) {
    console.error(
      [
        '',
        '[config] CLIENT_ID is missing. It is required to register slash commands.',
        '  Find it on the General Information tab of your Discord application.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
  return config.clientId;
}
