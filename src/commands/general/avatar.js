import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { embed, errorEmbed } from '../../lib/embeds.js';
import { displayNameOf, targetUser } from '../../lib/targets.js';

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

export default {
  data: new SlashCommandBuilder()
    .setName('avatar')
    .setDescription('Show a member’s avatar, including their per-server picture')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('Member to look up (defaults to you)').setRequired(false),
    ),

  name: 'avatar',
  aliases: ['av', 'pfp'],
  description: 'Show a member’s avatar, including their per-server picture',
  category: 'General',
  usage: 'avatar [@member]',
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
              `Mention the member or paste their id, for example \`${ctx.isSlash ? '/avatar user:@member' : ':-avatar @member'}\`.`,
            ),
          ],
        }),
      );
      return;
    }

    const member =
      ctx.guild.members.cache.get(user.id) ??
      (await ctx.guild.members.fetch(user.id).catch(() => null));

    const globalAvatar = user.displayAvatarURL({ size: 4096 });
    const serverAvatar = member?.avatarURL?.({ size: 4096 }) ?? null;
    const links = [`[Global avatar](${globalAvatar})`];

    if (serverAvatar) links.push(`[Server avatar](${serverAvatar})`);

    await ctx.reply({
      embeds: [
        embed({
          title: `${displayNameOf(user, member)}’s avatar`,
          description: links.join(' · '),
          image: serverAvatar ?? globalAvatar,
          footer: `User ID: ${user.id}`,
        }),
      ],
    });
  },
};
