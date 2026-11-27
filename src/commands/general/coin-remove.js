import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { config } from '../../config.js';
import { formatNumber } from '../../lib/activity-format.js';
import { COLORS, embed } from '../../lib/embeds.js';
import { createLogger } from '../../lib/logger.js';
import { attachPager, pagerMessage, withPager } from '../../lib/pager.js';
import { errorReply, infoReply, okReply, warnReply } from '../../lib/replies.js';
import { resolveUser } from '../../lib/resolve.js';
import {
  COIN_TYPE_LABELS,
  adminTransactions,
  coinTransaction,
  countAdminTransactions,
  removeAdminTransaction,
} from '../../services/coin-ledger.js';

const logger = createLogger('coin-remove');

/** Rows per page in the adjustment list. */
const PAGE_SIZE = 15;

/** Mentioned members never collide with a transaction id. */
const MENTION = /^<@!?\d+>$/;

/** A raw number this long is a member id, not a ledger id. */
const RAW_USER_ID = /^\d{17,20}$/;

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

/**
 * Splits what the caller typed. The first token may name a member (mention or
 * a 17-20 digit id) or a ledger id; any later number is a page, and any
 * confirm word marks the delete. Ledger ids are short, so the two number
 * shapes never overlap in practice.
 */
function parseRequest(ctx) {
  if (ctx.isSlash) {
    return {
      id: ctx.getInteger('id') ?? null,
      user: ctx.getUser('user') ?? null,
      filterToken: null,
      page: Math.max(1, ctx.getInteger('page') ?? 1),
      confirmed: ctx.getBoolean('confirm') === true,
    };
  }

  const args = [...ctx.args];
  let id = null;
  let filterToken = null;
  let confirmed = false;
  let page = 1;

  if (args[0] && MENTION.test(String(args[0]))) {
    filterToken = String(args.shift());
  } else if (args[0] && RAW_USER_ID.test(String(args[0]))) {
    filterToken = String(args.shift());
  } else if (args[0] && /^\d+$/.test(String(args[0]))) {
    id = Number(args.shift());
  }

  for (const arg of args) {
    const token = String(arg).toLowerCase();

    if (CONFIRM_WORDS.has(token)) confirmed = true;
    else if (/^\d+$/.test(token) && !id) page = Math.max(1, Number(token));
  }

  return { id, user: null, filterToken, page, confirmed };
}

function hint(ctx, id) {
  return ctx.isSlash
    ? `/coin-remove id:${id} confirm:true`
    : `${config.prefix}coin-remove ${id} confirm`;
}

function listHint(ctx) {
  return ctx.isSlash ? '/coin-remove user:@member' : `${config.prefix}coin-remove @member`;
}

/**
 * The paged, optionally member-filtered list of hand-written adjustments.
 * Buttons go back through the whole history, so adjustments older than the
 * first page stay reachable.
 */
