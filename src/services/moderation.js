import {
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';
import { createLogger } from '../lib/logger.js';
import { permissionName } from '../lib/permissions.js';
import { getMuteRoleId, getMuteSettings, setMuteRoleId } from './moderation-store.js';

const logger = createLogger('moderation');

export const MUTE_ROLE_NAME = 'Muted';

// Channel overwrites are the only way to remove permissions: role permissions
// are additive, so a role cannot "deny" what @everyone grants. These denies are
// applied once per channel when the mute role is created, and to every new
// channel afterwards.
const MUTE_DENY = {
  SendMessages: false,
  SendMessagesInThreads: false,
  AddReactions: false,
  CreatePublicThreads: false,
  CreatePrivateThreads: false,
  Speak: false,
};

const MUTE_CHANNEL_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildStageVoice,
  ChannelType.GuildForum,
  ChannelType.GuildMedia,
  ChannelType.GuildCategory,
]);

const OVERWRITE_CONCURRENCY = 5;

function isMuteChannel(channel) {
  return Boolean(channel && MUTE_CHANNEL_TYPES.has(channel.type));
}

async function mapLimit(items, limit, run) {
  let index = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await run(item);
    }
  });

  await Promise.all(workers);
}

/** Message used whenever the bot itself is missing a permission. */
export function botPermissionProblem(guild, flag, label) {
  const me = guild?.members?.me;

  if (!me) return 'تعذر قراءة بيانات العضو في السيرفر. جرّب بعد لحظات.';

  const has =
    me.permissions?.has(flag) || me.permissions?.has(PermissionFlagsBits.Administrator);

  if (has) return null;

  return `أحتاج صلاحية **${permissionName(flag ?? label)}** عشان أسوي هذا.`;
}

/**
 * The invoker must outrank the target unless they own the server or have
 * Administrator; Discord enforces the same rule for role edits.
 */
export function actorProblem(guild, actor, target) {
  if (!actor) return 'تعذر قراءة بياناتك في السيرفر. جرّب بعد لحظات.';

  if (actor.id === guild.ownerId) return null;
  if (actor.permissions?.has(PermissionFlagsBits.Administrator)) return null;

  const actorTop = actor.roles?.highest?.position ?? 0;
  const targetTop = target.roles?.highest?.position ?? 0;

  if (actorTop <= targetTop) {
    return 'لازم أعلى رتبة عندك تكون فوق أعلى رتبة العضو.';
  }

  return null;
}

/**
 * Refuses targets the bot cannot act on. `allowBot` is for kick/ban only:
 * muting or timing out a bot cannot affect anything it does.
 */
export function targetProblem(guild, target, actorId, { allowBot = false } = {}) {
  if (!target) return 'اختر عضوًا.';

  if (target.id === actorId) return 'ما تقدر تستهدف نفسك.';

  if (target.id === guild.ownerId) {
    return 'ما يمكن معاقبة مالك السيرفر — المالك يتجاوز كل الصلاحيات.';
  }

  if (target.user?.bot && !allowBot) {
    return 'البوتات ما تنكتم ولا تنعطى تايم أوت. اطردها أو احظرها بدلًا من ذلك.';
  }

  const me = guild.members?.me;

  if (!me) return 'تعذر قراءة بيانات العضو في السيرفر. جرّب بعد لحظات.';

  if (target.id === me.id) return 'ما أقدر أستهدف نفسي.';

  const botTop = me.roles?.highest?.position ?? 0;
  const targetTop = target.roles?.highest?.position ?? 0;

  if (botTop <= targetTop) {
    return 'لازم أعلى رتبة عندي تكون فوق أعلى رتبة العضو. ارفع رتبتي من **إعدادات السيرفر ← الرتب**.';
  }

  return null;
}

/** Discord's timeout ceiling is 28 days. */
export const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

/**
 * The Muted role: reuse the stored one, then a role already named "Muted", and
 * only create one when neither exists. The channel overwrites are the expensive
 * part, so they are written once, when the role is first created.
 */
