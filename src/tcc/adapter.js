// Tower Control Center integration for 11/10.
//
// Additive only: it registers extra listeners and answers signed commands from
// the Tower Control Center backend. Every existing slash/prefix command keeps
// working exactly as before, and with TCC_URL / TCC_AGENT_SECRET unset this
// file does nothing at all.
//
// The website has no bot token. Everything it does to the Discord server goes
// through this adapter, which reuses the bot's own stores and hierarchy checks.

import path from 'node:path';
import { AuditLogEvent, ChannelType, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { config, rootDir } from '../config.js';
import { closeDb, getDb } from '../lib/db.js';
import { createLogger } from '../lib/logger.js';
import { actorProblem, botPermissionProblem, MAX_TIMEOUT_MS, targetProblem } from '../services/moderation.js';
import { getMuteRoleId } from '../services/moderation-store.js';
import { allExileRoleIds, countActiveExiles, getActiveExile, listRoleMappings } from '../services/exile-store.js';
import { memberStats, messagesSince, voiceSince } from '../services/activity-store.js';
import { emojiCoverageSince } from '../services/emoji-store.js';
import { getWelcomeSettings, MODES, updateWelcomeSettings } from '../services/welcome-store.js';
import {
  addWatchTerm, getWatchChannelId, listIgnoredChannels, listWatchTerms, removeWatchTerm, setWatchChannelId,
} from '../services/watch-store.js';
import { getSummaryChannel, listGlossary, listSchedules } from '../services/report-store.js';
import { listTicketTypes, ticketCounts } from '../services/ticket-store.js';
import { listAliases } from '../services/alias-store.js';
import { listGrants } from '../services/permission-store.js';
import { fail, startAgent } from './tcc-agent.mjs';

const MEMBER_CACHE_MS = 5 * 60_000;
const DANGEROUS = [
  'Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'BanMembers', 'KickMembers',
  'ModerateMembers', 'ManageWebhooks', 'MentionEveryone', 'ManageMessages', 'ManageGuildExpressions',
];
const AUDIT_GROUPS = {
  moderation: ['MemberKick', 'MemberBanAdd', 'MemberBanRemove', 'MemberUpdate', 'MemberRoleUpdate', 'MemberPrune'],
  roles: ['RoleCreate', 'RoleUpdate', 'RoleDelete', 'MemberRoleUpdate'],
  channels: ['ChannelCreate', 'ChannelUpdate', 'ChannelDelete', 'ChannelOverwriteCreate', 'ChannelOverwriteUpdate', 'ChannelOverwriteDelete'],
  emojis: ['EmojiCreate', 'EmojiUpdate', 'EmojiDelete'],
};
const AUDIT_NAMES = Object.fromEntries(Object.entries(AuditLogEvent).filter(([, v]) => typeof v === 'number').map(([k, v]) => [v, k]));

export function startTowerAgent(client) {
  const memberFetch = new Map();
  const hourly = new Map();
  let readySince = 0;

  const guildOf = (args) => {
    const guild = client.guilds.cache.get(String(args?.guildId ?? config.guildId ?? '')) ?? null;
    if (!guild) fail('guild_unavailable', 'The bot is not connected to that server right now.');
    return guild;
  };

  async function ensureMembers(guild) {
    const last = memberFetch.get(guild.id) ?? 0;
    if (Date.now() - last > MEMBER_CACHE_MS || guild.members.cache.size < Math.min(guild.memberCount, 2)) {
      await guild.members.fetch();
      memberFetch.set(guild.id, Date.now());
    }
    return guild.members.cache;
  }

  async function memberOf(guild, id) {
    const member = guild.members.cache.get(String(id)) ?? (await guild.members.fetch(String(id)).catch(() => null));
    if (!member) fail('member_not_found', 'That user is not a member of the server.');
    return member;
  }

  const reasonFor = (args) => `[TCC] ${args.actorLabel ?? 'unknown'} (${args.actorId ?? '?'}): ${args.reason || 'No reason given'}`.slice(0, 500);
  const requireBot = (guild, flag, label) => { const p = botPermissionProblem(guild, flag, label); if (p) fail('bot_missing_permission', p); };
  const actorOf = (guild, args) => guild.members.cache.get(String(args.actorId)) ?? null;
  const actorIsDiscordAdmin = (guild, actor) => Boolean(actor && (actor.id === guild.ownerId || actor.permissions.has(PermissionFlagsBits.Administrator)));

  /** Same rules the bot's own moderation commands apply: bot hierarchy, target sanity, and the acting person's hierarchy. */
  async function moderationTarget(guild, args, options) {
    const target = await memberOf(guild, args.id);
    const problem = targetProblem(guild, target, String(args.actorId), options);
    if (problem) fail('target_rejected', problem);
    const actor = actorOf(guild, args) ?? (await guild.members.fetch(String(args.actorId)).catch(() => null));
    if (actor) {
      const p = actorProblem(guild, actor, target);
      if (p) fail('hierarchy', p.replace('Your', 'The acting user’s'));
    }
    return target;
  }

  const label = (member) => member?.user?.tag ?? member?.user?.username ?? String(member?.id ?? '');
  const avatar = (user) => user?.displayAvatarURL?.({ size: 128, extension: 'webp' }) ?? null;

  function presentMember(member, messages) {
    return {
      id: member.id,
      username: member.user.username,
      globalName: member.user.globalName ?? null,
      displayName: member.displayName,
      avatarUrl: avatar(member),
      bot: member.user.bot,
      joinedAt: member.joinedTimestamp ?? null,
      roles: [...member.roles.cache.keys()].filter((id) => id !== member.guild.id),
      topRoleId: member.roles.highest?.id === member.guild.id ? null : member.roles.highest?.id ?? null,
      status: member.presence?.status ?? 'offline',
      timedOutUntil: member.communicationDisabledUntilTimestamp > Date.now() ? member.communicationDisabledUntilTimestamp : null,
      messages: messages ?? 0,
    };
  }

  function presentRole(role, guild) {
    const perms = role.permissions.toArray();
    return {
      id: role.id,
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      managed: role.managed,
      position: role.position,
      isEveryone: role.id === guild.id,
      memberCount: role.id === guild.id ? guild.memberCount : role.members.size,
      permissions: perms,
      dangerous: perms.filter((p) => DANGEROUS.includes(p)),
      editableByBot: role.editable && !role.managed && role.id !== guild.id,
      usedByBot: allExileRoleIds(guild.id).includes(role.id) ? 'exile' : getMuteRoleId(guild.id) === role.id ? 'mute' : null,
    };
  }

  function editableRole(guild, args, roleId, { forAssignment = false } = {}) {
    const role = guild.roles.cache.get(String(roleId));
    if (!role) fail('role_not_found', 'Role not found.');
    if (role.id === guild.id) fail('role_protected', '@everyone cannot be changed here.');
    if (role.managed) fail('role_protected', 'This role is managed by an integration.');
    requireBot(guild, PermissionFlagsBits.ManageRoles, 'Manage Roles');
    if (!role.editable) fail('hierarchy', `My highest role must sit above ${role.name}.`);
    const actor = actorOf(guild, args);
    if (!actorIsDiscordAdmin(guild, actor)) {
      if (!actor || actor.roles.highest.position <= role.position) fail('hierarchy', 'The acting user’s highest Discord role must sit above this role.');
      const risky = role.permissions.toArray().filter((p) => DANGEROUS.includes(p));
      if (forAssignment && risky.length > 0) fail('role_protected', `Only a Discord administrator can hand out a role with: ${risky.join(', ')}.`);
    }
    return role;
  }

  // Resolves YYYY-MM-DD bounds for the bot's daily buckets (bot time zone). Default: last 30 days.
  function days(args) {
    const fmt = (d) => d.toISOString().slice(0, 10);
    const to = args.to ?? fmt(new Date());
    const from = args.from ?? fmt(new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86400_000));
    const span = Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000) + 1);
    return { from, to, span };
  }

  const nameOf = (guild, userId) => {
    const m = guild.members.cache.get(userId);
    return m ? { displayName: m.displayName, username: m.user.username, avatarUrl: avatar(m), inServer: true } : { displayName: null, username: null, avatarUrl: null, inServer: false };
  };

  const commands = {
    'commands.list': () => [...client.commands.values()].map((c) => ({
      name: c.name,
      description: c.data?.description ?? c.description ?? '',
      slash: Boolean(c.data),
      prefix: `${config.prefix}${c.name}`,
      aliases: c.aliases ?? [],
      ownerOnly: Boolean(c.ownerOnly),
      permissions: (c.permissions ?? []).map((p) => Object.keys(PermissionFlagsBits).find((k) => PermissionFlagsBits[k] === p) ?? String(p)),
      remote: false,
    })).sort((a, b) => a.name.localeCompare(b.name)),

    'guild.overview': async (args) => {
      const guild = guildOf(args);
      const members = await ensureMembers(guild);
      const byType = (t) => guild.channels.cache.filter((c) => c.type === t).size;
      return {
        id: guild.id,
        name: guild.name,
        iconUrl: guild.iconURL({ size: 256 }),
        bannerUrl: guild.bannerURL({ size: 1024 }),
        ownerId: guild.ownerId,
        createdAt: guild.createdTimestamp,
        memberCount: guild.memberCount,
        humans: members.filter((m) => !m.user.bot).size,
        bots: members.filter((m) => m.user.bot).size,
        // Counted from gateway presences this bot currently holds.
        onlineCount: guild.presences.cache.filter((p) => p.status !== 'offline').size,
        voiceCount: guild.voiceStates.cache.filter((v) => v.channelId).size,
        channels: { text: byType(ChannelType.GuildText), voice: byType(ChannelType.GuildVoice), categories: byType(ChannelType.GuildCategory), total: guild.channels.cache.size },
        roles: guild.roles.cache.size - 1,
        emojis: guild.emojis.cache.size,
        boosts: guild.premiumSubscriptionCount ?? 0,
        boostTier: guild.premiumTier,
        tracking: { messagesSince: messagesSince(guild.id), voiceSince: voiceSince(guild.id), emojiSince: emojiCoverageSince(guild.id), timezone: config.timezone },
      };
    },

    'members.list': async (args) => {
      const guild = guildOf(args);
      const members = await ensureMembers(guild);
      const counts = new Map(getDb().prepare('SELECT user_id, messages FROM activity_members WHERE guild_id = ?').all(guild.id).map((r) => [r.user_id, r.messages]));
      const q = args.q?.toLowerCase();
      let list = [...members.values()].filter((m) => {
        if (args.filter === 'humans' && m.user.bot) return false;
        if (args.filter === 'bots' && !m.user.bot) return false;
        if (args.filter === 'timed_out' && !(m.communicationDisabledUntilTimestamp > Date.now())) return false;
        if (args.role && !m.roles.cache.has(args.role)) return false;
        if (q && !(m.id === q || m.user.username.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q) || (m.user.globalName ?? '').toLowerCase().includes(q))) return false;
        return true;
      });
      const sorters = {
        joined_desc: (a, b) => (b.joinedTimestamp ?? 0) - (a.joinedTimestamp ?? 0),
        joined_asc: (a, b) => (a.joinedTimestamp ?? 0) - (b.joinedTimestamp ?? 0),
        name: (a, b) => a.displayName.localeCompare(b.displayName),
        messages: (a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0),
      };
      list.sort(sorters[args.sort] ?? sorters.joined_desc);
      const total = list.length;
      list = list.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 50));
      return { total, members: list.map((m) => presentMember(m, counts.get(m.id))) };
    },

    'member.get': async (args) => {
      const guild = guildOf(args);
      const member = await memberOf(guild, args.id);
      const stats = memberStats(guild.id, member.id, days({}).from);
      const profile = getDb().prepare('SELECT title, nightmare, vex, punish_mini, good_behavior FROM profiles WHERE guild_id = ? AND user_id = ?').get(guild.id, member.id) ?? null;
      const exiles = getDb().prepare('SELECT level, reason, created_by, created_at, released_by, released_at, release_reason FROM exiles WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 20').all(guild.id, member.id);
      const expiries = getDb().prepare('SELECT kind, reason, created_by, created_at, expires_at FROM moderation_expiries WHERE guild_id = ? AND user_id = ?').all(guild.id, member.id);
      const me = guild.members.me;
      return {
        // Owned by Discord and the user: shown, never editable here.
        discordAccount: { id: member.id, username: member.user.username, globalName: member.user.globalName ?? null, bot: member.user.bot, createdAt: member.user.createdTimestamp, avatarUrl: avatar(member.user) },
        // Server membership: the parts Discord lets a bot change.
        membership: {
          ...presentMember(member, stats.messages),
          nickname: member.nickname,
          boostingSince: member.premiumSinceTimestamp ?? null,
          pending: member.pending,
          isOwner: member.id === guild.ownerId,
          isAdmin: member.permissions.has(PermissionFlagsBits.Administrator),
          manageableByBot: member.manageable,
          moderatableByBot: member.moderatable,
          kickableByBot: member.kickable,
          bannableByBot: member.bannable,
          botCanManageNicknames: Boolean(me?.permissions.has(PermissionFlagsBits.ManageNicknames)),
        },
        // Stored by 11/10 in its own database.
        botData: { activity: stats, profile, activeExile: getActiveExile(guild.id, member.id) ?? null, exileHistory: exiles, temporaryActions: expiries, messagesSince: messagesSince(guild.id), voiceSince: voiceSince(guild.id) },
      };
    },

    'member.notify': async (args) => {
      const user = await client.users.fetch(String(args.id)).catch(() => null);
      if (!user) fail('member_not_found', 'User not found.');
      try { await user.send({ content: String(args.message).slice(0, 1500) }); } catch { fail('dm_closed', 'The user does not accept direct messages from the bot.'); }
      return { delivered: true };
    },

    'member.nickname': async (args) => {
      const guild = guildOf(args);
      requireBot(guild, PermissionFlagsBits.ManageNicknames, 'Manage Nicknames');
      const target = await memberOf(guild, args.id);
      if (!target.manageable) fail('hierarchy', 'My highest role must sit above that member’s highest role (and the server owner cannot be renamed).');
      const actor = actorOf(guild, args);
      if (actor && actor.id !== target.id) { const p = actorProblem(guild, actor, target); if (p) fail('hierarchy', p); }
      await target.setNickname(args.nick || null, reasonFor(args));
      return { targetLabel: label(target), nickname: args.nick || null };
    },

    'member.role.add': async (args) => {
      const guild = guildOf(args);
      const role = editableRole(guild, args, args.roleId, { forAssignment: true });
      const target = await memberOf(guild, args.id);
      await target.roles.add(role, reasonFor(args));
      return { targetLabel: label(target), role: role.name };
    },
    'member.role.remove': async (args) => {
      const guild = guildOf(args);
      const role = editableRole(guild, args, args.roleId);
      const target = await memberOf(guild, args.id);
      await target.roles.remove(role, reasonFor(args));
      return { targetLabel: label(target), role: role.name };
    },

    'member.kick': async (args) => {
      const guild = guildOf(args);
      requireBot(guild, PermissionFlagsBits.KickMembers, 'Kick Members');
      const target = await moderationTarget(guild, args, { allowBot: true });
      const name = label(target);
      await target.kick(reasonFor(args));
      return { targetLabel: name };
    },
    'member.ban': async (args) => {
      const guild = guildOf(args);
      requireBot(guild, PermissionFlagsBits.BanMembers, 'Ban Members');
      const inGuild = guild.members.cache.get(String(args.id)) ?? (await guild.members.fetch(String(args.id)).catch(() => null));
      let name = String(args.id);
      if (inGuild) name = label(await moderationTarget(guild, args, { allowBot: true }));
      else if (String(args.id) === guild.ownerId || String(args.id) === client.user.id) fail('target_rejected', 'That account cannot be banned.');
      await guild.bans.create(String(args.id), { reason: reasonFor(args), deleteMessageSeconds: args.deleteMessageSeconds ?? 0 });
      return { targetLabel: name };
    },
    'member.unban': async (args) => {
      const guild = guildOf(args);
      requireBot(guild, PermissionFlagsBits.BanMembers, 'Ban Members');
      const ban = await guild.bans.fetch(String(args.id)).catch(() => null);
      if (!ban) fail('not_banned', 'That user is not banned.');
      await guild.bans.remove(String(args.id), reasonFor(args));
      return { targetLabel: ban.user?.tag ?? String(args.id) };
    },
    'member.timeout': async (args) => {
      const guild = guildOf(args);
      requireBot(guild, PermissionFlagsBits.ModerateMembers, 'Moderate Members');
      const target = await moderationTarget(guild, args);
      if (target.permissions.has(PermissionFlagsBits.Administrator)) fail('target_rejected', 'Discord does not allow timing out an administrator.');
      await target.timeout(Math.min(Number(args.durationMs), MAX_TIMEOUT_MS), reasonFor(args));
      return { targetLabel: label(target), until: target.communicationDisabledUntilTimestamp };
    },
    'member.untimeout': async (args) => {
      const guild = guildOf(args);
      requireBot(guild, PermissionFlagsBits.ModerateMembers, 'Moderate Members');
      const target = await moderationTarget(guild, args);
      await target.timeout(null, reasonFor(args));
      return { targetLabel: label(target) };
    },

    'bans.list': async (args) => {
      const guild = guildOf(args);
      requireBot(guild, PermissionFlagsBits.BanMembers, 'Ban Members');
      const bans = await guild.bans.fetch({ limit: 1000 });
      return bans.map((b) => ({ id: b.user.id, username: b.user.username, avatarUrl: avatar(b.user), reason: b.reason ?? null }));
    },

    'auditlog.list': async (args) => {
      const guild = guildOf(args);
      requireBot(guild, PermissionFlagsBits.ViewAuditLog, 'View Audit Log');
      const logs = await guild.fetchAuditLogs({ limit: 100 });
      const wanted = args.type && args.type !== 'all' ? AUDIT_GROUPS[args.type] : null;
      return [...logs.entries.values()]
        .map((e) => ({
          id: e.id,
          action: AUDIT_NAMES[e.action] ?? String(e.action),
          executor: e.executor ? { id: e.executor.id, username: e.executor.username, bot: e.executor.bot } : null,
          targetId: e.targetId ?? null,
          targetName: e.target?.username ?? e.target?.name ?? null,
          reason: e.reason ?? null,
          createdAt: e.createdTimestamp,
          changes: (e.changes ?? []).map((c) => c.key).slice(0, 12),
        }))
        .filter((e) => !wanted || wanted.includes(e.action))
        .slice(0, args.limit ?? 50);
    },

    'roles.list': async (args) => {
      const guild = guildOf(args);
      await ensureMembers(guild);
      return [...guild.roles.cache.values()].sort((a, b) => b.position - a.position).map((r) => presentRole(r, guild));
    },
    'role.create': async (args) => {
      const guild = guildOf(args);
      requireBot(guild, PermissionFlagsBits.ManageRoles, 'Manage Roles');
      // Created without any permission: permissions are deliberately not editable from the website.
      const role = await guild.roles.create({ name: args.name, color: args.color ?? 0, hoist: Boolean(args.hoist), mentionable: Boolean(args.mentionable), permissions: [], reason: reasonFor(args) });
      return presentRole(role, guild);
    },
    'role.update': async (args) => {
      const guild = guildOf(args);
      const role = editableRole(guild, args, args.id);
      const patch = {};
      for (const key of ['name', 'color', 'hoist', 'mentionable']) if (args[key] !== undefined) patch[key] = args[key];
      return presentRole(await role.edit({ ...patch, reason: reasonFor(args) }), guild);
    },
    'role.delete': async (args) => {
      const guild = guildOf(args);
      const role = editableRole(guild, args, args.id);
      const risky = role.permissions.toArray().filter((p) => DANGEROUS.includes(p));
      if (risky.length > 0) fail('role_protected', 'Roles that carry moderation or administration permissions must be deleted in Discord itself.');
      if (allExileRoleIds(guild.id).includes(role.id) || getMuteRoleId(guild.id) === role.id) fail('role_protected', 'This role is used by the bot’s exile or mute system.');
      const name = role.name;
      await role.delete(reasonFor(args));
      return { deleted: name };
    },

    'channels.list': (args) => {
      const guild = guildOf(args);
      return [...guild.channels.cache.values()].filter((c) => !c.isThread()).map((c) => ({
        id: c.id,
        name: c.name,
        type: ChannelType[c.type] ?? String(c.type),
        parentId: c.parentId ?? null,
        position: c.rawPosition ?? c.position ?? 0,
        topic: c.topic ?? null,
        nsfw: Boolean(c.nsfw),
        slowmode: c.rateLimitPerUser ?? null,
        manageableByBot: c.manageable,
        overwrites: [...(c.permissionOverwrites?.cache.values() ?? [])].map((o) => ({ id: o.id, kind: o.type === 0 ? 'role' : 'member', allow: o.allow.toArray(), deny: o.deny.toArray() })),
      })).sort((a, b) => a.position - b.position);
    },
    'channel.update': async (args) => {
      const guild = guildOf(args);
      const channel = guild.channels.cache.get(String(args.id));
      if (!channel || channel.isThread()) fail('channel_not_found', 'Channel not found.');
      requireBot(guild, PermissionFlagsBits.ManageChannels, 'Manage Channels');
      if (!channel.manageable) fail('bot_missing_permission', 'I cannot manage that channel.');
      const patch = {};
      if (args.name !== undefined) patch.name = args.name;
      if (args.topic !== undefined && 'topic' in channel) patch.topic = args.topic;
      if (args.nsfw !== undefined && 'nsfw' in channel) patch.nsfw = args.nsfw;
      if (args.slowmode !== undefined && 'rateLimitPerUser' in channel) patch.rateLimitPerUser = args.slowmode;
      if (Object.keys(patch).length === 0) fail('nothing_to_change', 'None of these settings exist on this channel type.');
      const updated = await channel.edit({ ...patch, reason: reasonFor(args) });
      return { id: updated.id, name: updated.name };
    },

    'emojis.list': (args) => {
      const guild = guildOf(args);
      const ranged = Boolean(args.from || args.to);
      const { from, to } = days(args);
      const usage = new Map((ranged
        ? getDb().prepare('SELECT emoji_id AS id, SUM(inline_count) AS inl, SUM(standalone_count) AS alone, MAX(last_used_at) AS last FROM emoji_usage WHERE guild_id = ? AND day >= ? AND day <= ? GROUP BY emoji_id').all(guild.id, from, to)
        : getDb().prepare('SELECT emoji_id AS id, SUM(inline_count) AS inl, SUM(standalone_count) AS alone, MAX(last_used_at) AS last FROM emoji_usage WHERE guild_id = ? GROUP BY emoji_id').all(guild.id)
      ).map((r) => [r.id, r]));
      const lastEver = new Map(getDb().prepare('SELECT emoji_id AS id, last_used_at AS last FROM emoji_catalog WHERE guild_id = ?').all(guild.id).map((r) => [r.id, r.last]));
      const me = guild.members.me;
      return {
        trackingSince: emojiCoverageSince(guild.id),
        range: ranged ? { from, to } : null,
        timezone: config.timezone,
        botCanDelete: Boolean(me?.permissions.has(PermissionFlagsBits.ManageGuildExpressions)),
        // Only custom emojis inside message text are counted. Reactions are not tracked by 11/10.
        counts: 'messages',
        emojis: [...guild.emojis.cache.values()].map((e) => {
          const u = usage.get(e.id);
          return {
            id: e.id, name: e.name, animated: Boolean(e.animated), url: e.imageURL({ size: 64 }), createdAt: e.createdTimestamp, managed: e.managed, available: e.available !== false,
            uses: (u?.inl ?? 0) + (u?.alone ?? 0), inline: u?.inl ?? 0, standalone: u?.alone ?? 0,
            lastUsedAt: lastEver.get(e.id) ?? u?.last ?? null,
          };
        }),
      };
    },
    'emoji.delete': async (args) => {
      const guild = guildOf(args);
      requireBot(guild, PermissionFlagsBits.ManageGuildExpressions, 'Manage Expressions');
      const emoji = guild.emojis.cache.get(String(args.id));
      if (!emoji) fail('emoji_not_found', 'Emoji not found.');
      if (emoji.managed || !emoji.deletable) fail('emoji_protected', 'Discord does not allow this emoji to be deleted by the bot.');
      const name = emoji.name;
      await emoji.delete(reasonFor(args));
      return { deleted: name };
    },

    'analytics.server': async (args) => {
      const guild = guildOf(args);
      const { from, to, span } = days(args);
      const db = getDb();
      const daily = db.prepare(
        `SELECT day, SUM(messages) AS messages, SUM(voice_seconds) AS voiceSeconds, COUNT(DISTINCT CASE WHEN messages > 0 THEN user_id END) AS activeMembers
           FROM activity_member_days WHERE guild_id = ? AND day >= ? AND day <= ? GROUP BY day ORDER BY day`).all(guild.id, from, to);
      const topChannels = db.prepare(
        `SELECT channel_id AS channelId, SUM(messages) AS messages, SUM(voice_seconds) AS voiceSeconds
           FROM activity_channel_days WHERE guild_id = ? AND day >= ? AND day <= ? GROUP BY channel_id ORDER BY SUM(messages) DESC LIMIT 15`).all(guild.id, from, to)
        .map((c) => ({ ...c, name: guild.channels.cache.get(c.channelId)?.name ?? null }));
      const totals = daily.reduce((a, d) => ({ messages: a.messages + d.messages, voiceSeconds: a.voiceSeconds + d.voiceSeconds }), { messages: 0, voiceSeconds: 0 });
      // The window just before, same length, for comparisons.
      const prevTo = new Date(Date.parse(`${from}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);
      const prevFrom = new Date(Date.parse(`${prevTo}T00:00:00Z`) - (span - 1) * 86400_000).toISOString().slice(0, 10);
      const previous = db.prepare('SELECT COALESCE(SUM(messages), 0) AS messages, COALESCE(SUM(voice_seconds), 0) AS voiceSeconds FROM activity_member_days WHERE guild_id = ? AND day >= ? AND day <= ?').get(guild.id, prevFrom, prevTo);
      const [active] = [db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM activity_member_days WHERE guild_id = ? AND day >= ? AND day <= ? AND messages > 0').get(guild.id, from, to)];
      return {
        from, to, days: span, timezone: config.timezone, daily, topChannels, totals: { ...totals, activeMembers: active?.n ?? 0, memberCount: guild.memberCount },
        previous: { from: prevFrom, to: prevTo, ...previous },
        tracking: { messagesSince: messagesSince(guild.id), voiceSince: voiceSince(guild.id) },
      };
    },

    'analytics.messages': async (args) => {
      const guild = guildOf(args);
      await ensureMembers(guild);
      const { from, to, span } = days(args);
      const rows = getDb().prepare(
        `SELECT user_id AS userId, SUM(messages) AS messages, SUM(voice_seconds) AS voiceSeconds, COUNT(CASE WHEN messages > 0 THEN 1 END) AS activeDays
           FROM activity_member_days WHERE guild_id = ? AND day >= ? AND day <= ? GROUP BY user_id HAVING SUM(messages) > 0
           ORDER BY SUM(messages) DESC, user_id LIMIT ?`).all(guild.id, from, to, args.limit ?? 25);
      return {
        from, to, days: span, timezone: config.timezone, tracking: { messagesSince: messagesSince(guild.id) },
        ranking: rows.map((r, i) => ({ rank: i + 1, ...r, averagePerDay: Math.round((r.messages / span) * 10) / 10, ...nameOf(guild, r.userId) })),
      };
    },

    'analytics.member': async (args) => {
      const guild = guildOf(args);
      const { from, to, span } = days(args);
      const db = getDb();
      const id = String(args.id);
      const sum = (since) => db.prepare('SELECT COALESCE(SUM(messages), 0) AS n FROM activity_member_days WHERE guild_id = ? AND user_id = ? AND day >= ?').get(guild.id, id, since).n;
      const today = new Date().toISOString().slice(0, 10);
      const back = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
      const daily = db.prepare('SELECT day, messages, voice_seconds AS voiceSeconds FROM activity_member_days WHERE guild_id = ? AND user_id = ? AND day >= ? AND day <= ? ORDER BY day').all(guild.id, id, from, to);
      const inRange = daily.reduce((a, d) => a + d.messages, 0);
      const rank = db.prepare(
        `SELECT COUNT(*) + 1 AS rank FROM (SELECT user_id FROM activity_member_days WHERE guild_id = ? AND day >= ? AND day <= ? GROUP BY user_id HAVING SUM(messages) > ?)`).get(guild.id, from, to, inRange).rank;
      return {
        from, to, days: span, timezone: config.timezone,
        allTime: memberStats(guild.id, id),
        counts: { today: sum(today), last7: sum(back(6)), last30: sum(back(29)), range: inRange, averagePerDay: Math.round((inRange / span) * 10) / 10 },
        rank: inRange > 0 ? rank : null,
        daily,
        // 11/10 stores per-member and per-channel totals separately; it does not record which member wrote in which channel, or at what hour.
        perChannel: null,
        perHour: null,
        tracking: { messagesSince: messagesSince(guild.id), voiceSince: voiceSince(guild.id) },
      };
    },

    'welcome.get': (args) => {
      const guild = guildOf(args);
      return { ...getWelcomeSettings(guild.id), modes: MODES, active: Boolean(getWelcomeSettings(guild.id).channelId) };
    },
    'welcome.set': (args) => {
      const guild = guildOf(args);
      const patch = {};
      for (const key of ['channelId', 'rulesChannelId', 'generalChannelId']) {
        if (args[key] === undefined) continue;
        if (args[key] !== null && !guild.channels.cache.get(args[key])?.isTextBased()) fail('channel_not_found', `${key}: not a text channel in this server.`);
        patch[key] = args[key];
      }
      if (args.mode !== undefined) patch.mode = args.mode;
      return updateWelcomeSettings(guild.id, patch);
    },

    'watch.get': (args) => {
      const guild = guildOf(args);
      return { channelId: getWatchChannelId(guild.id), terms: listWatchTerms(guild.id), ignoredChannels: listIgnoredChannels(guild.id), note: 'Keyword watch posts an alert in the chosen channel. It does not delete messages or punish members.' };
    },
    'watch.addTerm': (args) => {
      const r = addWatchTerm(guildOf(args).id, String(args.actorId), args.term);
      if (!r.added) fail(r.reason === 'limit' ? 'limit_reached' : 'duplicate', r.reason === 'limit' ? 'The watch list is full.' : `"${r.term}" is already watched.`);
      return r;
    },
    'watch.removeTerm': (args) => ({ removed: Boolean(removeWatchTerm(guildOf(args).id, args.term)) }),
    'watch.setChannel': (args) => {
      const guild = guildOf(args);
      if (args.channelId !== null && !guild.channels.cache.get(args.channelId)?.isTextBased()) fail('channel_not_found', 'Not a text channel in this server.');
      return { channelId: setWatchChannelId(guild.id, args.channelId) };
    },

    'automations.get': (args) => {
      const guild = guildOf(args);
      const birthday = getDb().prepare('SELECT birthday_role_id, timezone, birthday_channel_id FROM guild_settings WHERE guild_id = ?').get(guild.id) ?? null;
      return {
        summaries: { channelId: getSummaryChannel(guild.id), schedules: listSchedules(guild.id), aiConfigured: Boolean(config.ai.apiKey), glossaryTerms: listGlossary(guild.id).length },
        birthdays: { settings: birthday, registered: getDb().prepare('SELECT COUNT(*) AS n FROM birthdays WHERE guild_id = ?').get(guild.id).n },
        tickets: { counts: ticketCounts(guild.id), types: listTicketTypes(guild.id).map((t) => ({ key: t.key, label: t.label, kind: t.kind })) },
        exile: { active: countActiveExiles(guild.id), levels: listRoleMappings(guild.id) },
        mute: { roleId: getMuteRoleId(guild.id) },
        aliases: listAliases(guild.id).map((a) => ({ trigger: a.label ?? a.trigger, command: a.command })),
        commandGrants: listGrants(guild.id),
        // These systems are configured with their existing Discord commands; the website shows them read-only.
        editableHere: ['welcome', 'watch'],
      };
    },

    'embed.send': async (args) => {
      const guild = guildOf(args);
      const channel = guild.channels.cache.get(String(args.channelId));
      if (!channel?.isTextBased() || channel.isThread()) fail('channel_not_found', 'Not a text channel in this server.');
      const mine = channel.permissionsFor(guild.members.me);
      if (!mine?.has(PermissionFlagsBits.SendMessages) || !mine.has(PermissionFlagsBits.EmbedLinks)) fail('bot_missing_permission', 'I need Send Messages and Embed Links in that channel.');
      const embed = new EmbedBuilder().setColor(args.color ?? 0x7c5cff);
      if (args.title) embed.setTitle(args.title);
      if (args.description) embed.setDescription(args.description);
      if (args.imageUrl) embed.setImage(args.imageUrl);
      if (args.footer) embed.setFooter({ text: args.footer });
      const message = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
      return { messageId: message.id, channel: channel.name };
    },

    // A reference copy of the bot's settings. Tokens and API keys are never included.
    'config.export': (args) => {
      const guild = guildOf(args);
      return {
        env: { prefix: config.prefix, timezone: config.timezone, logLevel: config.logLevel, guildScoped: Boolean(config.guildId), aiModel: config.ai.model, aiConfigured: Boolean(config.ai.apiKey) },
        welcome: getWelcomeSettings(guild.id),
        watch: { channelId: getWatchChannelId(guild.id), terms: listWatchTerms(guild.id).map((t) => t.term) },
        exileLevels: listRoleMappings(guild.id),
        ticketTypes: listTicketTypes(guild.id),
        aliases: listAliases(guild.id),
        commandGrants: listGrants(guild.id),
        summarySchedules: listSchedules(guild.id),
        glossary: listGlossary(guild.id),
      };
    },
  };

  const agent = startAgent({
    botId: 'tower',
    root: rootDir,
    databases: () => [{ name: 'bot', path: path.join(config.dataDir, 'bot.db') }],
    commands,
    info: () => ({ bot: '11/10', library: 'discord.js v14', prefix: config.prefix, intents: ['Guilds', 'GuildMessages', 'GuildMembers', 'GuildVoiceStates', 'GuildPresences', 'MessageContent'] }),
    heartbeat: () => {
      const ready = client.isReady() && client.ws.status === 0;
      const guild = client.guilds.cache.get(config.guildId ?? '') ?? client.guilds.cache.first() ?? null;
      return {
        discordReady: ready,
        pingMs: ready && client.ws.ping >= 0 ? client.ws.ping : null,
        guilds: client.guilds.cache.size,
        botTag: client.user?.tag ?? null,
        guild: guild ? { id: guild.id, memberCount: guild.memberCount, onlineCount: guild.presences.cache.filter((p) => p.status !== 'offline').size, voiceCount: guild.voiceStates.cache.filter((v) => v.channelId).size } : null,
      };
    },
    // A clean close checkpoints the WAL so the restarted process (or a pending restore) starts from a complete file.
    beforeExit: () => { try { closeDb(); } catch { /* already closed */ } },
  });
  if (!agent) {
    if (process.env.TCC_URL || process.env.TCC_AGENT_SECRET) {
      createLogger('tcc').warn(
        'Tower Control Center is configured but the agent did not start. Check that TCC_URL is wss:// and TCC_AGENT_SECRET is set.',
      );
    }
    return null;
  }

  createLogger('tcc').info('Tower Control Center agent started (outbound WebSocket only).');

  // Extra listeners only. Counters carry a channel and an hour: no author, no content.
  client.on('guildMemberAdd', (m) => agent.emit('member.join', { guildId: m.guild.id, userId: m.id }));
  client.on('guildMemberRemove', (m) => agent.emit('member.leave', { guildId: m.guild.id, userId: m.id }));
  client.on('messageCreate', (message) => {
    if (!message.inGuild() || message.author.bot || message.system) return;
    if (config.guildId && message.guildId !== config.guildId) return;
    const channelId = message.channel?.isThread?.() ? message.channel.parentId ?? message.channelId : message.channelId;
    const key = `${Math.floor(message.createdTimestamp / 3600_000) * 3600}:${channelId}`;
    hourly.set(key, (hourly.get(key) ?? 0) + 1);
    if (message.content.startsWith(config.prefix)) {
      const name = message.content.slice(config.prefix.length).trim().split(/\s+/)[0]?.toLowerCase();
      if (name && (client.commands.has(name) || client.aliases.has(name))) agent.countCommand();
    }
  });
  client.on('interactionCreate', (i) => { if (i.isChatInputCommand()) agent.countCommand(); });

  setInterval(() => {
    if (hourly.size > 0) {
      const buckets = [...hourly].map(([key, count]) => { const [hour, channelId] = key.split(':'); return { hour: Number(hour), channelId, count }; });
      hourly.clear();
      agent.emit('messages.hourly', { guildId: config.guildId ?? null, buckets });
    }
    const ready = client.isReady() && client.ws.status === 0;
    readySince = ready ? readySince || Date.now() : 0;
    if (readySince && Date.now() - readySince > 60_000) agent.confirmHealthy();
  }, 60_000).unref();

  return agent;
}
