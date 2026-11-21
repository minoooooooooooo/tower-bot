import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { embed } from '../../lib/embeds.js';
import { ephemeral, errorReply } from '../../lib/replies.js';
import { displayNameOf, targetUser } from '../../lib/targets.js';

export default {
  data: new SlashCommandBuilder()
    .setName('avatar')
    .setDescription('اعرض صورة عضو، بما فيها صورته الخاصة بالسيرفر')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('user').setDescription('العضو المطلوب (الافتراضي: أنت)').setRequired(false),
    ),

  name: 'avatar',
  aliases: ['av', 'pfp'],
  description: 'اعرض صورة عضو، بما فيها صورته الخاصة بالسيرفر',
  category: 'General',
  usage: 'avatar [@member]',
  cooldown: 3,
  guildOnly: true,

  async execute(ctx, client) {
    const user = await targetUser(ctx, client);

    if (!user) {
      await ctx.fail(
        ephemeral(
          errorReply(
            'عضو غير معروف',
            `منشن العضو أو الصق الآيدي، مثل \`${ctx.isSlash ? '/avatar user:@member' : ':-avatar @member'}\`.`,
          ),
        ),
      );
      return;
    }

    const member =
      ctx.guild.members.cache.get(user.id) ??
      (await ctx.guild.members.fetch(user.id).catch(() => null));

    const globalAvatar = user.displayAvatarURL({ size: 4096 });
    const serverAvatar = member?.avatarURL?.({ size: 4096 }) ?? null;
    const links = [`[الصورة العامة](${globalAvatar})`];

    if (serverAvatar) links.push(`[صورة السيرفر](${serverAvatar})`);

    await ctx.reply({
      embeds: [
        embed({
          title: `صورة ${displayNameOf(user, member)}`,
          description: links.join(' · '),
          image: serverAvatar ?? globalAvatar,
          footer: `آيدي العضو: ${user.id}`,
        }),
      ],
    });
  },
};