export async function ensureMuteRole(guild) {
  const settings = getMuteSettings(guild.id);
  let role = settings.roleId
    ? guild.roles.cache.get(settings.roleId) ??
      (await guild.roles.fetch(settings.roleId).catch(() => null))
    : null;

  if (!role) {
    role =
      guild.roles.cache.find(
        (candidate) =>
          !candidate.managed && candidate.name.toLowerCase() === MUTE_ROLE_NAME.toLowerCase(),
      ) ?? null;
  }

  if (role) {
    const sameRole = settings.roleId === role.id;

    // A freshly adopted role (or one stored before the overwrites were written)
    // still needs the channel denies once, otherwise the role does nothing.
    if (sameRole && settings.configured) {
      return { role, created: false, updated: 0, failed: [] };
    }

    const applied = await applyMuteOverwrites(guild, role);

    if (applied.failed.length === 0) {
      setMuteRoleId(guild.id, role.id, { configured: true });
    } else {
      setMuteRoleId(guild.id, role.id, { configured: false });
    }

    return { role, created: false, ...applied };
  }

  const permissionProblem = botPermissionProblem(
    guild,
    PermissionFlagsBits.ManageRoles,
    'Manage Roles',
  );

  if (permissionProblem) return { problem: permissionProblem };

  let created;

  try {
    created = await guild.roles.create({
      name: MUTE_ROLE_NAME,
      permissions: [],
      mentionable: false,
      hoist: false,
      reason: 'Mute command: creating the muted role',
    });
  } catch (error) {
    return { problem: `Discord refused to create the **Muted** role: ${error.message}` };
  }

  setMuteRoleId(guild.id, created.id, { configured: false });

  const applied = await applyMuteOverwrites(guild, created);

  if (applied.failed.length === 0) {
    setMuteRoleId(guild.id, created.id, { configured: true });
  }

  return { role: created, created: true, ...applied };
}

/**
 * Denies talking in every existing channel. Categories are included so a new
 * channel that inherits its parent stays muted until channelCreate fixes it.
 */
export async function applyMuteOverwrites(guild, role) {
  let channels;

  try {
    channels = [...(await guild.channels.fetch()).values()].filter(isMuteChannel);
  } catch (error) {
    return { updated: 0, failed: [{ channelId: null, message: error.message }] };
  }

  let updated = 0;
  const failed = [];

  await mapLimit(channels, OVERWRITE_CONCURRENCY, async (channel) => {
    try {
      await channel.permissionOverwrites.edit(
        role,
        MUTE_DENY,
        { reason: 'Mute command: setting up the muted role' },
      );
      updated += 1;
    } catch (error) {
      failed.push({ channelId: channel.id, message: error.message });
    }
  });

  if (failed.length > 0) {
    logger.warn(
      `[${guild.name ?? guild.id}] ${failed.length} channel(s) could not get the mute overwrite`,
    );
  }

  return { updated, failed };
}

/** New channels must not become a loophole. Called from the channelCreate event. */
export async function applyMuteRules(channel) {
  const guild = channel?.guild;
  if (!guild || !isMuteChannel(channel)) return { updated: false };

  const roleId = getMuteRoleId(guild.id);
  if (!roleId) return { updated: false };

  const role =
    guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null));

  if (!role) return { updated: false };

  try {
    await channel.permissionOverwrites.edit(
      role,
      MUTE_DENY,
      { reason: 'Mute command: new channel' },
    );
    return { updated: true };
  } catch (error) {
    logger.warn(`Could not mute #${channel.name ?? channel.id}: ${error.message}`);
    return { updated: false };
  }
}

/** True when the member is actually blocked from talking by the mute role. */
export function isMuted(member, roleId) {
  if (!roleId) return false;
  if (member.roles?.cache?.has(roleId)) return true;

  // A role id can be stale after a manual delete; a role named "Muted" is the
  // next best signal.
  return Boolean(
    member.roles?.cache?.find(
      (role) => !role.managed && role.name.toLowerCase() === MUTE_ROLE_NAME.toLowerCase(),
    ),
  );
}

export function muteRoleProblem(guild, role) {
  if (!role) return 'ما لقيت رتبة **Muted** أو ما قدرت أنشئها.';

  if (role.managed) {
    return `**${role.name}** مرتبطة بتكامل ولا تنعطى يدويًا.`;
  }

  const me = guild.members?.me;
  const botTop = me?.roles?.highest?.position ?? 0;

  if (role.position >= botTop) {
    return `لازم أعلى رتبة عندي تكون **فوق ${role.name}**. ارفع رتبتي من **إعدادات السيرفر ← الرتب**.`;
  }

  return null;
}

export function permissionLabel(flag) {
  return permissionName(flag);
}

export { MUTE_DENY, isMuteChannel };
