import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from '../../config.js';
import { formatNumber } from '../../lib/activity-format.js';
import { COLORS, embed } from '../../lib/embeds.js';
import { errorReply, okReply, warnReply } from '../../lib/replies.js';
import { resolveUser } from '../../lib/resolve.js';
import { backgroundById } from '../../services/profile-backgrounds.js';
import {
  buyStoreItem,
  findStoreItem,
  memberPurchases,
  ownedBackgroundIds,
  storeBalance,
  storeCatalog,
} from '../../services/store.js';
import { STORE_TYPE_LABELS } from '../../services/store-catalog.js';

const TYPE_ORDER = ['background', 'xp', 'behavior', 'title', 'role', 'emoji'];

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

function respond(ctx, payload) {
  return ctx.reply(ctx.isSlash ? ephemeral(payload) : payload);
}

function subcommandOf(ctx) {
  if (ctx.isSlash) return ctx.getSubcommand() ?? 'browse';

  const raw = String(ctx.args[0] ?? '').toLowerCase();

  if (!raw) return 'browse';
  if (['buy', 'purchase', 'get'].includes(raw)) return 'buy';
  if (['owned', 'inventory', 'items', 'purchases', 'bag'].includes(raw)) return 'owned';

  return 'browse';
}

function hint(ctx, text) {
  return `${text}\n\nشوف الكتالوج بـ \`${ctx.isSlash ? '/store' : `${config.prefix}store`}\`.`;
}

function needsText(item) {
  const needs = item.needs ?? [];
  const parts = [];

  if (needs.includes('name')) parts.push(item.type === 'title' ? 'نص اللقب' : 'اسم');
  if (needs.includes('color')) parts.push('لون اختياري');
  if (needs.includes('image')) parts.push('صورة');

  return parts.length ? ` · يحتاج ${parts.join(' + ')}` : '';
}

function itemLine(item, owned) {
  const bought = item.type === 'background' && owned?.has(item.backgroundId);
  const mark = bought ? '✅' : '•';
  const limit = item.limit > 0 ? ` · أقصى ${item.limit}` : '';
  const stack = item.stackable ? ' لكل وحدة' : '';

  return (
    `${mark} \`${item.key}\` — **${item.name}** · ${formatNumber(item.price)} عملة${stack}${limit}` +
    `${bought ? ' · مملوك' : ''}${needsText(item)}`
  );
}

function backgroundLine(item, owned) {
  const bought = owned?.has(item.backgroundId);
  const name = item.name.replace(/\s+background$/i, '');

  return `${bought ? '✅' : '•'} ${name} · ${formatNumber(item.price)}`;
}

function browseEmbed(ctx, items, balance, owned) {
  const fields = TYPE_ORDER.flatMap((type) => {
    const group = items.filter((item) => item.type === type);
    const label = STORE_TYPE_LABELS[type] ?? type;

    if (group.length === 0) {
      if (type !== 'background') return [];

      return [
        {
          name: label,
          value:
            'ما فيه تصاميم مدفوعة بعد. التصميم يطلع هنا أول ما يصير له `price` في ' +
            '`assets/profile/backgrounds/backgrounds.json`.',
          inline: false,
        },
      ];
    }

    // Fifty designs do not fit in one embed field. Split the compact list in
    // half; the Activity shows the same catalogue with pictures.
    if (type === 'background' && group.length > 10) {
      const middle = Math.ceil(group.length / 2);

      return [
        {
          name: `${label} (1/2)`,
          value: group.slice(0, middle).map((item) => backgroundLine(item, owned)).join('\n'),
          inline: false,
        },
        {
          name: `${label} (2/2)`,
          value: group.slice(middle).map((item) => backgroundLine(item, owned)).join('\n'),
          inline: false,
        },
      ];
    }

    return [
      {
        name: label,
        value: group.map((item) => itemLine(item, owned)).join('\n'),
        inline: false,
      },
    ];
  });

  fields.unshift({ name: 'رصيدك', value: `**${formatNumber(balance)}** عملة`, inline: true });

  return embed({
    title: 'المتجر',
    description:
      'اصرف عملات على ترقيات ملفك وسيرفرك. العملات تجيك من المستويات، ' +
      'ويقدر الأعضاء يحوّلون لك منها.',
    color: COLORS.primary,
    fields,
    footer: `اشترِ بـ ${ctx.isSlash ? '/store buy item:' : `${config.prefix}store buy `}<المفتاح أو الاسم>`,
  });
}

