const REFERENCE = /^<(@[!&]?|#)([^>\s]+)>$/;
const RAW_ID = /^\d{17,20}$/;

/**
 * Classifies one prefix token:
 * `{ kind: 'user'|'role'|'channel'|'id', id }`, or null when it is a plain word
 * (a role/channel name lookup is then up to the caller).
 */
export function parseReference(token) {
  const raw = String(token ?? '').trim();
  const mention = REFERENCE.exec(raw);

  if (mention) {
    const [, prefix, id] = mention;

    if (prefix === '#') return { kind: 'channel', id };
    if (prefix === '@&') return { kind: 'role', id };
    if (prefix === '@' || prefix === '@!') return { kind: 'user', id };
  }

  if (RAW_ID.test(raw)) return { kind: 'id', id: raw };

  return null;
}

export async function resolveRole(guild, token) {
  const ref = parseReference(token);

  if (ref) {
    if (ref.kind === 'channel' || ref.kind === 'user') return null;

    return guild.roles.cache.get(ref.id) ?? (await guild.roles.fetch(ref.id).catch(() => null));
  }

  const name = String(token ?? '').trim().replace(/^@/, '').toLowerCase();

  if (!name) return null;

  return (
    guild.roles.cache.find((role) => role.name.toLowerCase() === name) ?? null
  );
}

export async function resolveChannel(guild, token) {
  const ref = parseReference(token);

  if (ref) {
    if (ref.kind === 'role' || ref.kind === 'user') return null;

    return (
      guild.channels.cache.get(ref.id) ??
      (await guild.channels.fetch(ref.id).catch(() => null))
    );
  }

  const name = String(token ?? '').trim().replace(/^#/, '').toLowerCase();

  if (!name) return null;

  return (
    guild.channels.cache.find((channel) => channel.name?.toLowerCase() === name) ?? null
  );
}

export async function resolveMember(guild, token, message = null) {
  const ref = parseReference(token);

  if (!ref) return null;
  if (ref.kind === 'role' || ref.kind === 'channel') return null;

  const mentioned = message?.mentions?.members?.get?.(ref.id);

  if (mentioned) return mentioned;

  return (
    guild.members.cache.get(ref.id) ??
    (await guild.members.fetch(ref.id).catch(() => null))
  );
}
