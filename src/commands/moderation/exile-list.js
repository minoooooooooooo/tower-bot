import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, embed } from '../../lib/embeds.js';
import { infoReply } from '../../lib/replies.js';
import {
  countActiveExiles,
  getExileLogChannelId,
  levelLabel,
  listActiveExiles,
} from '../../services/exile-store.js';
import { ephemeral, fail } from './_shared.js';

const MAX_SHOWN = 30;

async function requireManageServer(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await fail(ctx, 'صلاحيات ناقصة', 'تحتاج **إدارة السيرفر** عشان تشوف العزل الشغّال.');

  return false;
}

function listPayload(ctx) {
  const exiles = listActiveExiles(ctx.guildId);

  if (exiles.length === 0) {
    return infoReply(
      'ما فيه عزل شغّال',
      'ما فيه أحد معزول الحين. ابدأ واحد بـ `/exile user:@member`.',
    );
  }

  const shown = exiles.slice(0, MAX_SHOWN);
  const lines = shown.map((entry) => {
    const reason = entry.reason?.trim() ? ` — ${entry.reason.trim().slice(0, 80)}` : '';

    return `\u200E• <@${entry.userId}> — **${levelLabel(entry.level)}** — <t:${Math.floor(entry.createdAt / 1000)}:R> بواسطة <@${entry.createdBy}>${reason}`;
  });

  if (exiles.length > shown.length) {
    lines.push(`…و ${exiles.length - shown.length} غيرهم`);
  }

  const logChannelId = getExileLogChannelId(ctx.guildId);

  return {
    embeds: [
      embed({
        title: `العزل الشغّال (${countActiveExiles(ctx.guildId)})`,
        description: lines.join('\n').slice(0, 4000),
        color: COLORS.warning,
        footer: logChannelId
          ? `سجل العزل: <#${logChannelId}>`
          : 'ما فيه قناة سجل — شغّل /exile-log channel:#mod-log.',
      }),
    ],
  };
}

export default {
  data: new SlashCommandBuilder()
    .setName('exile-list')
    .setDescription('اعرض كل عضو معزول حاليًا')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  name: 'exile-list',
  aliases: ['exiles'],
  description: 'اعرض كل عضو معزول حاليًا',
  category: 'Moderation',
  usage: 'exile-list',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ManageGuild'],

  async execute(ctx) {
    if (!(await requireManageServer(ctx))) return;

    await ctx.reply(ephemeral(listPayload(ctx)));
  },
};