async function handleBrowse(ctx) {
  const items = storeCatalog(ctx.guildId).filter((item) => item.enabled);
  const balance = storeBalance(ctx.guildId, ctx.user.id);
  const owned = ownedBackgroundIds(ctx.guildId, ctx.user.id);
  // Mirrors activityConfigured(): a button that can only fail is worse than no
  // button, so it appears only when the server would actually start.
  const activityReady =
    config.activity.enabled && Boolean(config.clientId) && Boolean(config.activity.clientSecret);
  const components = activityReady
    ? [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('store:launch')
            .setLabel('افتح المتجر')
            .setEmoji('🛍️')
            .setStyle(ButtonStyle.Primary),
        ),
      ]
    : [];

  await respond(ctx, { embeds: [browseEmbed(ctx, items, balance, owned)], components });
}

function detailLine(item, detail) {
  if (!detail) return '';

  if (item?.type === 'role' && detail.roleId) return ` — <@&${detail.roleId}>`;
  if (item?.type === 'emoji' && detail.name) return ` — \`:${detail.name}:\``;
  if (item?.type === 'background' && detail.backgroundId) {
    const design = backgroundById(detail.backgroundId);
    return ` — ${design?.name ?? detail.backgroundId}`;
  }
  if (item?.type === 'title' && detail.title) return ` — “${detail.title}”`;
  if (item?.type === 'xp' && detail.xp) return ` — +${formatNumber(detail.xp)} XP`;
  if (item?.type === 'behavior' && detail.points) return ` — +${formatNumber(detail.points)} نقطة`;

  return '';
}

async function handleOwned(ctx, client) {
  let target = ctx.user;

  if (ctx.isSlash) {
    target = ctx.getUser('user') ?? ctx.user;
  } else if (ctx.args[1]) {
    target = await resolveUser(client, ctx.args[1], ctx.message);

    if (!target) {
      await respond(ctx, errorReply('عضو غير معروف', 'منشن العضو أو الصق الآيدي.'));
      return;
    }
  }

  if (target.id !== ctx.user.id && !ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
    await respond(
      ctx,
      errorReply('صلاحيات ناقصة', 'تحتاج **إدارة السيرفر** عشان تشوف مشتريات عضو ثاني.'),
    );
    return;
  }

  const purchases = memberPurchases(ctx.guildId, target.id);
  const catalog = new Map(storeCatalog(ctx.guildId).map((item) => [item.key, item]));
  const spent = purchases.reduce((total, row) => total + row.price, 0);
  const lines = purchases
    .slice(0, 20)
    .map((row) => {
      const item = catalog.get(row.item_key);
      return `• **${item?.name ?? row.item_key}** — ${formatNumber(row.price)} عملة${detailLine(item, row.detail)}`;
    });

  const title = target.id === ctx.user.id ? 'مشترياتك' : `<@${target.id}> · المشتريات`;

  await respond(ctx, {
    embeds: [
      embed({
        title,
        description:
          lines.length > 0
            ? lines.join('\n')
            : `ما اشتريت شي بعد. شوف المعروض بـ \`${ctx.isSlash ? '/store' : `${config.prefix}store`}\`.`,
        color: COLORS.primary,
        footer:
          purchases.length > 0
            ? `${purchases.length} مشترى · ${formatNumber(spent)} عملة مصروفة`
            : undefined,
      }),
    ],
  });
}

/** Prefix colour tokens: `#ff8800`, `0xff8800` or `color:red` as the last word. */
function isColorToken(token) {
  const text = String(token ?? '');

  return /^color:/i.test(text) || /^#/.test(text) || /^0x[0-9a-f]+$/i.test(text);
}

function splitRoleArgs(tokens) {
  const copy = [...tokens];
  let color = null;

  if (copy.length > 1 && isColorToken(copy.at(-1))) {
    color = copy.pop().replace(/^color:/i, '');
  }

  return { name: copy.join(' '), color };
}

