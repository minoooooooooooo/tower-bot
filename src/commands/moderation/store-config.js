import {
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
import {
  clearStoreOverride,
  findStoreItem,
  setStoreOverride,
  storeCatalog,
  storeSales,
  voidMemberPurchases,
} from '../../services/store.js';
import { STORE_TYPE_LABELS } from '../../services/store-catalog.js';

const SUBCOMMANDS = new Set(['list', 'price', 'enable', 'disable', 'reset', 'reset-user']);

const SUBCOMMAND_ALIASES = {
  show: 'list',
  items: 'list',
  status: 'list',
  set: 'price',
  cost: 'price',
  on: 'enable',
  off: 'disable',
  clear: 'reset',
  default: 'reset',
  revoke: 'reset-user',
  void: 'reset-user',
  'reset-member': 'reset-user',
};

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

async function requireManageServer(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await ctx.fail(
    ephemeral(errorReply('صلاحيات ناقصة', 'تحتاج **إدارة السيرفر** عشان تغيّر المتجر.')),
  );

  return false;
}

function subcommandOf(ctx) {
  if (ctx.isSlash) return ctx.getSubcommand() ?? 'list';

  const raw = String(ctx.args[0] ?? '').toLowerCase();
  const mapped = SUBCOMMAND_ALIASES[raw] ?? raw;

  return SUBCOMMANDS.has(mapped) ? mapped : 'list';
}

function prefixRest(ctx) {
  const raw = String(ctx.args[0] ?? '').toLowerCase();
  const mapped = SUBCOMMAND_ALIASES[raw] ?? raw;

  return SUBCOMMANDS.has(mapped) ? ctx.args.slice(1) : ctx.args;
}

function itemOf(ctx) {
  if (ctx.isSlash) return ctx.getString('item');
  return prefixRest(ctx)[0] ?? null;
}

function listEmbed(ctx) {
  const items = storeCatalog(ctx.guildId);
  const sales = storeSales(ctx.guildId);
  const plain = items.filter((item) => item.type !== 'background');
  const designs = items.filter((item) => item.type === 'background');

  const priceText = (item) =>
    item.price === item.defaultPrice
      ? `**${formatNumber(item.price)}** كوينز`
      : `**${formatNumber(item.price)}** كوينز (الأساسي ${formatNumber(item.defaultPrice)})`;

  const fields = plain.map((item) => {
    const sold = sales.get(item.key);

    return {
      name: `\`${item.key}\` · ${item.name}`,
      value:
        `${STORE_TYPE_LABELS[item.type] ?? item.type} · ${priceText(item)} · ${item.enabled ? 'مفعّل' : '**مقفّل**'}` +
        ` · ${sold ? `${sold.count} مبيعة (${formatNumber(sold.coins)} كوينز)` : 'ما انباع'}`,
      inline: false,
    };
  });

  if (designs.length === 0) {
    fields.push({
      name: 'تصاميم المتجر',
      value:
        'ما فيه. التصميم يصير صنف في المتجر لما ينضاف له `price` في قائمة الخلفيات.',
      inline: false,
    });
  } else {
    // Fifty designs do not fit in one field, or in one field each.
    const size = 12;

    for (let index = 0; index < designs.length; index += size) {
      const chunk = designs.slice(index, index + size);
      const part = Math.floor(index / size) + 1;
      const parts = Math.ceil(designs.length / size);

      fields.push({
        name: parts > 1 ? `تصاميم المتجر (${part}/${parts})` : 'تصاميم المتجر',
        value: chunk
          .map((item) => {
            const sold = sales.get(item.key);
            return (
              `\`${item.key}\` · ${formatNumber(item.price)}` +
              `${item.enabled ? '' : ' · **مقفّل**'}` +
              `${sold ? ` · ${sold.count} مبيعة` : ''}`
            );
          })
          .join('\n'),
        inline: false,
      });
    }
  }

  return embed({
    title: 'إعدادات المتجر',
    description:
      'الأسعار والظهور محفوظة لكل سيرفر على حدة. الخلفيات تنضاف وتتعدّل وتنحذف من ' +
      '**إدارة السيرفر** داخل متجر النشاط ← الخلفيات.',
    color: COLORS.primary,
    fields,
    footer: `تغيّره بـ ${ctx.isSlash ? '/store-config' : `${config.prefix}store-config`} price|enable|disable|reset`,
  });
}

function unknownItem(ctx, query) {
  return errorReply(
    'صنف غير معروف',
    `ما لقيت \`${query}\`. شوف المفاتيح بـ \`${ctx.isSlash ? '/store-config list' : `${config.prefix}store-config list`}\`.`,
  );
}

async function handlePrice(ctx) {
  const query = itemOf(ctx);
  const raw = ctx.isSlash ? ctx.getInteger('price') : Number(prefixRest(ctx)[1]);

  const item = query ? findStoreItem(ctx.guildId, query) : null;

  if (!item) {
    await ctx.fail(ephemeral(unknownItem(ctx, query ?? '')));
    return;
  }

  if (!Number.isSafeInteger(raw) || raw < 0) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'سعر غير صحيح',
          `حط عدد كوينز صحيح، مثل \`${ctx.isSlash ? '/store-config price item:xp-10 price:50' : `${config.prefix}store-config price xp-10 50`}\`.`,
        ),
      ),
    );
    return;
  }

  const updated = setStoreOverride(ctx.guildId, item.key, { price: raw });

  await ctx.reply(
    ephemeral(
      okReply(
        'تم تغيير السعر',
        `**${item.name}** الحين بـ **${formatNumber(updated.price)}** كوينز (الأساسي ${formatNumber(updated.defaultPrice)}).`,
      ),
    ),
  );
}

