import { PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';
import { ageTurning, dateKey, formatMonthDay, isBirthdayToday, zonedDate } from '../lib/dates.js';
import { COLORS, embed } from '../lib/embeds.js';
import { createLogger } from '../lib/logger.js';
import {
  renderMessage,
  unknownPlaceholders as findUnknownPlaceholders,
} from '../lib/template.js';
import * as store from './birthday-store.js';

const logger = createLogger('birthday-greeting');

const warned = new Map();
const WARN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Reconciliation runs every minute for per-user time zones. Without a guard, a
 * missing channel permission would log the same warning 1440 times a day.
 */
function warnThrottled(key, message) {
  const now = Date.now();
  if (now - (warned.get(key) ?? 0) < WARN_INTERVAL_MS) return;
  warned.set(key, now);
  logger.warn(message);
}

export const DEFAULT_MESSAGE = '🎉 Happy birthday, {user}! Wishing you a fantastic day.';
export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_GIF_URL_LENGTH = 1000;

/**
 * Placeholders understood by the greeting template. `{age}` renders as 0 when
 * the member did not save a birth year, so a template never reads oddly blank.
 */
export const PLACEHOLDERS = [
  { key: 'user', description: 'Mentions the birthday member' },
  { key: 'name', description: 'Their display name' },
  { key: 'age', description: 'Age they turn (0 without a birth year)' },
  { key: 'server', description: 'Server name' },
  { key: 'date', description: 'Date, like "May 14"' },
];

const PLACEHOLDER_KEYS = new Set(PLACEHOLDERS.map((placeholder) => placeholder.key));

export { renderMessage };

export function unknownPlaceholders(template) {
  return findUnknownPlaceholders(template, PLACEHOLDER_KEYS);
}

export function validateMessage(template) {
  const text = template.trim();

  if (!text) return 'The greeting message cannot be empty.';
  if (text.length > MAX_MESSAGE_LENGTH) {
    return `The greeting message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`;
  }

  return null;
}

export function validateGifUrl(raw) {
  const value = raw.trim();

  if (!value) return 'Paste a direct image/GIF URL, or use `none` to remove it.';
  if (value.length > MAX_GIF_URL_LENGTH) {
    return `The GIF link must be ${MAX_GIF_URL_LENGTH} characters or fewer.`;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return 'That is not a valid URL.';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'The GIF link must start with http:// or https://.';
  }

  return null;
}

export function isClearValue(value) {
  return ['none', 'off', 'clear', 'remove', '-'].includes(value.trim().toLowerCase());
}

/**
 * Discord's member cache is nearly empty right after a restart, and the
 * single-member fetch can also fail (missing permission, member left). Fall
 * back to the user record so a live member's greeting is never skipped just
 * because their name could not be resolved.
 */
async function attempt(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

async function resolveName(guild, userId) {
  const member = await attempt(() => guild?.members?.fetch?.(userId));
  if (member?.displayName) return member.displayName;

  const user = await attempt(() => guild?.client?.users?.fetch?.(userId));
  return user?.globalName || user?.username || null;
}

/**
 * The exact payload posted in the channel. The `@everyone` ping lives in
 * `content`, outside the embed, so the whole server is notified of a birthday.
 * The member's own mention is added to `content` only when the template does
 * not already include it.
 */
export function buildGreetingPayload({
  guildName,
  userId,
  name,
  birthday,
  template,
  gifUrl,
  timeZone,
  now = new Date(),
}) {
  const today = zonedDate(now, timeZone);
  const age = ageTurning(birthday?.year ?? null, timeZone, now);

  const description = renderMessage(template, {
    user: `<@${userId}>`,
    name,
    age: age ?? 0,
    server: guildName,
    date: formatMonthDay(today.month, today.day),
  });

  const mention = `<@${userId}>`;

  return {
    content: description.includes(mention) ? '@everyone' : `@everyone ${mention}`,
    allowedMentions: { parse: ['everyone'], users: [userId] },
    embeds: [
      embed({
        description,
        color: COLORS.primary,
        image: gifUrl ?? undefined,
      }),
    ],
  };
}

/**
 * Sends the current template to the configured channel for one member, without
 * recording a delivery. Used by the manual `send` subcommand, so a test post
 * does not suppress the real greeting later that day.
 */
export async function sendGreeting(guild, settings, userId, now = new Date()) {
  const channelId = settings.birthdayChannelId;
  if (!channelId) return { ok: false, error: 'no-channel' };

  const channel = await resolveChannel(guild, channelId);

  if (!channel || typeof channel.send !== 'function') {
    return { ok: false, error: 'channel-missing' };
  }

  if (!canPost(channel, guild.members.me)) {
    return { ok: false, error: 'missing-permissions', channel };
  }

  const name = await resolveName(guild, userId);
  if (!name) return { ok: false, error: 'member-missing', channel };

  const birthday = store.getBirthday(guild.id, userId);
  const timeZone = birthday?.timezone ?? settings.timezone ?? config.timezone;

  const payload = buildGreetingPayload({
    guildName: guild.name,
    userId,
    name,
    birthday,
    template: settings.birthdayMessage ?? DEFAULT_MESSAGE,
    gifUrl: settings.birthdayGifUrl ?? null,
    timeZone,
    now,
  });

  try {
    await channel.send(payload);
  } catch (error) {
    warnThrottled(
      `manual:${guild.id}:${userId}`,
      `[${guild.name}] Manual greeting failed: ${error.message}`,
    );
    return { ok: false, error: 'send-failed', channel };
  }

  // Discord silently drops an @everyone ping when the bot lacks the permission,
  // so the admin testing a greeting is told why nobody was notified.
  const permissions = guild.members.me ? channel.permissionsFor?.(guild.members.me) : null;
  const pingSuppressed = Boolean(permissions) &&
    !permissions.has(PermissionFlagsBits.MentionEveryone);

  return { ok: true, channel, pingSuppressed };
}

async function resolveChannel(guild, channelId) {
  return (
    guild.channels.cache.get(channelId) ??
    (await guild.channels.fetch(channelId).catch(() => null))
  );
}

function canPost(channel, me) {
  if (!me) return false;
  const permissions = channel.permissionsFor?.(me);
  if (!permissions) return true;

  return (
    permissions.has(PermissionFlagsBits.SendMessages) &&
    permissions.has(PermissionFlagsBits.EmbedLinks)
  );
}

/**
 * Posts a greeting for every member whose birthday is today in their own time
 * zone and who has not been greeted yet. Safe to call every minute: the
 * `birthday_greetings` claim prevents duplicates.
 */
export async function announceBirthdays(guild, settings, now = new Date()) {
  const channelId = settings.birthdayChannelId;
  if (!channelId) return { sent: 0, channel: null };

  const defaultZone = settings.timezone ?? config.timezone;
  const birthdays = store
    .listBirthdays(guild.id)
    .filter((birthday) =>
      isBirthdayToday(birthday.month, birthday.day, birthday.timezone ?? defaultZone, now),
    );

  if (birthdays.length === 0) return { sent: 0, channel: null };

  const channel = await resolveChannel(guild, channelId);

  if (!channel || typeof channel.send !== 'function') {
    warnThrottled(
      `channel:${guild.id}`,
      `[${guild.name}] Birthday channel ${channelId} is missing or not sendable`,
    );
    return { sent: 0, channel: null, error: 'channel-missing' };
  }

  if (!canPost(channel, guild.members.me)) {
    warnThrottled(
      `perm:${guild.id}:${channel.id}`,
      `[${guild.name}] Cannot post in #${channel.name}: needs Send Messages and Embed Links`,
    );
    return { sent: 0, channel, error: 'missing-permissions' };
  }

  const me = guild.members.me;
  const permissions = me ? channel.permissionsFor?.(me) : null;

  if (permissions && !permissions.has(PermissionFlagsBits.MentionEveryone)) {
    warnThrottled(
      `ping:${guild.id}:${channel.id}`,
      `[${guild.name}] Cannot ping @everyone in #${channel.name}: needs the Mention Everyone permission`,
    );
  }

  const template = settings.birthdayMessage ?? DEFAULT_MESSAGE;
  const gifUrl = settings.birthdayGifUrl ?? null;
  let sent = 0;

  for (const birthday of birthdays) {
    const timeZone = birthday.timezone ?? defaultZone;
    const key = dateKey(now, timeZone);

    const name = await resolveName(guild, birthday.userId);
    if (!name) continue;

    if (!store.claimGreeting(guild.id, birthday.userId, key, channel.id)) continue;

    const payload = buildGreetingPayload({
      guildName: guild.name,
      userId: birthday.userId,
      name,
      birthday,
      template,
      gifUrl,
      timeZone,
      now,
    });

    try {
      await channel.send(payload);
      sent += 1;
    } catch (error) {
      store.releaseGreeting(guild.id, birthday.userId, key);
      warnThrottled(
        `send:${guild.id}:${birthday.userId}`,
        `[${guild.name}] Could not greet ${name ?? birthday.userId}: ${error.message}`,
      );
    }
  }

  if (sent > 0) {
    logger.info(`[${guild.name}] Sent ${sent} birthday greeting(s) in #${channel.name}`);
  }

  return { sent, channel };
}
