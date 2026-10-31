import { SlashCommandBuilder } from 'discord.js';
import { embed } from '../../lib/embeds.js';

export default {
  data: new SlashCommandBuilder().setName('ping').setDescription('Check the bot latency'),

  name: 'ping',
  aliases: ['pong'],
  description: 'Check the bot latency',
  category: 'General',
  usage: 'ping',
  cooldown: 3,

  async execute(ctx, client) {
    const start = Date.now();

    await ctx.reply({ embeds: [embed({ title: 'Pinging...', description: 'Measuring latency.' })] });

    const roundtrip = Date.now() - start;

    await ctx.editReply({
      embeds: [
        embed({
          title: 'Pong!',
          fields: [
            { name: 'WebSocket', value: `${Math.max(client.ws.ping, 0)}ms`, inline: true },
            { name: 'Roundtrip', value: `${roundtrip}ms`, inline: true },
          ],
        }),
      ],
    });
  },
};
