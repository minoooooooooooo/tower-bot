import { createLogger } from '../lib/logger.js';

/**
 * Points published by other bots, read through Discord itself (no ports, no IPs).
 *
 * Each source bot keeps one message in a private channel with a JSON attachment
 * and edits it whenever the numbers change:
 *   { "guildId": "…", "updatedAt": "…", "balances": { "<userId>": 30, … } }
 *
 *  - E Bot 1   → vex-balances.json        → added to VEX POINT
 *  - Al-Kabus  → nightmare-balances.json  → added to NIGHTMARE POINTS
 *
 * Only a message written by the configured bot id is trusted. Results are
 * cached for a minute, and any failure returns null so the card still renders
 * with the local numbers.
 *
 * .env:
 *   EBOT_VEX_CHANNEL_ID, EBOT_BOT_ID              (E Bot 1)
 *   NIGHTMARE_CHANNEL_ID, NIGHTMARE_BOT_ID        (Al-Kabus; the channel defaults to EBOT_VEX_CHANNEL_ID)
 */

const logger = createLogger('linked-points');

const CACHE_MS = 60_000;
const TIMEOUT_MS = 4_000;

const SOURCES = {
  vex: {
    label: 'E Bot 1 Vex',
    file: 'vex-balances.json',
    channel: () => process.env.EBOT_VEX_CHANNEL_ID,
    bot: () => process.env.EBOT_BOT_ID,
  },
  nightmare: {
    label: 'Al-Kabus nightmare',
    file: 'nightmare-balances.json',
    channel: () => process.env.NIGHTMARE_CHANNEL_ID || process.env.EBOT_VEX_CHANNEL_ID,
    bot: () => process.env.NIGHTMARE_BOT_ID,
  },
};

const cache = new Map();

function settings(source) {
  const channelId = source.channel()?.trim() ?? '';
  const botId = source.bot()?.trim() ?? '';
  return channelId && botId ? { channelId, botId } : null;
}

// Say once at startup which links are configured. A missing optional source is
// normal, so it stays at debug instead of warning on every boot.
for (const source of Object.values(SOURCES)) {
  const link = settings(source);
  if (link) logger.info(`${source.label} link enabled → channel ${link.channelId}`);
  else logger.debug(`${source.label} link disabled (channel id or bot id not set)`);
}

async function readBalances(client, guildId, key) {
  const source = SOURCES[key];
  const link = settings(source);
  if (!link) return null;

  const cacheKey = `${key}:${guildId}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.balances;

  try {
    const channel = await client.channels.fetch(link.channelId);
    if (!channel?.isTextBased?.()) throw new Error('the channel id is not a text channel this bot can see');

    const messages = await channel.messages.fetch({ limit: 30 });
    const message = messages.find(
      (item) =>
        item.author?.id === link.botId &&
        item.attachments.some((file) => file.name === source.file),
    );
    if (!message) throw new Error(`no ${source.file} from bot ${link.botId} in that channel yet`);

    const file = message.attachments.find((item) => item.name === source.file);
    const response = await fetch(file.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`attachment download answered ${response.status}`);

    const data = await response.json();
    const balances = {};

    // A file from another server adds nothing here.
    if (!data?.guildId || data.guildId === guildId) {
      for (const [userId, value] of Object.entries(data?.balances ?? {})) {
        const amount = Math.trunc(Number(value));
        if (Number.isFinite(amount) && amount > 0) balances[userId] = amount;
      }
    }

    cache.set(cacheKey, { at: Date.now(), balances });
    logger.info(`${source.label}: ${Object.keys(balances).length} members in guild ${guildId}`);
    return balances;
  } catch (error) {
    logger.warn(`Could not read ${source.label}: ${error?.message ?? error}`);
    return hit?.balances ?? null;
  }
}

/** { userId: vex } from E Bot 1, or null. */
export function ebotVexBalances(client, guildId) {
  return readBalances(client, guildId, 'vex');
}

/** { userId: nightmare points } from Al-Kabus, or null. */
export function nightmareBalances(client, guildId) {
  return readBalances(client, guildId, 'nightmare');
}

/** Both sources at once: { vex, nightmare } (each may be null). */
export async function linkedPoints(client, guildId) {
  const [vex, nightmare] = await Promise.all([
    ebotVexBalances(client, guildId),
    nightmareBalances(client, guildId),
  ]);
  return { vex, nightmare };
}
