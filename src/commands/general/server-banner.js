import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { embed, errorEmbed, infoEmbed } from '../../lib/embeds.js';
import { targetGuild } from '../../lib/targets.js';

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

export default {
  data: new SlashCommandBuilder()
    .setName('server-banner')
    .setDescription('Show a server’s banner')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('server')
        .setDescription('Server id or name (defaults to this server)')
        .setRequired(false)
        .setMaxLength(100),
    ),

  name: 'server-banner',
  aliases: ['serverbanner', 'sbanner'],
  description: 'Show a server’s banner (another server the bot is in can be picked)',
  category: 'General',
  usage: 'server-banner [server id or name]',
  cooldown: 3,
  guildOnly: true,

  async execute(ctx, client) {
    const guild = await targetGuild(ctx, client);

    if (!guild) {
      await ctx.reply(
        ephemeral({
          embeds: [
            errorEmbed(
              'Server not found',
              'I can only look at servers I am already in. Paste the server id or its exact name.',
            ),
          ],
        }),
      );
      return;
    }

    const banner = guild.bannerURL({ size: 4096 }) ?? null;

    if (!banner) {
      await ctx.reply({
        embeds: [infoEmbed('No banner', `**${guild.name}** has not set a server banner.`)],
      });
      return;
    }

    await ctx.reply({
      embeds: [
        embed({
          title: `${guild.name}’s banner`,
          image: banner,
          description: `[Open in full size](${banner})`,
          footer: `Server ID: ${guild.id}`,
        }),
      ],
    });
  },
};
