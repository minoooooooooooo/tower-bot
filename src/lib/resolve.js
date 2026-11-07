import { normalizeForMatch } from './text.js';

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

/**
 * Finds roles whose name matches a typed word. Exact names win; otherwise
 * names that start with the word, then names that only contain it. Every role
 * at the best match level is returned, so the caller can refuse a word that
 * fits several roles instead of picking one at random.
 */
export function findRoleMatches(guild, token) {
  const needle = normalizeForMatch(String(token ?? '').replace(/^@/, ''));

  if (!needle) return [];

  const scored = [];

  for (const role of guild.roles?.cache?.values?.() ?? []) {
    const name = normalizeForMatch(role.name);

    if (!name) continue;

    let score = 0;

    if (name === needle) score = 3;
    else if (name.startsWith(needle)) score = 2;
    else if (name.includes(needle)) score = 1;

    if (score) scored.push({ role, score });
  }

  if (scored.length === 0) return [];

  const best = Math.max(...scored.map((entry) => entry.score));

  return scored
    .filter((entry) => entry.score === best)
    .map((entry) => entry.role)
    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0));
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

/**
 * Resolves a user who may no longer be in the server (ban/unban, profile
 * commands). Accepts a mention, a raw id, or a cached username.
 */
export async function resolveUser(client, token, message = null) {
  const ref = parseReference(token);

  if (ref) {
    if (ref.kind === 'role' || ref.kind === 'channel') return null;

    const mentioned = message?.mentions?.users?.get?.(ref.id);

    return (
      mentioned ??
      client.users.cache.get(ref.id) ??
      (await client.users.fetch(ref.id).catch(() => null))
    );
  }

  const name = String(token ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!name) return null;

  return (
    client.users.cache.find(
      (user) =>
        user.username.toLowerCase() === name ||
        user.tag?.toLowerCase() === name ||
        (user.globalName ?? '').toLowerCase() === name,
    ) ?? null
  );
}

/**
 * Resolves a server by id or by name among the servers the bot is already in.
 * `fetch` only works for servers the bot has joined, which is the best that is
 * possible: Discord hides private servers from bots outside them.
 */
export async function resolveGuild(client, token) {
  const raw = String(token ?? '').trim();
  if (!raw) return null;

  const ref = parseReference(raw);

  if (ref && ref.kind === 'id') {
    return (
      client.guilds.cache.get(ref.id) ??
      (await client.guilds.fetch(ref.id).catch(() => null))
    );
  }

  if (ref) return null;

  const name = raw.toLowerCase();

  return client.guilds.cache.find((guild) => guild.name.toLowerCase() === name) ?? null;
}
