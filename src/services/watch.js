import { PermissionFlagsBits } from 'discord.js';
import { COLORS, embed } from '../lib/embeds.js';
import { createLogger } from '../lib/logger.js';
import { normalizeForMatch } from '../lib/text.js';
import { getWatchChannelId, listIgnoredChannels, listWatchTerms } from './watch-store.js';

const logger = createLogger('watch');

const CACHE_TTL_MS = 30_000;
const QUIET_MS = 2_000;
const BURST = 12;
const WINDOW_MS = 10 * 60 * 1000;
const WARN_TTL_MS = 30 * 60 * 1000;

const cache = new Map();
const matchers = new Map();
const sent = new Map();
const warned = new Map();

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
  warned.delete(`channel:${guildId}`);
}

function guildState(guildId) {
  const hit = cache.get(guildId);

  if (hit && hit.expires > Date.now()) return hit.state;

  const state = {
    terms: listWatchTerms(guildId).map((row) => row.term),
    channelId: getWatchChannelId(guildId),
    ignored: new Set(listIgnoredChannels(guildId).map((row) => row.channelId)),
  };

  cache.set(guildId, { expires: Date.now() + CACHE_TTL_MS, state });
  return state;
}

/**
 * A message is ignored when its channel, its parent channel (a thread) or its
 * category is on the list. Threads hang off a channel, which hangs off a
 * category, so both levels are checked.
 */
function inIgnoredChannel(state, message) {
  if (state.ignored.size === 0) return false;

  const ids = [
    message.channelId ?? message.channel?.id,
    message.channel?.parentId,
    message.channel?.parent?.parentId,
  ];

  return ids.some((id) => id && state.ignored.has(id));
}

function warnOnce(key, text) {
  const now = Date.now();
  const last = warned.get(key);

  if (last && now - last < WARN_TTL_MS) return;

  warned.set(key, now);
  logger.warn(text);
}

function withinRateLimit(guildId) {
  const now = Date.now();
  const history = (sent.get(guildId) ?? []).filter((time) => now - time < WINDOW_MS);

  if (history.length >= BURST) {
    sent.set(guildId, history);
    return false;
  }

  if (history.length > 0 && now - history[history.length - 1] < QUIET_MS) {
    sent.set(guildId, history);
    return false;
  }

  history.push(now);
  sent.set(guildId, history);
  return true;
}

function messageLink(message, guildId, channelId) {
  if (message.url) return message.url;
  if (!guildId || !channelId || !message.id) return null;

  return `https://discord.com/channels/${guildId}/${channelId}/${message.id}`;
}

export function alertPayload(message, hits) {
  const guildId = message.guildId ?? message.guild?.id;
  const channelId = message.channelId ?? message.channel?.id;
  const author = message.member?.displayName ?? message.author?.username ?? 'unknown';
  const channel = message.channel?.name ? `#${message.channel.name}` : `<#${channelId}>`;
  const body = String(message.content ?? '').replace(/\s+/g, ' ').trim();
  const quoted = body.length > 400 ? `${body.slice(0, 400)}…` : body;
  const link = messageLink(message, guildId, channelId);
  const terms = hits.join(', ');

  return {
    // The ping must live in `content`, outside the embed: Discord ignores
    // mentions inside embeds. Same shape as the birthday greeting.
    content: '@everyone',
    allowedMentions: { parse: ['everyone'] },
    embeds: [
      embed({
        title: 'Keyword alert',
        description: [
          // A leading LRM keeps the sentence left-to-right; an Arabic keyword
          // at the start would otherwise flip the whole line.
          `\u200E**${terms.slice(0, 200)}** was mentioned by **${author}** in ${channel}.`,
          '',
          quoted ? `> ${quoted.split('\n').join('\n> ')}` : '_The message has no text._',
          '',
          link ? `[Jump to the message](${link})` : '',
        ]
          .filter(Boolean)
          .join('\n')
          .slice(0, 4000),
        footer: `\u200E${hits.length === 1 ? 'Watched keyword' : 'Watched keywords'}: ${terms}`.slice(
          0,
          2048,
        ),
        color: COLORS.warning,
      }),
    ],
  };
}

async function sendAlert(message, client, channelId, hits) {
  let channel;

  try {
    channel = await client.channels.fetch(channelId, { force: false });
  } catch (error) {
    warnOnce(
      `channel:${message.guildId ?? message.guild?.id}`,
      `Keyword alert channel ${channelId} cannot be loaded: ${error.message}. Run /watch channel to pick another.`,
    );
    return false;
  }

  if (!channel) {
    warnOnce(
      `channel:${message.guildId ?? message.guild?.id}`,
      `Keyword alert channel ${channelId} no longer exists. Run /watch channel to pick another.`,
    );
    return false;
  }

  if (!channel.isTextBased?.() || channel.isDMBased?.()) {
    warnOnce(
      `channel:${message.guildId ?? message.guild?.id}`,
      `Keyword alert channel ${channelId} is not a text channel. Run /watch channel to pick another.`,
    );
    return false;
  }

  // Discord silently drops the @everyone ping when the bot lacks the
  // permission, so the log explains why nobody was notified.
  const me = message.guild?.members?.me;
  const permissions = me ? channel.permissionsFor?.(me) : null;

  if (permissions && !permissions.has(PermissionFlagsBits.MentionEveryone)) {
    warnOnce(
      `ping:${message.guildId ?? message.guild?.id}`,
      `Keyword alerts in ${channelId} cannot ping @everyone: the bot needs the Mention Everyone permission there.`,
    );
  }

  try {
    await channel.send(alertPayload(message, hits));
    return true;
  } catch (error) {
    warnOnce(
      `channel:${message.guildId ?? message.guild?.id}`,
      `Keyword alert to channel ${channelId} failed: ${error.message}`,
    );
    return false;
  }
}

/**
 * Called for every guild message. Returns 1 when an alert was posted and 0
 * otherwise, so tests (and the log) can see the effect without sniffing
 * Discord.
 */
export async function handleKeywordAlerts(message, client) {
  if (!message?.inGuild?.() || message.author?.bot) return 0;
  if (!message.content?.trim()) return 0;

  const guildId = message.guildId ?? message.guild?.id;

  if (!guildId) return 0;

  const state = guildState(guildId);

  if (state.terms.length === 0) return 0;

  if (inIgnoredChannel(state, message)) return 0;

  const normalized = normalizeForMatch(message.content);
  const hits = state.terms.filter((term) => buildMatcher(term).test(normalized));

  if (hits.length === 0) return 0;

  if (!state.channelId) {
    warnOnce(
      `channel:${guildId}`,
      `Keyword alerts are configured but no alert channel is set in ${guildId}. Run /watch channel #channel.`,
    );
    return 0;
  }

  // One alert per burst instead of one per matching word or per subscriber:
  // a raid of messages containing the word cannot flood the channel.
  if (!withinRateLimit(guildId)) return 0;

  return (await sendAlert(message, client, state.channelId, hits)) ? 1 : 0;
}
