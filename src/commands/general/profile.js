import {
  AttachmentBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { errorEmbed } from '../../lib/embeds.js';
import { createLogger } from '../../lib/logger.js';
import { displayNameOf, targetUser } from '../../lib/targets.js';
import { renderProfileCard } from '../../services/profile-card.js';
import {
  ensureExileBackfill,
  profileStats,
} from '../../services/profile-store.js';

const logger = createLogger('profile');

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

    const ids = await memberIds(ctx.guild);
    const stats = profileStats(ctx.guildId, user.id, ids);

    let file;

    try {
      const buffer = await renderProfileCard({ member: cardMember, stats });
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
