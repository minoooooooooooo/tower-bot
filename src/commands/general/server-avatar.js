import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { embed } from '../../lib/embeds.js';
import { ephemeral, errorReply, infoReply } from '../../lib/replies.js';
import { targetGuild } from '../../lib/targets.js';

export default {
  data: new SlashCommandBuilder()
    .setName('server-avatar')
    .setDescription('اعرض أيقونة سيرفر، حتى سيرفر ثاني البوت موجود فيه')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('server')
        .setDescription('آيدي السيرفر أو اسمه (الافتراضي: هذا السيرفر)')
        .setRequired(false)
        .setMaxLength(100),
    ),

  name: 'server-avatar',
  aliases: ['serverav', 'servericon', 'sicon'],
  description: 'اعرض أيقونة سيرفر (تقدر تختار سيرفر ثاني البوت موجود فيه)',
  category: 'General',
  usage: 'server-avatar [server id or name]',
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

    const icon = guild.iconURL({ size: 4096 }) ?? null;

    if (!icon) {
      await ctx.reply(infoReply('ما فيه أيقونة', `**${guild.name}** ما حط أيقونة للسيرفر.`));
      return;
    }

    await ctx.reply({
      embeds: [
        embed({
          title: `أيقونة ${guild.name}`,
          image: icon,
          description: `[افتحها بالحجم الكامل](${icon})`,
          footer: `آيدي السيرفر: ${guild.id}`,
        }),
      ],
    });
  },
};
