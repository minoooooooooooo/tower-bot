import {
  AttachmentBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { errorEmbed } from '../../lib/embeds.js';
import { createLogger } from '../../lib/logger.js';
import { displayNameOf, targetUser } from '../../lib/targets.js';
import { config } from '../../config.js';
import { memberStats } from '../../services/activity-store.js';
import { getBirthday, getGuildSettings } from '../../services/birthday-store.js';
import { linkedPoints } from '../../services/ebot-vex.js';
import {
  customWallpaperPath,
  hasCustomWallpaper,
  resolveBackground,
} from '../../services/profile-backgrounds.js';
import { renderProfileCard } from '../../services/profile-card.js';
import {
  ensureExileBackfill,
  profileStats,
} from '../../services/profile-store.js';

const logger = createLogger('profile');

const ACTIVITY_LABELS = {
  0: 'Playing',
  1: 'Streaming',
  2: 'Listening to',
  3: 'Watching',
  5: 'Competing in',
};

function timestampOf(value) {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/** The live status line: presence dot text, custom status and current activity. */
function presenceFor(member) {
  const presence = member?.presence;

  if (!presence) {
    return { status: 'offline', customStatus: null, activity: null, streaming: false };
  }

  const activities = Array.isArray(presence.activities) ? presence.activities : [];
  const custom = activities.find((activity) => activity.type === 4);
  const current = activities.find((activity) => activity.type !== 4);
  const verb = ACTIVITY_LABELS[current?.type] ?? 'Playing';

  return {
    status: presence.status ?? 'offline',
    customStatus: custom?.state?.trim() || null,
    activity: current ? `${verb} ${current.name}`.trim() : null,
    streaming: current?.type === 1,
  };
}

/** Highest roles first, without @everyone. */
function topRoles(member, guild) {
  if (!member?.roles?.cache) return [];

  return [...member.roles.cache.values()]
    .filter((role) => role.id !== guild.id)
    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
    .slice(0, 8)
    .map((role) => ({
      name: role.name,
      color: role.color ? role.hexColor : null,
    }));
}

/** Hidden entirely unless the member left the birthday block visible. */
function birthdayFor(guildId, userId, stats) {
  if (!stats.showBirthday) return null;

  const birthday = getBirthday(guildId, userId);
  if (!birthday) return null;

  const settings = getGuildSettings(guildId);

  return {
    month: birthday.month,
    day: birthday.day,
    year: birthday.year ?? null,
    timezone: birthday.timezone ?? settings.timezone ?? config.timezone,
  };
}

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

/** Every current member, because rank counts members without a profile row as 0. */
async function memberIds(guild) {
  const cache = guild.members.cache;

  if (cache.size >= guild.memberCount) return [...cache.keys()];

  try {
    const members = await guild.members.fetch();
    return [...members.keys()];
  } catch {
    return [...cache.keys()];
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Show a member’s profile card')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('Member to show (defaults to you)')
        .setRequired(false),
    ),

  name: 'profile',
  aliases: ['card', 'profilecard'],
  description: 'Show a member’s profile card',
  category: 'General',
  usage: 'profile [@member]',
  cooldown: 5,
  guildOnly: true,

  async execute(ctx, client) {
    // The card needs a member fetch, an avatar download and a render, which can
    // take longer than Discord's three-second acknowledgement window.
    if (ctx.isSlash) await ctx.defer();

    const user = await targetUser(ctx, client);

    if (!user) {
      await ctx.fail(
        ephemeral({
          embeds: [
            errorEmbed(
              'Unknown user',
              `Mention the member or paste their id, for example \`${ctx.isSlash ? '/profile user:@member' : ':-profile @member'}\`.`,
            ),
          ],
        }),
      );
      return;
    }

    const member =
      ctx.guild.members.cache.get(user.id) ??
      (await ctx.guild.members.fetch(user.id).catch(() => null));

    // The card is generated from the member when they are still here, and from
    // the user alone when they left (stored points still render, rank is empty).
    const cardMember = {
      name: displayNameOf(user, member),
      username: user.username ?? 'unknown',
      avatarUrl:
        member?.displayAvatarURL?.({ extension: 'png', size: 512 }) ??
        user.displayAvatarURL({ extension: 'png', size: 512 }),
    };

    try {
      ensureExileBackfill(ctx.guildId);
    } catch {
      // A failed import must not stop the card from rendering.
    }

    // Points from the linked bots: Vex from E Bot 1, nightmare points from
    // Al-Kabus. Both are optional and resolve to null when not configured.
    const [ids, linked] = await Promise.all([
      memberIds(ctx.guild),
      linkedPoints(client, ctx.guildId),
    ]);
    const stats = profileStats(ctx.guildId, user.id, ids, linked);
    const activity = memberStats(ctx.guildId, user.id);
    const status = {
      presence: presenceFor(member),
      messages: activity.messages,
      voiceSeconds: activity.voiceSeconds,
      lastActiveAt: activity.lastActiveAt,
      lastMessageAt: activity.lastMessageAt,
      joinedAt: timestampOf(member?.joinedAt),
      createdAt: timestampOf(user.createdAt),
      roles: topRoles(member, ctx.guild),
      birthday: birthdayFor(ctx.guildId, user.id, stats),
      birthdayHidden: !stats.showBirthday,
    };

    let file;

    try {
      const hasCustom = hasCustomWallpaper(ctx.guildId, user.id);
      const background = resolveBackground({
        selected: stats.background,
        level: stats.level,
        hasCustom,
        customPath: hasCustom ? customWallpaperPath(ctx.guildId, user.id) : null,
      });
      const buffer = await renderProfileCard({
        member: cardMember,
        stats,
        status,
        background,
      });
      file = new AttachmentBuilder(buffer, { name: `profile-${user.id}.png` });
    } catch (error) {
      logger.error(`Could not render the card for ${user.id}`, error);
      await ctx.fail(
        ephemeral({
          embeds: [
            errorEmbed(
              'Could not render the card',
              'The profile image could not be generated. The bot owner should check that `assets/profile/` is present and `@napi-rs/canvas` is installed.',
            ),
          ],
        }),
      );
      return;
    }

    if (ctx.isSlash) {
      await ctx.editReply({ files: [file] });
      return;
    }

    await ctx.reply({ files: [file] });
  },
};
