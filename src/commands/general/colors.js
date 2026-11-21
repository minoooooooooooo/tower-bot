import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { colorListEmbed } from '../../lib/color-palette.js';

export default {
  data: new SlashCommandBuilder()
    .setName('colors')
    .setDescription('اعرض كل أسماء الألوان اللي يفهمها البوت، بالعربية والإنجليزية')
    .setContexts(InteractionContextType.Guild),

  name: 'colors',
  aliases: ['colours', 'palette'],
  description: 'اعرض كل أسماء الألوان اللي يفهمها البوت، بالعربية والإنجليزية',
  category: 'General',
  usage: 'colors',
  cooldown: 3,
  guildOnly: true,

  async execute(ctx) {
    // Read-only: viewing the palette should not make the user wait before a
    // real color change.
    ctx.releaseCooldown();

    await ctx.reply({
      embeds: [colorListEmbed()],
      flags: MessageFlags.Ephemeral,
    });
  },
};
