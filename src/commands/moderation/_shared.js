import { parseDuration } from '../../lib/durations.js';
import {
  ephemeral,
  errorReply,
  okReply,
  respond,
  warnReply,
} from '../../lib/replies.js';

export { ephemeral, respond };

export const MAX_REASON_LENGTH = 500;

/** Error reply that also releases the cooldown, for bad input and refusals. */
export function fail(ctx, title, description) {
  return ctx.fail(ephemeral(errorReply(title, description)));
}

export function done(ctx, title, description) {
  return respond(ctx, ephemeral(okReply(title, description)));
}

export function info(ctx, title, description) {
  return respond(ctx, ephemeral(warnReply(title, description)));
}

/** "40s spamming" / "spamming" from prefix arguments after the target. */
export function prefixTimedArgs(ctx, startIndex = 1) {
  const args = ctx.args.slice(startIndex);
  const durationMs = args[0] ? parseDuration(args[0]) : null;

  if (durationMs) {
    return { durationMs, reason: args.slice(1).join(' ').trim() };
  }

  return { durationMs: null, reason: args.join(' ').trim() };
}

export function slashReason(ctx, name = 'reason') {
  return (ctx.getString(name) ?? '').trim();
}

export function trimReason(reason) {
  return String(reason ?? '').trim().slice(0, MAX_REASON_LENGTH);
}

export function defaultReason(reason) {
  return trimReason(reason) || 'بدون سبب';
}

/** Turns a Discord API error into one useful sentence. */
export function apiProblem(error) {
  if (error?.code === 50013) {
    return 'ديسكورد رفض العملية. تأكد من صلاحياتي ومن أن رتبتي فوق رتبة الهدف.';
  }

  if (error?.code === 50035) {
    return 'ديسكورد رفض الطلب كأنه غير صالح. راجع العضو والمدة.';
  }

  if (error?.code === 429 || /rate limit/i.test(String(error?.message))) {
    return 'ديسكورد يحدّ الطلبات الآن. انتظر دقيقة وجرّب مرة ثانية.';
  }

  return error?.message ? String(error.message).slice(0, 300) : 'صار خطأ غير متوقع.';
}