function successText(result, ctx) {
  const { item, detail } = result;

  switch (item.type) {
    case 'xp':
      return okReply(
        'انضافت الخبرة',
        `**+${formatNumber(detail.xp ?? item.amount)} XP** على بطاقتك. ` +
          'العقوبات الشغّالة لسا تنقص من الخبرة الجديدة.',
      );
    case 'behavior': {
      const points = detail.points ?? item.amount;
      return okReply(
        'انضاف السلوك الحسن',
        `**+${formatNumber(points)} نقطة سلوك حسن** على بطاقتك.`,
      );
    }
    case 'title':
      return okReply('تحدّث اللقب', `بطاقتك الحين تقول **${detail.title}**.`);
    case 'background': {
      const design = backgroundById(detail.backgroundId);
      return okReply(
        'انفتحت الخلفية',
        `**${design?.name ?? detail.backgroundId}** صارت لك. فعّلها بـ ` +
          `\`${ctx.isSlash ? '/background set design:' : `${config.prefix}background set `}${design?.name ?? detail.backgroundId}\`.`,
      );
    }
    case 'role':
      return okReply(
        'انصنعت الرتبة',
        `<@&${detail.roleId}> صارت لك${detail.color ? ` (${detail.color})` : ''}.`,
      );
    case 'emoji':
      return okReply('انضاف الإيموجي', `\`:${detail.name}:\` الحين متاح في هذا السيرفر.`);
    default:
      return okReply('تم الشراء', item.name);
  }
}

const FAILURES = {
  unknown: (result, ctx) =>
    errorReply('منتج غير معروف', hint(ctx, `ما لقيت \`${result.query}\`.`)),
  disabled: (result) =>
    warnReply('مو للبيع', `**${result.item.name}** مقفّل في هذا السيرفر.`),
  unpriced: (result) =>
    warnReply('مو للبيع', `**${result.item.name}** ما له سعر بعد. مشرف يقدر يحدده.`),
  limit: (result) =>
    warnReply(
      'وصلت الحد',
      `تملك الحد الأقصى **${result.limit}** من **${result.item.name}** من قبل.`,
    ),
  funds: (result) =>
    warnReply(
      'ما عندك عملات كافية',
      `**${result.item.name}**${result.quantity > 1 ? ` × ${result.quantity}` : ''} سعره ` +
        `**${formatNumber(result.totalPrice ?? result.item.price)}** عملة وعندك ` +
        `**${formatNumber(result.balance)}**.`,
    ),
  name: (result) => errorReply('محتاج اسم', result.message),
  color: (result) => errorReply('لون غير معروف', result.message),
  image: (result) => errorReply('محتاج صورة', result.message),
  size: (result) => errorReply('الصورة كبيرة', result.message),
  slots: (result) => errorReply('ما فيه خانات إيموجي فاضية', result.message),
  permission: (result) => errorReply('صلاحية ناقصة', result.message),
  guild: () => errorReply('مو في سيرفر', 'المتجر يشتغل داخل السيرفر بس.'),
  database: (result) =>
    errorReply(
      'ما كملت عملية الشراء',
      `ما انخصم شي. جرّب تشتري **${result.item.name}** مرة ثانية.`,
    ),
  delivery: (result) =>
    warnReply('انسترجع المبلغ', result.message ?? 'التسليم فشل ورجعت عملاتك.'),
};

