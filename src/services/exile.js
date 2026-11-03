import { PermissionFlagsBits } from 'discord.js';
import { COLORS, embed } from '../lib/embeds.js';
import { createLogger } from '../lib/logger.js';
import {
  allExileRoleIds,
  getExileLogChannelId,
  levelLabel,
  listExceptionIds,
  listSetUpRoles,
} from './exile-store.js';

const logger = createLogger('exile');

const OVERWRITE_CONCURRENCY = 3;
const AUDIT_REASON_LIMIT = 500;

const warned = new Map();
const WARN_INTERVAL_MS = 60 * 60 * 1000;

function warnThrottled(key, message) {
  const now = Date.now();

  if (now - (warned.get(key) ?? 0) < WARN_INTERVAL_MS) return;

  warned.set(key, now);
  logger.warn(message);
}

function auditReason(text) {
  return String(text ?? '').slice(0, AUDIT_REASON_LIMIT);
}

/**
 * Validates the role a level is about to point at. Administrator is refused on
 * purpose: it bypasses channel overwrites, so a setup would silently do
 * nothing while `/exile` claimed success.
 */
export function roleProblem(guild, role) {
  if (!role) return 'Pick an exile role.';

  if (role.id === guild.id) {
    return 'The @everyone role cannot be used as an exile role.';
  }

  if (role.managed) {
    return `**${role.name}** is managed by an integration and cannot be assigned by hand.`;
  }

  if (role.permissions?.has(PermissionFlagsBits.Administrator)) {
    return `**${role.name}** has **Administrator**, which bypasses every channel permission. Remove it from the role first.`;
  }

  const me = guild.members?.me;

  if (!me) return 'I could not read my own server profile. Try again in a moment.';

  if (!me.permissions?.has(PermissionFlagsBits.ManageRoles)) {
    return 'I need the **Manage Roles** permission to edit channel permissions for that role.';
  }

  const botTop = me.roles?.highest?.position ?? 0;

  if (role.position >= botTop) {
    return `My highest role must sit **above ${role.name}**. Drag my role up in Server Settings → Roles, then try again.`;
  }

  return null;
}

/** Refuses targets the bot cannot meaningfully punish or outrank. */
export function memberProblem(guild, member) {
  if (!member) return 'Pick a member to exile.';

  if (member.user?.bot) return 'Bots cannot be exiled.';

  if (member.id === guild.ownerId) {
    return 'The server owner cannot be exiled — the owner bypasses every permission.';
  }

  const me = guild.members?.me;

  if (!me) return 'I could not read my own server profile. Try again in a moment.';

  if (member.id === me.id) return 'I cannot exile myself.';

  if (member.permissions?.has(PermissionFlagsBits.Administrator)) {
    return 'That member has **Administrator**, which bypasses every channel permission. Remove it first.';
  }

  const botTop = me.roles?.highest?.position ?? 0;

  if ((member.roles?.highest?.position ?? 0) >= botTop) {
    return `That member's highest role sits at or above mine, so I cannot change their roles. Move my role higher first.`;
  }

  return null;
}

/** Threads inherit their parent, and DM channels are not guild channels. */
export function isHideableChannel(channel) {
  if (!channel) return false;
  if (typeof channel.isThread === 'function' && channel.isThread()) return false;
  if (typeof channel.isDMBased === 'function' && channel.isDMBased()) return false;
  if (typeof channel.isTextBased !== 'function' && !channel.parentId && !channel.permissionOverwrites) {
    return false;
  }

  return typeof channel.permissionOverwrites?.edit === 'function';
}

async function fetchAllChannels(guild) {
  if (typeof guild.channels?.fetch === 'function') {
    try {
      const all = await guild.channels.fetch();

      if (all?.size) return [...all.values()];
    } catch (error) {
      logger.warn(
        `Could not fetch every channel in "${guild.name ?? guild.id}": ${error.message}`,
      );
    }
  }

  return [...(guild.channels?.cache?.values?.() ?? [])];
}

function currentOverwrite(channel, roleId) {
  return channel.permissionOverwrites?.cache?.get?.(roleId) ?? null;
}

