import { resolveChannel } from '../../lib/resolve.js';
import { errorEmbed } from '../../lib/embeds.js';
import { ephemeral } from './_shared.js';

/**
 * The channel a lock/unlock run should change: the `channel` option on slash,
 * the first prefix argument (`#mention`, id or name), or the current channel.
 */
export async function targetChannel(ctx) {
  if (ctx.isSlash) {
    return { channel: ctx.getChannel('channel') ?? ctx.channel, problem: null };
  }

  const token = ctx.args[0];

  if (!token) return { channel: ctx.channel, problem: null };

  const channel = await resolveChannel(ctx.guild, token);

  if (!channel) {
    return {
      channel: null,
      problem: `I could not find a channel called \`${String(token).slice(0, 60)}\`. Mention it as \`#channel\` or paste its id.`,
    };
  }

  return { channel, problem: null };
}

export function unsupportedProblem(channel) {
  return `${
    channel?.name ? `**#${channel.name}**` : 'That channel'
  } cannot be locked. Only text and voice channels have the permissions to change — open a category and lock its channels one by one.`;
}

export function threadProblem(channel) {
  const parent = channel?.parent ?? null;

  return `${channel} is a thread. Threads follow their parent channel, so lock ${
    parent ? parent : 'the channel the thread belongs to'
  } instead.`;
}

export function botPermissionProblem(channel) {
  return `I need **Manage Channels** in ${channel} to change its permissions.`;
}

export function discordProblem(error) {
  if (error?.code === 50013) {
    return 'Discord refused the permission change. Check that I have **Manage Channels** in that channel.';
  }

  return error?.message
    ? String(error.message).slice(0, 300)
    : 'Discord rejected the permission change.';
}

/** Consistent "unknown channel" reply for both commands. */
export function unknownChannel(ctx, problem) {
  return ctx.fail(ephemeral({ embeds: [errorEmbed('Unknown channel', problem)] }));
}
