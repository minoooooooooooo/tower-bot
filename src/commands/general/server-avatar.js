import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { embed, errorEmbed, infoEmbed } from '../../lib/embeds.js';
import { targetGuild } from '../../lib/targets.js';

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

export default {
  data: new SlashCommandBuilder()
    .setName('server-avatar')
    .setDescription('Show a server’s icon, including servers you are not in this one with')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('server')
        .setDescription('Server id or name (defaults to this server)')
        .setRequired(false)
        .setMaxLength(100),
    ),

  name: 'server-avatar',
  aliases: ['serverav', 'servericon', 'sicon'],
  description: 'Show a server’s icon (another server the bot is in can be picked)',
  category: 'General',
  usage: 'server-avatar [server id or name]',
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

    const icon = guild.iconURL({ size: 4096 }) ?? null;

    if (!icon) {
      await ctx.reply({
        embeds: [infoEmbed('No icon', `**${guild.name}** has not set a server icon.`)],
      });
      return;
    }

    await ctx.reply({
      embeds: [
        embed({
          title: `${guild.name}’s icon`,
          image: icon,
          description: `[Open in full size](${icon})`,
          footer: `Server ID: ${guild.id}`,
        }),
      ],
    });
  },
};
