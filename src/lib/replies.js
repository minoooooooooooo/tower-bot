import { MessageFlags } from 'discord.js';

/**
 * Short plain-text replies.
 *
 * The bot answers with one or two lines instead of an embed: the icon carries
 * the tone a colour used to carry, and the message stays readable on a phone.
 * Lists and tables (help, store, logs) keep their embeds for now.
 */

/** Right-to-left mark, for lines that mix Arabic with a mention or a number. */
export const RLM = '\u200F';

function format(title, body) {
  return body ? `**${title}**\n${body}` : `**${title}**`;
}

export function okReply(title, body = '') {
  return { content: `✅ ${format(title, body)}` };
}

export function warnReply(title, body = '') {
  return { content: `⚠️ ${format(title, body)}` };
}

/** Neutral status (a current setting or a read-only view), not a warning. */
export function infoReply(title, body = '') {
  return { content: `ℹ️ ${format(title, body)}` };
}

export function errorReply(title, body = '') {
  return { content: `❌ ${format(title, body)}` };
}

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
