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

const aiMaxInput = Number.parseInt(process.env.AI_MAX_INPUT_CHARS ?? '', 10);

const activityPort = Number.parseInt(process.env.ACTIVITY_PORT ?? '', 10);

const activityEnabled = /^(1|true|yes|on)$/i.test(process.env.ACTIVITY_ENABLED?.trim() ?? '');

const tunnelEnabled = /^(1|true|yes|on)$/i.test(process.env.TUNNEL_ENABLED?.trim() ?? '');

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
  // The Discord Activity storefront. Off unless ACTIVITY_ENABLED=1; the bot
  // works exactly as before when it is off. See docs/activity-store.md.
  activity: {
    enabled: activityEnabled,
    host: process.env.ACTIVITY_HOST?.trim() || '0.0.0.0',
    port: Number.isFinite(activityPort) && activityPort > 0 ? activityPort : 3000,
    publicUrl: process.env.ACTIVITY_PUBLIC_URL?.trim() || null,
    clientSecret: process.env.DISCORD_CLIENT_SECRET?.trim() || '',
    // Optional channel that receives the fresh tunnel address on startup, so
    // the portal mapping can be updated without opening the panel console.
    urlChannelId: process.env.ACTIVITY_URL_CHANNEL_ID?.trim() || '',
  },
  // A free public HTTPS address for the activity, run as part of the bot. Off
  // unless TUNNEL_ENABLED=1. See docs/activity-store.md.
  tunnel: {
    enabled: tunnelEnabled,
  },
  // Any OpenAI-compatible endpoint works: Google's compatibility layer, OpenAI,
  // OpenRouter, Groq, DeepSeek, or a local server. Only the key is mandatory;
  // an unconfigured key turns the summary command into a setup hint.
  ai: {
    apiKey: process.env.AI_API_KEY?.trim() || '',
    baseUrl:
      process.env.AI_BASE_URL?.trim() || 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: process.env.AI_MODEL?.trim() || 'gemini-3.5-flash-lite',
    thinking: process.env.AI_THINKING?.trim().toLowerCase() || '',
    maxInputChars:
      Number.isFinite(aiMaxInput) && aiMaxInput >= 4000 ? aiMaxInput : 60_000,
  },
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
