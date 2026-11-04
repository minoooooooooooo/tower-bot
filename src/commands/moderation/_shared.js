import { MessageFlags } from 'discord.js';
import { errorEmbed, successEmbed, warningEmbed } from '../../lib/embeds.js';
import { parseDuration } from '../../lib/durations.js';

export const MAX_REASON_LENGTH = 500;

export function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

/** Reply or edit, depending on whether the interaction was deferred already. */
export function respond(ctx, payload) {
  if (ctx.interaction?.deferred || ctx.interaction?.replied) {
    return ctx.editReply(payload);
  }

  return ctx.reply(payload);
}

/** Error reply that also releases the cooldown, for bad input and refusals. */
export function fail(ctx, title, description) {
  return ctx.fail(ephemeral({ embeds: [errorEmbed(title, description)] }));
}

export function done(ctx, title, description) {
  return respond(ctx, ephemeral({ embeds: [successEmbed(title, description)] }));
}

export function info(ctx, title, description) {
  return respond(ctx, ephemeral({ embeds: [warningEmbed(title, description)] }));
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
  return trimReason(reason) || 'No reason given';
}

/** Turns a Discord API error into one useful sentence. */
export function apiProblem(error) {
  if (error?.code === 50013) {
    return 'Discord says I do not have permission. Check **Manage Roles**, my role position, and that I outrank the target.';
  }

  if (error?.code === 50035) {
    return 'Discord rejected the request as invalid. Double-check the member and the duration.';
  }

  if (error?.code === 429 || /rate limit/i.test(String(error?.message))) {
    return 'Discord is rate limiting moderation actions. Wait a minute and try again.';
  }

  return error?.message ? String(error.message).slice(0, 300) : 'Something went wrong.';
}
