import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, embed } from '../../lib/embeds.js';
import { PAGER_PAGE_SIZE, attachPager, pagerMessage, withPager } from '../../lib/pager.js';
import { infoReply } from '../../lib/replies.js';
import {
  countActiveExiles,
  getExileLogChannelId,
  levelLabel,
  listActiveExiles,
} from '../../services/exile-store.js';
import { ephemeral, fail } from './_shared.js';

async function requireManageServer(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await fail(ctx, 'صلاحيات ناقصة', 'تحتاج **إدارة السيرفر** عشان تشوف العزل الشغّال.');

  return false;
}

function exilePage(ctx, exiles, page, pages) {
  const start = (page - 1) * PAGER_PAGE_SIZE;
  const lines = exiles.slice(start, start + PAGER_PAGE_SIZE).map((entry) => {
    const reason = entry.reason?.trim() ? ` — ${entry.reason.trim().slice(0, 80)}` : '';

    return `\u200E• <@${entry.userId}> — **${levelLabel(entry.level)}** — <t:${Math.floor(entry.createdAt / 1000)}:R> بواسطة <@${entry.createdBy}>${reason}`;
  });

  const logChannelId = getExileLogChannelId(ctx.guildId);

  const card = embed({
    title: `العزل الشغّال (${countActiveExiles(ctx.guildId)})`,
    description: lines.join('\n'),
    color: COLORS.warning,
    footer: [
      pages > 1 ? `صفحة ${page} / ${pages}` : null,
      logChannelId
        ? `سجل العزل: <#${logChannelId}>`
        : 'ما فيه قناة سجل — شغّل /exile-log channel:#mod-log.',
    ]
      .filter(Boolean)
      .join(' · '),
  });

  return { embed: card, pages, page };
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

    const exiles = listActiveExiles(ctx.guildId);

    if (exiles.length === 0) {
      await ctx.reply(
        ephemeral(
          infoReply('ما فيه عزل شغّال', 'ما فيه أحد معزول الحين. ابدأ واحد بـ `/exile user:@member`.'),
        ),
      );
      return;
    }

    const pages = Math.max(1, Math.ceil(exiles.length / PAGER_PAGE_SIZE));
    const render = (page) => ({ embeds: [exilePage(ctx, exiles, page, pages).embed] });

    const sent = await ctx.reply(
      ephemeral(withPager({ id: 'exile-list', page: 1, pages, payload: render(1) })),
    );

    await attachPager({
      ctx,
      message: await pagerMessage(ctx, sent),
      id: 'exile-list',
      pages,
      render,
    });
  },
};