function stateOf(channel, exceptionIds, exceptionParents) {
  if (exceptionIds.has(channel.id)) return 'allow';
  if (exceptionParents.has(channel.id)) return 'neutral';
  return 'deny';
}

async function editOverwrite(channel, role, state, reason) {
  const view = PermissionFlagsBits.ViewChannel;
  const overwrite = currentOverwrite(channel, role.id);

  if (state === 'deny') {
    if (overwrite?.deny?.has(view) && !overwrite?.allow?.has(view)) return false;

    await channel.permissionOverwrites.edit(
      role,
      { ViewChannel: false },
      { reason: auditReason(reason) },
    );
    return true;
  }

  if (state === 'allow') {
    if (overwrite?.allow?.has(view)) return false;

    await channel.permissionOverwrites.edit(
      role,
      { ViewChannel: true },
      { reason: auditReason(reason) },
    );
    return true;
  }

  // A category that contains an exception must not hide it. Clearing our own
  // overwrite is enough; the channel-level allow still wins.
  if (!overwrite) return false;
  if (!overwrite.allow?.has(view) && !overwrite.deny?.has(view)) return false;

  await channel.permissionOverwrites.edit(
    role,
    { ViewChannel: null },
    { reason: auditReason(reason) },
  );
  return true;
}

async function mapLimit(items, limit, run) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await run(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    () => worker(),
  );

  await Promise.all(workers);
  return results;
}

/**
 * Applies one role's rules to every channel in the guild. Safe to re-run: an
 * overwrite that already matches is left alone, which keeps a second setup from
 * spending its rate limit on no-ops.
 */
export async function reconcileRole(guild, role, exceptionIds, { reason } = {}) {
  const exceptions = new Set(exceptionIds);
  const channels = (await fetchAllChannels(guild)).filter(isHideableChannel);
  const parents = new Set();

  for (const channel of channels) {
    if (exceptions.has(channel.id) && channel.parentId) parents.add(channel.parentId);
  }

  const label = reason ?? `Exile setup: ${role.name}`;
  let updated = 0;
  let skipped = 0;
  const failed = [];

  await mapLimit(channels, OVERWRITE_CONCURRENCY, async (channel) => {
    const state = stateOf(channel, exceptions, parents);

    try {
      const changed = await editOverwrite(channel, role, state, label);

      if (changed) updated += 1;
      else skipped += 1;
    } catch (error) {
      failed.push({
        channelId: channel.id,
        name: channel.name ?? channel.id,
        message: error.message,
      });
    }
  });

  return { updated, skipped, failed, total: channels.length, allowed: exceptions.size };
}

/**
 * New channels and categories get the same treatment. One broken role must not
 * stop the rest, and the handler never throws into the gateway.
 */
export async function applyCreationRules(channel) {
  const guild = channel?.guild;

  if (!guild || !isHideableChannel(channel)) return { updated: 0, failed: 0 };

  let updated = 0;
  let failed = 0;

  for (const { roleId } of listSetUpRoles(guild.id)) {
    try {
      const role =
        guild.roles.cache.get(roleId) ??
        (await guild.roles.fetch(roleId).catch(() => null));

      if (!role) continue;

      const exceptions = new Set(listExceptionIds(guild.id, roleId));
      const state = exceptions.has(channel.id) ? 'allow' : 'deny';
      const reason = `Exile setup: new channel for ${role.name}`;

      if (await editOverwrite(channel, role, state, reason)) updated += 1;

      // A brand-new exception can land inside a category that was hidden
      // earlier; clearing the category deny keeps it findable in the sidebar.
      if (state === 'allow' && channel.parentId) {
        const parent =
          guild.channels.cache.get(channel.parentId) ??
          (await guild.channels.fetch(channel.parentId).catch(() => null));

        if (parent && isHideableChannel(parent)) {
          if (await editOverwrite(parent, role, 'neutral', reason)) updated += 1;
        }
      }
    } catch (error) {
      failed += 1;
      warnThrottled(
        `create:${guild.id}:${roleId}`,
        `Could not apply exile rules to #${channel.name ?? channel.id} in "${guild.name ?? guild.id}": ${error.message}`,
      );
    }
  }

  return { updated, failed };
}