async function handleBuy(ctx, client) {
  const key = ctx.isSlash ? ctx.getString('item') : ctx.args[1];

  if (!key) {
    await respond(
      ctx,
      errorReply(
        'اختر منتج',
        hint(ctx, `استخدم \`${ctx.isSlash ? '/store buy item:' : `${config.prefix}store buy `}<key>\`.`),
      ),
    );
    return;
  }

  const item = findStoreItem(ctx.guildId, key);

  if (!item) {
    await respond(ctx, errorReply('منتج غير معروف', hint(ctx, `ما لقيت \`${key}\`.`)));
    return;
  }

  const slashName = ctx.isSlash ? ctx.getString('name') ?? null : null;
  const slashColor = ctx.isSlash ? ctx.getString('color') ?? null : null;
  const slashImage = ctx.isSlash ? ctx.getAttachment('image') ?? null : null;
  let quantity = ctx.isSlash ? Math.trunc(Number(ctx.getInteger('quantity')) || 1) : 1;
  let rest = ctx.isSlash ? [] : ctx.args.slice(2);
  let name = slashName;
  let color = slashColor;

  // Prefix shorthand: a trailing whole number is the quantity for stackable
  // items, e.g. `:-store buy behavior-1 5`.
  if (!ctx.isSlash && item.stackable && rest.length > 0 && /^\d+$/.test(rest.at(-1))) {
    quantity = Number(rest.at(-1));
    rest = rest.slice(0, -1);
  }

  if (!ctx.isSlash) {
    if (item.type === 'role') {
      const parsed = splitRoleArgs(rest);
      name = parsed.name || null;
      color = parsed.color;
    } else if (item.type === 'emoji') {
      name = rest[0] ?? null;
    } else if (item.type === 'title') {
      name = rest.join(' ') || null;
    }
  }

  const attachment =
    slashImage ?? (ctx.isSlash ? null : ctx.message?.attachments?.first?.() ?? null);

  if (ctx.isSlash) await ctx.defer({ ephemeral: true });
  else await ctx.typing();

  let result;

  try {
    result = await buyStoreItem({
      guild: ctx.guild,
      guildId: ctx.guildId,
      userId: ctx.user.id,
      member: ctx.member,
      key: item.key,
      name,
      color,
      attachment,
      quantity,
    });
  } catch (error) {
    await ctx.fail(
      errorReply('ما وصلت للمتجر', 'ما انخصم شي. جرّب بعد لحظة.'),
    );
    return;
  }

  if (!result.ok) {
    const build = FAILURES[result.reason] ?? (() =>
      errorReply('فشل الشراء', hint(ctx, 'ما ضبط. جرّب مرة ثانية.')));

    await ctx.fail(build(result, ctx));
    return;
  }

  const text = successText(result, ctx);

  await ctx.editReply({
    content: `${text.content}\n\nالرصيد: **${formatNumber(result.balance)}** عملة.`,
    allowedMentions: { parse: [] },
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('store')
    .setDescription('اصرف عملات على ترقيات ملفك وسيرفرك')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub.setName('browse').setDescription('اعرض الكتالوج ورصيدك'))
    .addSubcommand((sub) =>
      sub
        .setName('buy')
        .setDescription('اشترِ منتج من الكتالوج')
        .addStringOption((option) =>
          option
            .setName('item')
            .setDescription('مفتاح المنتج، مثل xp-10 أو design:tier-20')
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addIntegerOption((option) =>
          option
            .setName('quantity')
            .setDescription('للمنتجات المتعددة بس، مثل نقاط السلوك (الافتراضي 1)')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(100),
        )
        .addStringOption((option) =>
          option
            .setName('name')
            .setDescription('اسم الرتبة أو الإيموجي، أو اللقب اللي تبي تحطه')
            .setRequired(false)
            .setMaxLength(64),
        )
        .addStringOption((option) =>
          option
            .setName('color')
            .setDescription('لون الرتبة: #ff8800، red، أو أحمر')
            .setRequired(false)
            .setMaxLength(32),
        )
        .addAttachmentOption((option) =>
          option
            .setName('image')
            .setDescription('صورة الإيموجي: PNG أو JPEG أو WebP أو GIF حتى 256 كيلوبايت')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('owned')
        .setDescription('اعرض اللي اشتريته')
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('مشرف: اعرض عضو ثاني (إدارة السيرفر)')
            .setRequired(false),
        ),
    ),

  name: 'store',
  aliases: ['shop'],
  description: 'اصرف عملات على ترقيات ملفك وسيرفرك',
  category: 'Profile',
  usage: 'store [browse | buy <key> [name] [colour] [quantity] | owned [@member]]',
  cooldown: 3,
  guildOnly: true,

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const query = String(focused.value ?? '').toLowerCase();

    const items = storeCatalog(interaction.guildId)
      .filter((item) => item.enabled)
      .filter(
        (item) =>
          !query ||
          item.key.toLowerCase().includes(query) ||
          item.name.toLowerCase().includes(query) ||
          item.type.includes(query),
      )
      .slice(0, 25);

    await interaction.respond(
      items.map((item) => ({
        name: `${item.name} · ${formatNumber(item.price)} عملة`.slice(0, 100),
        value: item.key,
      })),
    );
  },

  async execute(ctx, client) {
    const subcommand = subcommandOf(ctx);

    if (subcommand === 'buy') return handleBuy(ctx, client);
    if (subcommand === 'owned') return handleOwned(ctx, client);

    return handleBrowse(ctx);
  },
};
