import { SlashCommandBuilder, version as discordVersion } from 'discord.js';
import { buildInfo } from '../../lib/build-info.js';
import { embed } from '../../lib/embeds.js';

function formatUptime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [days && `${days} ي`, hours && `${hours} س`, minutes && `${minutes} د`, `${seconds} ث`]
    .filter(Boolean)
    .join(' ');
}

export default {
  data: new SlashCommandBuilder()
    .setName('botinfo')
    .setDescription('اعرض معلومات عن البوت'),

  name: 'botinfo',
  aliases: ['info', 'stats'],
  description: 'اعرض معلومات عن البوت',
  category: 'General',
  usage: 'botinfo',
  cooldown: 5,

  async execute(ctx, client) {
    const memory = process.memoryUsage();
    const heapUsed = (memory.heapUsed / 1024 / 1024).toFixed(1);
    const build = buildInfo();

    await ctx.reply({
      embeds: [
        embed({
          title: client.user.username,
          thumbnail: client.user.displayAvatarURL({ size: 256 }),
          fields: [
            { name: 'السيرفرات', value: `${client.guilds.cache.size}`, inline: true },
            { name: 'مدة التشغيل', value: formatUptime(client.uptime ?? 0), inline: true },
            { name: 'الاتصال', value: `${Math.max(client.ws.ping, 0)}ms`, inline: true },
            { name: 'الذاكرة', value: `${heapUsed} MB`, inline: true },
            { name: 'Node.js', value: process.version, inline: true },
            { name: 'discord.js', value: `v${discordVersion}`, inline: true },
            {
              name: 'النسخة',
              value: build.commit
                ? `\`${build.commit}\`${build.date ? ` · ${build.date}` : ''}`
                : 'غير معروفة',
              inline: true,
            },
          ],
        }),
      ],
    });
  },
};
