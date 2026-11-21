import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { embed } from '../../lib/embeds.js';
import { ephemeral, errorReply, infoReply } from '../../lib/replies.js';
import { displayNameOf, targetUser } from '../../lib/targets.js';

export default {
  data: new SlashCommandBuilder()
    .setName('banner')
    .setDescription('اعرض بانر ملف عضو')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('العضو المطلوب (الافتراضي: أنت)').setRequired(false),
    ),

  name: 'banner',
  aliases: ['userbanner'],
  description: 'اعرض بانر ملف عضو',
  category: 'General',
  usage: 'banner [@member]',
  cooldown: 3,
  guildOnly: true,

  async execute(ctx, client) {
    const user = await targetUser(ctx, client);

    if (!user) {
      await ctx.fail(
        ephemeral(
          errorReply(
            'عضو غير معروف',
            `منشن العضو أو الصق الآيدي، مثل \`${ctx.isSlash ? '/banner user:@member' : ':-banner @member'}\`.`,
          ),
        ),
      );
      return;
    }

    const member =
      ctx.guild.members.cache.get(user.id) ??
      (await ctx.guild.members.fetch(user.id).catch(() => null));
    const banner = user.bannerURL?.({ size: 4096 }) ?? null;

    if (!banner) {
      await ctx.reply(infoReply('ما فيه بانر', `${member ?? user} ما حط بانر لملفه.`));
      return;
    }

    await ctx.reply({
      embeds: [
        embed({
          title: `بانر ${displayNameOf(user, member)}`,
          image: banner,
          description: `[افتحه بالحجم الكامل](${banner})`,
          footer: `آيدي العضو: ${user.id}`,
        }),
      ],
    });
  },
};
