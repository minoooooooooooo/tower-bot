import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { embed } from '../../lib/embeds.js';
import { ephemeral, errorReply, infoReply } from '../../lib/replies.js';
import { targetGuild } from '../../lib/targets.js';

export default {
  data: new SlashCommandBuilder()
    .setName('server-banner')
    .setDescription('اعرض بانر سيرفر')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('server')
        .setDescription('آيدي السيرفر أو اسمه (الافتراضي: هذا السيرفر)')
        .setRequired(false)
        .setMaxLength(100),
    ),

  name: 'server-banner',
  aliases: ['serverbanner', 'sbanner'],
  description: 'اعرض بانر سيرفر (تقدر تختار سيرفر ثاني البوت موجود فيه)',
  category: 'General',
  usage: 'server-banner [server id or name]',
  cooldown: 3,
  guildOnly: true,

  async execute(ctx, client) {
    const guild = await targetGuild(ctx, client);

    if (!guild) {
      await ctx.fail(
        ephemeral(
          errorReply(
            'السيرفر غير موجود',
            'ما أقدر أشوف إلا سيرفرات أنا موجود فيها. الصق آيدي السيرفر أو اسمه بالضبط.',
          ),
        ),
      );
      return;
    }

    const banner = guild.bannerURL({ size: 4096 }) ?? null;

    if (!banner) {
      await ctx.reply(infoReply('ما فيه بانر', `**${guild.name}** ما حط بانر للسيرفر.`));
      return;
    }

    await ctx.reply({
      embeds: [
        embed({
          title: `بانر ${guild.name}`,
          image: banner,
          description: `[افتحه بالحجم الكامل](${banner})`,
          footer: `آيدي السيرفر: ${guild.id}`,
        }),
      ],
    });
  },
};
