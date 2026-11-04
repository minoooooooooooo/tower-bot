import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { colorListEmbed } from '../../lib/color-palette.js';

export default {
  data: new SlashCommandBuilder()
    .setName('colors')
    .setDescription('List every color name the bot understands, in Arabic and English')
    .setContexts(InteractionContextType.Guild),

  name: 'colors',
  aliases: ['colours', 'palette'],
  description: 'List every color name the bot understands, in Arabic and English',
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
