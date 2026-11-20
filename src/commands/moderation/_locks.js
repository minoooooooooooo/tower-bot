import { resolveChannel } from '../../lib/resolve.js';
import { errorReply, ephemeral } from '../../lib/replies.js';

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
      problem: `ما لقيت قناة باسم \`${String(token).slice(0, 60)}\`. اذكرها كـ \`#channel\` أو الصق الآيدي.`,
    };
  }

  return { channel, problem: null };
}

export function unsupportedProblem(channel) {
  return `${
    channel?.name ? `**#${channel.name}**` : 'هذي القناة'
  } ما تنقفل. الأقفال تشتغل على قنوات النص والصوت بس — اقفل قنوات الفئة وحدة وحدة.`;
}

export function threadProblem(channel) {
  const parent = channel?.parent ?? null;

  return `${channel} موضوع. المواضيع تتبع قناتها الأم، فاقفل ${
    parent ? parent : 'القناة اللي يتبع لها الموضوع'
  } بدالها.`;
}

export function botPermissionProblem(channel) {
  return `أحتاج صلاحية **إدارة القنوات** في ${channel} عشان أعدّل صلاحياتها.`;
}

export function discordProblem(error) {
  if (error?.code === 50013) {
    return 'ديسكورد رفض تعديل الصلاحيات. تأكد أن عندي **إدارة القنوات** في القناة.';
  }

  return error?.message
    ? String(error.message).slice(0, 300)
    : 'ديسكورد رفض تعديل الصلاحيات.';
}

/** Consistent "unknown channel" reply for both commands. */
export function unknownChannel(ctx, problem) {
  return ctx.fail(ephemeral(errorReply('قناة غير معروفة', problem)));
}
