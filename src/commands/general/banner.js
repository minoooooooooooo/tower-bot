import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { embed, errorEmbed, infoEmbed } from '../../lib/embeds.js';
import { displayNameOf, targetUser } from '../../lib/targets.js';

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

export default {
  data: new SlashCommandBuilder()
    .setName('banner')
    .setDescription('Show a member’s profile banner')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('Member to look up (defaults to you)').setRequired(false),
    ),

  name: 'banner',
  aliases: ['userbanner'],
  description: 'Show a member’s profile banner',
  category: 'General',
  usage: 'banner [@member]',
  cooldown: 3,
  guildOnly: true,

  async execute(ctx, client) {
    const user = await targetUser(ctx, client);

    if (!user) {
      await ctx.reply(
        ephemeral({
          embeds: [
            errorEmbed(
              'Unknown user',
              `Mention the member or paste their id, for example \`${ctx.isSlash ? '/banner user:@member' : ':-banner @member'}\`.`,
            ),
          ],
        }),
      );
      return;
    }

    const member =
      ctx.guild.members.cache.get(user.id) ??
      (await ctx.guild.members.fetch(user.id).catch(() => null));
    const banner = user.bannerURL?.({ size: 4096 }) ?? null;

    if (!banner) {
      await ctx.reply({
        embeds: [
          infoEmbed(
            'No banner',
            `${member ?? user} has not set a profile banner.`,
          ),
        ],
      });
      return;
    }

    await ctx.reply({
      embeds: [
        embed({
          title: `${displayNameOf(user, member)}’s banner`,
          image: banner,
          description: `[Open in full size](${banner})`,
          footer: `User ID: ${user.id}`,
        }),
      ],
    });
  },
};
