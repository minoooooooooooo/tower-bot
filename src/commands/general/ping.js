import { SlashCommandBuilder } from 'discord.js';
import { embed } from '../../lib/embeds.js';

export default {
  data: new SlashCommandBuilder().setName('ping').setDescription('اعرض سرعة استجابة البوت'),

  name: 'ping',
  aliases: ['pong'],
  description: 'اعرض سرعة استجابة البوت',
  category: 'General',
  usage: 'ping',
  cooldown: 3,

  async execute(ctx, client) {
    const start = Date.now();

    await ctx.reply({ embeds: [embed({ title: 'أقيس السرعة…', description: 'لحظة واحدة.' })] });

    const roundtrip = Date.now() - start;

    await ctx.editReply({
      embeds: [
        embed({
          title: 'جاهز!',
          fields: [
            { name: 'الاتصال', value: `${Math.max(client.ws.ping, 0)}ms`, inline: true },
            { name: 'الرحلة الكاملة', value: `${roundtrip}ms`, inline: true },
          ],
        }),
      ],
    });
  },
};
