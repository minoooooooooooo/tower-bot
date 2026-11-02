import { COLORS, embed } from '../lib/embeds.js';
import { createLogger } from '../lib/logger.js';
import { normalizeForMatch } from '../lib/text.js';
import { listWatchTerms, markWatchBroken } from './watch-store.js';

const logger = createLogger('watch');

const CACHE_TTL_MS = 30_000;
const DM_QUIET_MS = 2_000;
const DM_BURST = 12;
const DM_WINDOW_MS = 10 * 60 * 1000;

const cache = new Map();
const matchers = new Map();
const sent = new Map();

// Arabic diacritics, tatweel, and the alef/ya/ta-marbuta variants that people
// type inconsistently. Normalizing both sides makes "مُحَمّد" match "محمد".
// Shared with command aliases; re-exported so existing callers keep working.
export { normalizeForMatch };

/**
 * Whole-word match that works outside ASCII: `\b` only understands Latin, so
 * the boundaries are spelled out with Unicode property escapes.
 */
export function buildMatcher(term) {
  const normalized = normalizeForMatch(term);

  if (matchers.has(normalized)) return matchers.get(normalized);

  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u');

  matchers.set(normalized, matcher);
  return matcher;
}

export function invalidateWatchCache(guildId) {
  cache.delete(guildId);
}

function termsForGuild(guildId) {
  const hit = cache.get(guildId);

  if (hit && hit.expires > Date.now()) return hit.byUser;

  const byUser = new Map();

  for (const row of listWatchTerms(guildId)) {
    if (!byUser.has(row.userId)) byUser.set(row.userId, []);
    byUser.get(row.userId).push(row);
  }

  cache.set(guildId, { expires: Date.now() + CACHE_TTL_MS, byUser });
  return byUser;
}

function withinRateLimit(userId) {
  const now = Date.now();
  const history = (sent.get(userId) ?? []).filter((time) => now - time < DM_WINDOW_MS);

  if (history.length >= DM_BURST) {
    sent.set(userId, history);
    return false;
  }

  if (history.length > 0 && now - history[history.length - 1] < DM_QUIET_MS) {
    sent.set(userId, history);
    return false;
  }

  history.push(now);
  sent.set(userId, history);
  return true;
}

function alertPayload(message, hits) {
  const author = message.member?.displayName ?? message.author?.username ?? 'unknown';
  const channel = message.channel?.name ? `#${message.channel.name}` : 'a channel';
  const terms = hits.map((hit) => hit.term).join(', ');
  const body = String(message.content ?? '').replace(/\s+/g, ' ').trim();
  const quoted = body.length > 400 ? `${body.slice(0, 400)}…` : body;

  return {
    allowedMentions: { parse: [] },
    content: [
      `🔎 **${terms.slice(0, 200)}** — ${author} in ${channel}`,
      message.url ?? '',
    ]
      .filter(Boolean)
      .join('\n'),
    embeds: [
      embed({
        description: quoted ? `> ${quoted.split('\n').join('\n> ')}` : undefined,
        author: { name: `${author} · ${channel}`.slice(0, 256) },
        footer: 'Keyword alert · open the link above to jump to the message',
        color: COLORS.warning,
      }),
    ],
  };
}

async function sendAlerts(message, client, userId, hits, wasBroken) {
  if (!withinRateLimit(userId)) return false;

  let user;

  try {
    user = await client.users.fetch(userId, { force: false });
  } catch (error) {
    logger.warn(`Could not resolve subscriber ${userId}: ${error.message}`);
    return false;
  }

  try {
    await user.send(alertPayload(message, hits));

    if (wasBroken) markWatchBroken(message.guildId ?? message.guild?.id, userId, false);

    return true;
  } catch (error) {
    // 50007 = "Cannot send messages to this user" — they closed DMs.
    if (error?.code === 50007) {
      markWatchBroken(message.guildId ?? message.guild?.id, userId, true);
      logger.warn(`Subscriber ${userId} has DMs closed; keyword alerts cannot be delivered`);
    } else {
      logger.warn(`Keyword DM to ${userId} failed: ${error.message}`);
    }

    return false;
  }
}

/**
 * Called for every guild message. Returns the number of DMs that went out, so
 * tests (and the log) can see the effect without sniffing Discord.
 */
export async function handleKeywordAlerts(message, client) {
  if (!message?.inGuild?.() || message.author?.bot) return 0;
  if (!message.content?.trim()) return 0;

  const guildId = message.guildId ?? message.guild?.id;

  if (!guildId) return 0;

  const byUser = termsForGuild(guildId);

  if (byUser.size === 0) return 0;

  const normalized = normalizeForMatch(message.content);
  let delivered = 0;

  for (const [userId, terms] of byUser) {
    // Nobody needs an alert for their own message.
    if (userId === message.author.id) continue;

    const hits = terms.filter((row) => buildMatcher(row.term).test(normalized));

    if (hits.length === 0) continue;

    const wasBroken = Boolean(terms[0]?.broken);

    if (await sendAlerts(message, client, userId, hits, wasBroken)) delivered += 1;
  }

  return delivered;
}
