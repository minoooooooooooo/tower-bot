import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { lockChannel } from '../../services/channel-locks.js';
import { done, fail, info } from './_shared.js';
import {
  botPermissionProblem,
  discordProblem,
  targetChannel,
  threadProblem,
  unknownChannel,
  unsupportedProblem,
} from './_locks.js';

export default {
  data: new SlashCommandBuilder()
    .setName('lock')
    .setDescription('أوقف كلام الأعضاء في قناة')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('القناة المطلوبة — الافتراضي القناة الحالية')
        .setRequired(false),
    ),

  name: 'lock',
  description: 'أوقف كلام الأعضاء في قناة (الافتراضي الحالية)',
  category: 'Moderation',
  usage: 'lock [#channel]',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ManageChannels'],

  async execute(ctx) {
    const { channel, problem } = await targetChannel(ctx);

    if (problem) {
      await unknownChannel(ctx, problem);
      return;
    }

    const result = await lockChannel({
      guild: ctx.guild,
      channel,
      actor: { id: ctx.user.id, name: ctx.member?.displayName ?? ctx.user.username },
    });

    if (!result.ok) {
      if (result.reason === 'thread') {
        await fail(ctx, 'قناة موضوع', threadProblem(channel));
      } else if (result.reason === 'unsupported') {
        await fail(ctx, 'قناة غير مدعومة', unsupportedProblem(channel));
      } else if (result.reason === 'bot-permissions') {
        await fail(ctx, 'صلاحيات ناقصة', botPermissionProblem(channel));
      } else {
        await fail(ctx, 'تعذر قفل القناة', discordProblem(result));
      }

      return;
    }

    const unlockHint = ctx.isSlash ? `/unlock channel:${channel.id}` : `:-unlock ${channel}`;

    if (result.already) {
      await info(
        ctx,
        'مقفلة أصلًا',
        result.external
          ? `${channel} مقفلة أصلًا، لكن مو مني. ${unlockHint} يفتحها.`
          : result.reactionsRestored
            ? `${channel} مقفلة أصلًا. رجّعت التفاعلات عشان الأعضاء يقدرون يتفاعلون مع الرسائل.`
            : `${channel} مقفلة أصلًا. ${unlockHint} يرجّعها.`,
      );
      return;
    }

    await done(
      ctx,
      'تم قفل القناة',
      [
        `${channel} انقفلت. الأعضاء ما يقدرون يرسلون أو ينشئون مواضيع، لكن التفاعلات تبقى شغالة.`,
        `تفتحها بـ ${unlockHint}.`,
      ].join('\n'),
    );
  },
};