async function handleToggle(ctx, enabled) {
  const query = itemOf(ctx);
  const item = query ? findStoreItem(ctx.guildId, query) : null;

  if (!item) {
    await ctx.fail(ephemeral(unknownItem(ctx, query ?? '')));
    return;
  }

  setStoreOverride(ctx.guildId, item.key, { enabled });

  await ctx.reply(
    ephemeral(
      okReply(
        enabled ? 'الصنف رجع للمتجر' : 'تم إخفاء الصنف',
        enabled
          ? `**${item.name}** رجع يظهر في المتجر.`
          : `**${item.name}** ما عاد يظهر في المتجر. الأرصدة ما تتغيّر.`,
      ),
    ),
  );
}

async function handleReset(ctx) {
  const query = itemOf(ctx);
  const item = query ? findStoreItem(ctx.guildId, query) : null;

  if (!item) {
    await ctx.fail(ephemeral(unknownItem(ctx, query ?? '')));
    return;
  }

  const updated = clearStoreOverride(ctx.guildId, item.key);

  await ctx.reply(
    ephemeral(
      okReply(
        'تمت إعادة الصنف',
        `**${item.name}** رجع للأساسي: ${formatNumber(updated.defaultPrice)} كوينز و${updated.enabled ? 'معروض' : 'مخفي'}.`,
      ),
    ),
  );
}

async function resolveTarget(ctx, client) {
  if (ctx.isSlash) return ctx.getUser('user') ?? null;

  const token = prefixRest(ctx)[0];
  if (!token) return null;

  return resolveUser(client, token, ctx.message);
}

async function handleResetUser(ctx, client) {
  const target = await resolveTarget(ctx, client);

  if (!target) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'حدّد العضو',
          `استخدم \`${ctx.isSlash ? '/store-config reset-user user:@member' : `${config.prefix}store-config reset-user @member`}\`.`,
        ),
      ),
    );
    return;
  }

  const keyToken = ctx.isSlash ? ctx.getString('item') : prefixRest(ctx)[1] ?? null;
  let key = null;

  if (keyToken) {
    const item = findStoreItem(ctx.guildId, keyToken);

    if (!item) {
      await ctx.fail(ephemeral(unknownItem(ctx, keyToken)));
      return;
    }

    key = item.key;
  }

  const cleared = voidMemberPurchases(ctx.guildId, target.id, key);

  if (cleared === 0) {
    await ctx.reply(
      ephemeral(
        warnReply(
          'ما فيه شي لمسحه',
          key
            ? `<@${target.id}> ما عنده شراء مكتمل لـ **${key}**.`
            : `<@${target.id}> ما عنده مشتريات مكتملة.`,
        ),
      ),
    );
    return;
  }

  await ctx.reply(
    ephemeral(
      okReply(
        'تم مسح المشتريات',
        `مسحت **${cleared}** من مشتريات <@${target.id}> (${key ? `**${key}**` : 'كل شي'}). يقدر يشتري مرة ثانية. الرتب والإيموجيات اللي انشأت ما تنحذف.`,
      ),
    ),
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('store-config')
    .setDescription('غيّر أسعار المتجر أو اخفِ الأصناف')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('كل صنف وسعره ومبيعاته'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('price')
        .setDescription('حدّد سعر صنف')
        .addStringOption((option) =>
          option
            .setName('item')
            .setDescription('مفتاح الصنف')
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addIntegerOption((option) =>
          option
            .setName('price')
            .setDescription('عدد الكوينز (0 يخليه مجاني)')
            .setMinValue(0)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('enable')
        .setDescription('رجّع صنف مخفي للمتجر')
        .addStringOption((option) =>
          option
            .setName('item')
            .setDescription('مفتاح الصنف')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('disable')
        .setDescription('اخفِ صنف بدون ما تحذفه')
        .addStringOption((option) =>
          option
            .setName('item')
            .setDescription('مفتاح الصنف')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reset')
        .setDescription('رجّع الصنف لسعره وظهوره الأساسي')
        .addStringOption((option) =>
          option
            .setName('item')
            .setDescription('مفتاح الصنف')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reset-user')
        .setDescription('امسح مشتريات عضو عشان يقدر يشتري مرة ثانية')
        .addUserOption((option) =>
          option.setName('user').setDescription('العضو').setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('item')
            .setDescription('هذا الصنف فقط (الافتراضي: كل شي)')
            .setRequired(false)
            .setAutocomplete(true),
        ),
    ),

  name: 'store-config',
  aliases: ['store-admin', 'shop-config'],
  description: 'غيّر أسعار المتجر أو اخفِ الأصناف',
  category: 'Moderation',
  usage: 'store-config [list | price <key> <coins> | enable|disable|reset <key> | reset-user <@member> [key]]',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ManageGuild'],

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const query = String(focused.value ?? '').toLowerCase();

    const items = storeCatalog(interaction.guildId).filter(
      (item) =>
        !query ||
        item.key.toLowerCase().includes(query) ||
        item.name.toLowerCase().includes(query),
    );

    await interaction.respond(
      items.slice(0, 25).map((item) => ({
        name: `${item.key} · ${item.name}`.slice(0, 100),
        value: item.key,
      })),
    );
  },

  async execute(ctx, client) {
    if (!(await requireManageServer(ctx))) return;

    switch (subcommandOf(ctx)) {
      case 'price':
        return handlePrice(ctx);
      case 'enable':
        return handleToggle(ctx, true);
      case 'disable':
        return handleToggle(ctx, false);
      case 'reset':
        return handleReset(ctx);
      case 'reset-user':
        return handleResetUser(ctx, client);
      default:
        return ctx.reply(ephemeral({ embeds: [listEmbed(ctx)] }));
    }
  },
};
