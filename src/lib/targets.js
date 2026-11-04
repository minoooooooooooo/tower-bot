import { resolveGuild, resolveMember, resolveUser } from './resolve.js';

async function refreshedUser(client, user) {
  if (!user) return null;

  // Banners are not part of the cached presence payload, so a fetch is needed
  // to render them reliably. A failed fetch still leaves the cached user.
  return client.users.fetch(user.id, { force: true }).catch(() => user);
}

/** The member a moderation command should act on. Null when they are not here. */
export async function targetMember(ctx, option = 'user') {
  if (ctx.isSlash) {
    const member = ctx.getMember(option);
    if (member) return member;

    const user = ctx.getUser(option);
    if (!user) return null;

    return ctx.guild.members.fetch(user.id).catch(() => null);
  }

  return resolveMember(ctx.guild, ctx.args[0], ctx.message);
}

/**
 * The user a profile command should show: the option/member on slash, the first
 * argument on prefix, and the invoker when nothing is given.
 */
export async function targetUser(ctx, client, option = 'user') {
  if (ctx.isSlash) {
    const user = ctx.getUser(option) ?? ctx.getMember(option)?.user ?? null;

    if (user) return refreshedUser(client, user);

    return refreshedUser(client, ctx.user);
  }

  const token = ctx.args[0];

  if (!token) return refreshedUser(client, ctx.user);

  const user = await resolveUser(client, token, ctx.message);

  return refreshedUser(client, user);
}

/** The server a profile command should show, defaulting to the current one. */
export async function targetGuild(ctx, client, option = 'server') {
  const token = ctx.isSlash ? ctx.getString(option) : ctx.args.join(' ').trim();

  if (!token) return ctx.guild;

  return resolveGuild(client, token);
}

export function displayNameOf(user, member = null) {
  return member?.displayName ?? user?.globalName ?? user?.username ?? 'Unknown user';
}