/**
 * Adds the chosen level role and removes every other exile role, so a member
 * never accumulates levels. Returns the removed role ids.
 */
export async function assignExileRole(member, roleId, reason) {
  const ids = new Set(allExileRoleIds(member.guild.id));
  ids.add(roleId);

  const removed = [];
  const failed = [];

  for (const id of ids) {
    if (id === roleId) continue;
    if (!member.roles.cache.has(id)) continue;

    try {
      await member.roles.remove(id, auditReason(reason));
      removed.push(id);
    } catch (error) {
      failed.push({ roleId: id, message: error.message });
    }
  }

  let added = false;

  if (!member.roles.cache.has(roleId)) {
    await member.roles.add(roleId, auditReason(reason));
    added = true;
  }

  return { added, removed, failed };
}

/** Removes every exile role the member still holds. */
export async function removeExileRoles(member, extraRoleId, reason) {
  const ids = new Set(allExileRoleIds(member.guild.id));

  if (extraRoleId) ids.add(extraRoleId);

  const removed = [];
  const failed = [];

  for (const id of ids) {
    if (!member.roles.cache.has(id)) continue;

    try {
      await member.roles.remove(id, auditReason(reason));
      removed.push(id);
    } catch (error) {
      failed.push({ roleId: id, message: error.message });
    }
  }

  return { removed, failed };
}

function auditFields({ userId, actorId, level, roleId, reason, at, releasedAt }) {
  const fields = [
    { name: 'Member', value: `<@${userId}>`, inline: true },
    { name: 'Level', value: levelLabel(level), inline: true },
    { name: 'Role', value: `<@&${roleId}>`, inline: true },
    { name: 'By', value: `<@${actorId}>`, inline: true },
  ];

  if (releasedAt) {
    const seconds = Math.max(0, Math.round((releasedAt - at) / 1000));
    fields.push({ name: 'Held for', value: `${Math.floor(seconds / 60)}m`, inline: true });
  }

  fields.push({
    name: 'Reason',
    value: reason?.trim() ? reason.trim().slice(0, 300) : '—',
    inline: false,
  });

  return fields;
}

/**
 * Posts one embed in the configured audit channel. Never throws: a missing or
 * unwritable log channel must not make exiling fail.
 */
export async function sendExileLog(guild, entry) {
  const channelId = getExileLogChannelId(guild.id);

  if (!channelId) return false;

  let channel;

  try {
    channel =
      guild.channels.cache.get(channelId) ??
      (await guild.channels.fetch(channelId));
  } catch {
    channel = null;
  }

  if (!channel?.isTextBased?.()) {
    warnThrottled(
      `log-missing:${guild.id}:${channelId}`,
      `Exile log channel ${channelId} is missing or not text-based in "${guild.name ?? guild.id}".`,
    );
    return false;
  }

  const me = guild.members?.me;
  const permissions = me ? channel.permissionsFor?.(me) : null;

  if (
    permissions &&
    !permissions.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ])
  ) {
    warnThrottled(
      `log-perm:${guild.id}:${channelId}`,
      `Cannot post in the exile log channel #${channel.name ?? channelId}: needs View Channel, Send Messages and Embed Links.`,
    );
    return false;
  }

  const titles = {
    exile: 'Member exiled',
    level: 'Exile level changed',
    release: 'Member released',
  };
  const colors = {
    exile: COLORS.danger,
    level: COLORS.warning,
    release: COLORS.success,
  };

  try {
    await channel.send({
      allowedMentions: { parse: [] },
      embeds: [
        embed({
          title: titles[entry.type] ?? 'Exile update',
          fields: auditFields(entry),
          color: colors[entry.type] ?? COLORS.primary,
          footer: entry.footer,
        }),
      ],
    });
    return true;
  } catch (error) {
    warnThrottled(
      `log-send:${guild.id}:${channelId}`,
      `Could not post in the exile log channel #${channel.name ?? channelId}: ${error.message}`,
    );
    return false;
  }
}