async function showList(ctx, { user = null, page = 1 } = {}) {
  const userId = user?.id ?? null;
  const total = countAdminTransactions(ctx.guildId, { userId });

  if (total === 0) {
    await ctx.reply(
      ephemeral(
        infoReply(
          user ? 'ما فيه حركات لهذا العضو' : 'ما فيه حركات مشرف',
          user
            ? `ما فيه إضافة أو خصم أو تعديل يدوي لـ <@${user.id}> في سجل العملات.`
            : 'ما فيه إضافة أو خصم أو تعديل يدوي في سجل العملات عشان ينحذف.',
        ),
      ),
    );
    return;
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const startPage = Math.min(Math.max(1, page), pages);

  const render = (current) => {
    const rows = adminTransactions(ctx.guildId, {
      userId,
      limit: PAGE_SIZE,
      offset: (current - 1) * PAGE_SIZE,
    });

    const header = user
      ? `العضو: <@${user.id}> · ${formatNumber(total)} حركة`
      : `كل الأعضاء · ${formatNumber(total)} حركة`;

    return {
      embeds: [
        embed({
          title: 'حركات المشرفين',
          description: [header, 'الأحدث أولًا', '', rows.map(transactionLine).join('\n')].join('\n'),
          color: COLORS.primary,
          footer: `للحذف: ${hint(ctx, '<n>')} · صفحة ${formatNumber(current)} / ${formatNumber(pages)}`,
        }),
      ],
      allowedMentions: { parse: [] },
    };
  };

  const sent = await ctx.reply(
    ephemeral(
      withPager({ id: 'coin-remove', page: startPage, pages, payload: render(startPage) }),
    ),
  );

  await attachPager({
    ctx,
    message: await pagerMessage(ctx, sent),
    id: 'coin-remove',
    pages,
    page: startPage,
    render,
  });
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
        .setDescription('رقم الحركة (اتركه فارغًا لعرض الحركات)')
        .setMinValue(1)
        .setRequired(false)
        .setAutocomplete(true),
    )
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('اعرض حركات عضو واحد فقط')
        .setRequired(false),
    )
    .addIntegerOption((option) =>
      option
        .setName('page')
        .setDescription(`رقم الصفحة (${PAGE_SIZE} حركة في الصفحة)`)
        .setMinValue(1)
        .setRequired(false),
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
  usage: 'coin-remove [@member | id] [page] [confirm]',
  cooldown: 3,
  guildOnly: true,
  ownerOnly: true,

  async autocomplete(interaction) {
    if (!config.ownerIds.includes(interaction.user.id)) {
      await interaction.respond([]);
      return;
    }

    const focused = String(interaction.options.getFocused() ?? '').trim();
    const rows = adminTransactions(interaction.guildId, { limit: 25 });

    // A typed id may be older than the latest page; show it anyway so it can
    // be picked without paging by hand.
    if (/^\d+$/.test(focused)) {
      const direct = coinTransaction(interaction.guildId, Number(focused));

      if (
        direct &&
        REMOVABLE.has(String(direct.type)) &&
        !rows.some((row) => row.id === direct.id)
      ) {
        rows.unshift(direct);
      }
    }

    const matched = rows.filter(
      (row) =>
        !focused || String(row.id).includes(focused) || String(row.user_id).includes(focused),
    );

    await interaction.respond(
      matched.slice(0, 25).map((row) => ({
        name: `#${row.id} · ${typeLabel(row)} · ${signed(row.amount)} · ${row.user_id}`.slice(
          0,
          100,
        ),
        value: row.id,
      })),
    );
  },

  async execute(ctx, client) {
    const parsed = parseRequest(ctx);
    let filterUser = parsed.user;

    if (parsed.filterToken) {
      filterUser = await resolveUser(client, parsed.filterToken, ctx.message);

      if (!filterUser) {
        await ctx.fail(
          ephemeral(
            errorReply(
              'عضو غير معروف',
              `منشن العضو أو الصق الآيدي، مثل \`${listHint(ctx)}\`.`,
            ),
          ),
        );
        return;
      }
    }

    if (!parsed.id) {
      await showList(ctx, { user: filterUser, page: parsed.page });
      return;
    }

    const row = coinTransaction(ctx.guildId, parsed.id);

    if (!row) {
      await ctx.fail(
        ephemeral(
          errorReply(
            'الحركة غير موجودة',
            `ما فيه حركة رقم **${parsed.id}** في هذا السيرفر. اعرض الحركات بـ \`${ctx.isSlash ? '/coin-remove' : `${config.prefix}coin-remove`}\`.`,
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

    if (!parsed.confirmed) {
      await preview(ctx, row);
      return;
    }

    const result = removeAdminTransaction(ctx.guildId, parsed.id);

    if (!result.ok) {
      await ctx.fail(
        ephemeral(
          errorReply(
            'ما انحذفت الحركة',
            result.reason === 'missing'
              ? 'اختفى السجل أثناء الحذف. جرّب مرة ثانية.'
              : 'هذي الحركة ما تنحذف.',
          ),
        ),
      );
      return;
    }

    logger.info(
      `${ctx.user.tag ?? ctx.user.username} (${ctx.user.id}) removed coin transaction #${parsed.id} in ${ctx.guildId}`,
    );

    await ctx.reply(
      ephemeral(
        okReply(
          'انحذفت الحركة',
          `**#${parsed.id}** (${typeLabel(row)} **${signed(row.amount)}** لـ <@${row.user_id}>) ما عادت في السجل.\n` +
            'الأرقام اللي بعدها انضبطت، والرصيد الحالي ما تغيّر.',
        ),
      ),
    );
  },
};
