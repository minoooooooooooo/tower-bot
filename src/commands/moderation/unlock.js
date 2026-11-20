import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { unlockChannel } from '../../services/channel-locks.js';
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
    .setName('unlock')
    .setDescription('اسمح للأعضاء بالكلام في قناة من جديد')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('القناة المطلوبة — الافتراضي القناة الحالية')
        .setRequired(false),
    ),

  name: 'unlock',
  description: 'اسمح للأعضاء بالكلام في قناة من جديد (الافتراضي الحالية)',
  category: 'Moderation',
  usage: 'unlock [#channel]',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ManageChannels'],

  async execute(ctx) {
    const { channel, problem } = await targetChannel(ctx);

    if (problem) {
      await unknownChannel(ctx, problem);
      return;
    }

    const result = await unlockChannel({
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
        await fail(ctx, 'تعذر فتح القناة', discordProblem(result));
      }

      return;
    }

    if (result.already) {
      await info(ctx, 'مفتوحة', `${channel} مفتوحة من قبل — ما فيه شيء أرجّعه.`);
      return;
    }

    const lines = [`${channel} رجعت مفتوحة.`];

    lines.push(
      result.restored
        ? 'الصلاحيات اللي كانت قبل القفل رجعت زي ما كانت.'
        : 'ما عندي سجل لهذي القناة، فشلت صلاحيات القفل بدل ما أرجّع إعداد قديم. تأكد من القناة إذا كانت لها صلاحيات مخصصة.',
    );

    await done(ctx, 'تم فتح القناة', lines.join('\n'));
  },
};
