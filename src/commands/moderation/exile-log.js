import {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { resolveChannel } from '../../lib/resolve.js';
import { getExileLogChannelId, setExileLogChannelId } from '../../services/exile-store.js';
import { done, fail } from './_shared.js';

const OFF_WORDS = ['off', 'none', 'clear', 'disable'];

async function requireManageServer(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await fail(ctx, 'صلاحيات ناقصة', 'تحتاج **إدارة السيرفر** عشان تختار سجل العزل.');

  return false;
}

async function requireSendable(ctx, channel) {
  if (!channel?.isTextBased?.() || channel.isDMBased?.()) {
    await fail(
      ctx,
      'مو قناة نصية',
      'اختر قناة عادية في السيرفر، مثل `/exile-log channel:#mod-log`.',
    );
    return false;
  }

  const me = ctx.guild.members?.me;
  const permissions = me ? channel.permissionsFor?.(me) : null;

  if (
    permissions &&
    !permissions.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ])
  ) {
    await fail(
      ctx,
      'ما أقدر أرسل هناك',
      `أحتاج **عرض القنوات** و**إرسال الرسائل** و**إرفاق الروابط** في ${channel}.`,
    );
    return false;
  }

  return true;
}

async function turnOff(ctx) {
  setExileLogChannelId(ctx.guildId, null);

  await done(
    ctx,
    'سجل العزل مقفّل',
    'العزل وفك العزل ما عاد تنكتب في أي قناة.',
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('exile-log')
    .setDescription('اختر القناة اللي تنكتب فيها سجلات العزل وفك العزل')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('قناة السجل (اتركها فاضية تقفل التسجيل)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ),

  name: 'exile-log',
  description: 'اختر القناة اللي تنكتب فيها سجلات العزل وفك العزل',
  category: 'Moderation',
  usage: 'exile-log <#channel|off>',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ManageGuild'],

  async execute(ctx) {
    if (!(await requireManageServer(ctx))) return;

    if (ctx.isSlash) {
      const channel = ctx.getChannel('channel');

      if (!channel) return turnOff(ctx);
      if (!(await requireSendable(ctx, channel))) return;

      setExileLogChannelId(ctx.guildId, channel.id);

      await done(
        ctx,
        'تم حفظ سجل العزل',
        `العزل وتغيير المستوى وفك العزل تنكتب في ${channel}.`,
      );
      return;
    }

    const raw = (ctx.args[0] ?? '').trim();

    if (!raw || OFF_WORDS.includes(raw.toLowerCase())) return turnOff(ctx);

    const channel = await resolveChannel(ctx.guild, raw).catch(() => null);

    if (!channel) {
      await fail(
        ctx,
        'قناة غير معروفة',
        `ما لقيت \`${raw}\`. منشنها كـ \`#channel\` أو الصق آيديها. السجل الحالي: ${
          getExileLogChannelId(ctx.guildId) ? `<#${getExileLogChannelId(ctx.guildId)}>` : 'مقفّل'
        }.`,
      );
      return;
    }

    if (!(await requireSendable(ctx, channel))) return;

    setExileLogChannelId(ctx.guildId, channel.id);

    await done(
      ctx,
      'تم حفظ سجل العزل',
      `العزل وتغيير المستوى وفك العزل تنكتب في ${channel}.`,
    );
  },
};
