import { createLogger } from '../lib/logger.js';

const logger = createLogger('summary-source');

export const PAGE_SIZE = 100;
export const DEFAULT_CAP = 3000;
export const MESSAGE_CHARS = 600;

const timeFormatters = new Map();

function timeFormatter(timeZone) {
  if (!timeFormatters.has(timeZone)) {
    timeFormatters.set(
      timeZone,
      new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: 'short',
      }),
    );
  }

  return timeFormatters.get(timeZone);
}

/** One short line describing what a non-text message carried. */
function describeExtras(message) {
  const parts = [];

  if (message.attachments?.size > 0) {
    const kinds = [...message.attachments.values()].map((file) =>
      file.contentType?.startsWith('image/') ? 'image' : `file ${file.name ?? ''}`.trim(),
    );
    parts.push(`[${kinds.join(', ')}]`);
  }

  if (message.embeds?.length > 0) {
    const title = message.embeds[0]?.title;
    parts.push(title ? `[embed: ${title}]` : '[embed]');
  }

  if (message.stickers?.size > 0) parts.push('[sticker]');

  return parts.join(' ');
}

function hasContent(message) {
  return Boolean(
    message.content?.trim() ||
      message.attachments?.size > 0 ||
      message.embeds?.length > 0 ||
      message.stickers?.size > 0,
  );
}

/**
 * Reads a channel's history newest-first until `since`, then returns the
 * messages oldest-first. Discord has the full history, so nothing is stored on
 * our side. `cap` bounds both memory and model cost.
 */
export async function collectRangeMessages(channel, { since, until = Date.now(), cap = DEFAULT_CAP } = {}) {
  const messages = [];
  let before;
  let scanned = 0;
  let truncated = false;

  while (scanned < cap) {
    const limit = Math.min(PAGE_SIZE, cap - scanned);
    const batch = await channel.messages.fetch({ limit, ...(before ? { before } : {}) });

    if (batch.size === 0) break;

    let reachedStart = false;

    for (const message of batch.values()) {
      scanned += 1;

      if (message.createdTimestamp < since) {
        reachedStart = true;
        continue;
      }

      if (message.createdTimestamp > until) continue;
      if (!hasContent(message)) continue;

      messages.push(message);
    }

    before = batch.last().id;

    // Newest-first pages: once the tail of a page predates the window, every
    // later page does too.
    if (reachedStart || batch.size < limit || batch.last().createdTimestamp < since) break;
  }

  if (scanned >= cap) truncated = true;

  messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

  logger.debug(
    `read ${messages.length} message(s) from #${channel.name ?? channel.id} (${scanned} scanned)`,
  );

  return { messages, scanned, truncated };
}

/**
 * Display name per author. A nickname is what the team actually calls someone,
 * so it beats both the global name and the raw handle. Messages fetched from
 * history sometimes arrive without a `member`, which is why this falls back to
 * the guild cache and then one bounded REST lookup per author.
 */
export async function resolveDisplayNames(messages, guild = null, { maxFetches = 30 } = {}) {
  const names = new Map();
  const seen = new Set();
  let fetches = 0;

  for (const message of messages) {
    const id = message.author?.id;

    if (!id || seen.has(id)) continue;

    seen.add(id);

    const inline = message.member?.displayName;

    if (inline) {
      names.set(id, inline);
      continue;
    }

    const cached = guild?.members?.cache?.get?.(id)?.displayName;

    if (cached) {
      names.set(id, cached);
      continue;
    }

    if (fetches < maxFetches && typeof guild?.members?.fetch === 'function') {
      fetches += 1;
      const member = await guild.members.fetch(id).catch(() => null);

      if (member?.displayName) {
        names.set(id, member.displayName);
        continue;
      }
    }

    const fallback = message.author?.globalName ?? message.author?.username;

    if (fallback) names.set(id, fallback);
  }

  return names;
}

/**
 * Names the model should use, paired with the raw handle so it can tell that
 * two spellings are one person. Only speakers whose handle differs are listed.
 */
export function buildSpeakerRoster(messages, names) {
  const seen = new Set();
  const lines = [];

  for (const message of messages) {
    const id = message.author?.id;
    const username = message.author?.username;

    if (!id || !username || seen.has(id)) continue;

    seen.add(id);

    const display =
      names?.get(id) ?? message.member?.displayName ?? message.author?.globalName;

    if (!display || display === username) continue;

    lines.push(`- ${display} (${username})`);
  }

  return lines.slice(0, 40);
}

/**
 * `[14:03 02 Nov] Name: text` — one line per message, trimmed hard so a single
 * wall of text cannot eat the whole budget.
 */
export function buildTranscript(messages, { timeZone = 'UTC', names = null } = {}) {
  const format = timeFormatter(timeZone);

  return messages.map((message) => {
    const name =
      names?.get(message.author?.id) ??
      message.member?.displayName ??
      message.author?.globalName ??
      message.author?.username ??
      'unknown';
    const bot = message.author?.bot ? ' (bot)' : '';
    const extras = describeExtras(message);
    const text = String(message.content ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MESSAGE_CHARS);

    return `[${format.format(new Date(message.createdTimestamp))}] ${name}${bot}: ${
      text || extras
    }${extras && text ? ` ${extras}` : ''}`.trim();
  });
}

/** Splits transcript lines into pieces no bigger than `maxChars`. */
export function chunkLines(lines, maxChars) {
  const chunks = [];
  let current = [];
  let size = 0;

  for (const line of lines) {
    const cost = line.length + 1;

    if (current.length > 0 && size + cost > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }

    current.push(line);
    size += cost;
  }

  if (current.length > 0) chunks.push(current);

  return chunks;
}
