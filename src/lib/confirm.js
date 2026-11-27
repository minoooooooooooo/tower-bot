import { createLogger } from './logger.js';
import { ephemeral, errorReply, warnReply } from './replies.js';
import { normalizeForMatch } from './text.js';

const logger = createLogger('confirm');

/** How long a pending confirmation stays valid. */
export const CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;

/** Words that run the pending action. Normalized with `normalizeForMatch`. */
const CONFIRM_WORDS = new Set(['confirm', 'تاكيد', 'اكد']);

/** Words that drop it. */
const CANCEL_WORDS = new Set(['cancel', 'الغاء', 'لا']);

/** key -> { run, message, timer, expiresAt, command } */
const pending = new Map();

function keyFor(guildId, channelId, userId) {
  return `${guildId}:${channelId}:${userId}`;
}

/** The line every confirmation prompt ends with. */
export function confirmationInstruction() {
  return (
    'اكتب **confirm** أو **تأكيد** في هذه القناة خلال دقيقتين عشان نكمل، ' +
    'أو **إلغاء** للإلغاء.'
  );
}

function clearPending(key) {
  const entry = pending.get(key);

  if (!entry) return null;

  pending.delete(key);
  clearTimeout(entry.timer);

  return entry;
}

function expire(key, entry) {
  if (pending.get(key) !== entry) return;

  pending.delete(key);

  // Leave the prompt saying the window closed instead of "type confirm" for a
  // request nothing is listening to anymore.
  Promise.resolve(
    entry.message?.edit?.({
      content: '⚠️ **انتهى وقت التأكيد**\nما صار أي تغيير. أعد الأمر إذا ما زلت تريد.',
      embeds: [],
      components: [],
    }),
  ).catch(() => {});
}

/**
 * Registers a confirmation that is already prompted. The caller sends the
 * prompt itself (for a richer preview) and hands over the message it got back.
 */
export async function registerConfirmation({
  ctx,
  message,
  run,
  command,
  timeout = CONFIRM_TIMEOUT_MS,
}) {
  const key = keyFor(ctx.guildId, ctx.channelId, ctx.user.id);
  const entry = {
    run,
    message,
    command: command ?? ctx.commandName,
    expiresAt: Date.now() + timeout,
    timer: null,
  };

  const previous = clearPending(key);

  // A second request replaces the first; remove its now-dead prompt so the
  // channel never shows two "type confirm" messages for one answer slot.
  if (previous?.message && previous.message !== message) {
    await previous.message.delete?.().catch(() => {});
  }

  entry.timer = setTimeout(() => expire(key, entry), timeout);
  entry.timer.unref?.();

  pending.set(key, entry);
}

/**
 * Asks the invoking member to confirm in a separate message. Nothing changes
 * until that member types `confirm` / `تأكيد` in the same channel. The prompt
 * is ephemeral for slash commands and a normal reply for prefix commands.
 */
export async function askConfirmation({ ctx, prompt, run, command, timeout = CONFIRM_TIMEOUT_MS }) {
  const body = warnReply('يحتاج تأكيد', [prompt, confirmationInstruction()].filter(Boolean).join('\n\n'));
  const payload = { ...body, allowedMentions: { parse: [] } };
  const message = await ctx.reply(ctx.isSlash ? ephemeral(payload) : payload);

  await registerConfirmation({ ctx, message, run, command, timeout });

  return message;
}

/** Whether a member has a live confirmation waiting in this channel. */
export function hasPendingConfirmation({ guildId, channelId, userId }) {
  const entry = pending.get(keyFor(guildId, channelId, userId));

  return Boolean(entry && Date.now() <= entry.expiresAt);
}

/**
 * Intercepts a typed `confirm` / `تأكيد` (or `إلغاء`) from the member who was
 * prompted in this channel. Returns true when the message belonged to a
 * pending confirmation, so the caller stops treating it as chat or a command.
 */
export async function handleConfirmation(message, client) {
  if (!message.inGuild() || message.author.bot) return false;

  const key = keyFor(message.guildId, message.channelId, message.author.id);

  if (!pending.has(key)) return false;

  const word = normalizeForMatch(message.content).replace(/[.!?؟،,]+$/u, '').trim();

  if (!CONFIRM_WORDS.has(word) && !CANCEL_WORDS.has(word)) return false;

  const entry = clearPending(key);

  if (!entry) return false;

  if (Date.now() > entry.expiresAt) {
    await message.reply(warnReply('انتهى وقت التأكيد', 'أعد الأمر إذا ما زلت تريد.').content).catch(() => {});
    return true;
  }

  // The prompt has served its purpose; keep the channel clean before the
  // action posts its own result.
  await entry.message?.delete?.().catch(() => {});

  if (CANCEL_WORDS.has(word)) {
    await message
      .reply(warnReply('انلغى الأمر', 'ما صار أي تغيير.').content)
      .catch(() => {});
    return true;
  }

  try {
    await entry.run(client);
  } catch (error) {
    logger.error(`Confirmation for "${entry.command}" failed`, error);
    await message
      .reply(errorReply('ما صار التنفيذ', 'صار خطأ قبل ما يكتمل الأمر. جرّب مرة ثانية.').content)
      .catch(() => {});
  }

  return true;
}
