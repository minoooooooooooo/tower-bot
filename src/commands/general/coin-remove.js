import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { config } from '../../config.js';
import { formatNumber } from '../../lib/activity-format.js';
import { COLORS, embed } from '../../lib/embeds.js';
import { createLogger } from '../../lib/logger.js';
import { errorReply, infoReply, okReply, warnReply } from '../../lib/replies.js';
import {
  COIN_TYPE_LABELS,
  coinTransaction,
  recentAdminTransactions,
  removeAdminTransaction,
} from '../../services/coin-ledger.js';

const logger = createLogger('coin-remove');

const SHOWN = 15;
const CONFIRM_WORDS = new Set([
  'confirm',
  'yes',
  'y',
  'true',
  'حذف',
  'احذف',
  'اكد',
  'أكد',
  'تاكيد',
  'تأكيد',
]);
const REMOVABLE = new Set(['admin_add', 'admin_remove', 'adjust']);

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

/** Keeps the sign: `formatNumber` clamps at zero. */
function signed(value) {
  const number = Math.trunc(Number(value) || 0);
  const sign = number > 0 ? '+' : number < 0 ? '-' : '';

  return `${sign}${Math.abs(number).toLocaleString('en-US')}`;
}

function typeLabel(row) {
  return COIN_TYPE_LABELS[row.type] ?? row.type;
}

function transactionLine(row) {
  return (
    `#${row.id} · ${typeLabel(row)} · **${signed(row.amount)}** · ` +
    `<@${row.user_id}> · <t:${Math.floor(row.created_at / 1000)}:R>`
  );
}

function parseRequest(ctx) {
  if (ctx.isSlash) {
    return {
      id: ctx.getInteger('id') ?? null,
      confirmed: ctx.getBoolean('confirm') === true,
    };
  }

  const first = String(ctx.args[0] ?? '');
  const id = /^\d+$/.test(first) ? Number(first) : null;
  const confirmed = CONFIRM_WORDS.has(String(ctx.args[1] ?? '').toLowerCase());

  return { id, confirmed };
}

function hint(ctx, id) {
  return ctx.isSlash
    ? `/coin-remove id:${id} confirm:true`
    : `${config.prefix}coin-remove ${id} confirm`;
}

async function showRecent(ctx) {
  const rows = recentAdminTransactions(ctx.guildId, SHOWN);

  if (rows.length === 0) {
    await ctx.reply(
      ephemeral(
        infoReply(
          'ما فيه حركات مشرف',
          'ما فيه إضافة أو خصم أو تعديل يدوي في سجل العملات عشان ينحذف.',
        ),
      ),
    );
    return;
  }

  await ctx.reply(
    ephemeral({
      embeds: [
        embed({
          title: 'آخر حركات المشرفين',
          description: rows.map(transactionLine).join('\n'),
          color: COLORS.primary,
          footer: `للحذف: ${hint(ctx, '<n>')}`,
        }),
      ],
      allowedMentions: { parse: [] },
    }),
  );
}

async function preview(ctx, row) {
  await ctx.reply(
    ephemeral({
      embeds: [
        embed({
          title: `الحركة #${row.id}`,
          description: [
            `النوع: **${typeLabel(row)}**`,
            `العضو: <@${row.user_id}>`,
            `المبلغ: **${signed(row.amount)}**`,
            `الرصيد بعدها: **${formatNumber(row.balance_after)}**`,
            `الوقت: <t:${Math.floor(row.created_at / 1000)}:f>`,
            `بواسطة: ${row.actor_id ? `<@${row.actor_id}>` : 'غير معروف'}`,
          ].join('\n'),
          color: COLORS.warning,
          footer: `للحذف: ${hint(ctx, row.id)}`,
        }),
      ],
      allowedMentions: { parse: [] },
    }),
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('coin-remove')
    .setDescription('مالك البوت: احذف حركة مشرف من سجل العملات')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((option) =>
      option
        .setName('id')
        .setDescription('رقم الحركة (اتركه فارغًا لعرض آخر الحركات)')
        .setMinValue(1)
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addBooleanOption((option) =>
      option
        .setName('confirm')
        .setDescription('أكّد الحذف (بدونها يعرض معاينة فقط)')
        .setRequired(false),
    ),

  name: 'coin-remove',
  aliases: ['coin-delete', 'coin-purge'],
  description: 'مالك البوت: احذف حركة مشرف من سجل العملات',
  category: 'Profile',
  usage: 'coin-remove [id] [confirm]',
  cooldown: 3,
  guildOnly: true,
  ownerOnly: true,

  async autocomplete(interaction) {
    if (!config.ownerIds.includes(interaction.user.id)) {
      await interaction.respond([]);
      return;
    }

    const focused = String(interaction.options.getFocused() ?? '').trim();
    const rows = recentAdminTransactions(interaction.guildId, 25).filter(
      (row) =>
        !focused ||
        String(row.id).includes(focused) ||
        String(row.user_id).includes(focused),
    );

    await interaction.respond(
      rows.slice(0, 25).map((row) => ({
        name: `#${row.id} · ${typeLabel(row)} · ${signed(row.amount)} · ${row.user_id}`.slice(
          0,
          100,
        ),
        value: row.id,
      })),
    );
  },

  async execute(ctx) {
    const { id, confirmed } = parseRequest(ctx);

    if (!id) {
      await showRecent(ctx);
      return;
    }

    const row = coinTransaction(ctx.guildId, id);

    if (!row) {
      await ctx.fail(
        ephemeral(
          errorReply(
            'الحركة غير موجودة',
            `ما فيه حركة رقم **${id}** في هذا السيرفر. اعرض آخر الحركات بـ \`${ctx.isSlash ? '/coin-remove' : `${config.prefix}coin-remove`}\`.`,
          ),
        ),
      );
      return;
    }

    if (!REMOVABLE.has(String(row.type))) {
      await ctx.fail(
        ephemeral(
          warnReply(
            'هذي الحركة ما تنحذف',
            'الحذف مقصور على حركات المشرفين (إضافة، خصم، تعديل). المكافآت والتحويلات والمشتريات سجل حقيقي.',
          ),
        ),
      );
      return;
    }

    if (!confirmed) {
      await preview(ctx, row);
      return;
    }

    const result = removeAdminTransaction(ctx.guildId, id);

    if (!result.ok) {
      await ctx.fail(
        ephemeral(
          errorReply(
            'ما انحذفت الحركة',
            result.reason === 'missing' ? 'اختفى السجل أثناء الحذف. جرّب مرة ثانية.' : 'هذي الحركة ما تنحذف.',
          ),
        ),
      );
      return;
    }

    logger.info(
      `${ctx.user.tag ?? ctx.user.username} (${ctx.user.id}) removed coin transaction #${id} in ${ctx.guildId}`,
    );

    await ctx.reply(
      ephemeral(
        okReply(
          'انحذفت الحركة',
          `**#${id}** (${typeLabel(row)} **${signed(row.amount)}** لـ <@${row.user_id}>) ما عادت في السجل.\n` +
            'الأرقام اللي بعدها انضبطت، والرصيد الحالي ما تغيّر.',
        ),
      ),
    );
  },
};
