import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from '../../config.js';
import { formatNumber } from '../../lib/activity-format.js';
import { COLORS, embed, errorEmbed, successEmbed, warningEmbed } from '../../lib/embeds.js';
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

  await ctx.reply(
    ephemeral({
      embeds: [
        errorEmbed('Missing permissions', 'You need **Manage Server** to change the store.'),
      ],
    }),
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
      ? `**${formatNumber(item.price)}** coins`
      : `**${formatNumber(item.price)}** coins (default ${formatNumber(item.defaultPrice)})`;

  const fields = plain.map((item) => {
    const sold = sales.get(item.key);

    return {
      name: `\`${item.key}\` · ${item.name}`,
      value:
        `${STORE_TYPE_LABELS[item.type] ?? item.type} · ${priceText(item)} · ${item.enabled ? 'on' : '**off**'}` +
        ` · ${sold ? `${sold.count} sold (${formatNumber(sold.coins)} coins)` : 'never sold'}`,
      inline: false,
    };
  });

  if (designs.length === 0) {
    fields.push({
      name: 'Store designs',
      value:
        'None. A design becomes a store item when its entry in the background manifest gets a `price`.',
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
        name: parts > 1 ? `Store designs (${part}/${parts})` : 'Store designs',
        value: chunk
          .map((item) => {
            const sold = sales.get(item.key);
            return (
              `\`${item.key}\` · ${formatNumber(item.price)}` +
              `${item.enabled ? '' : ' · **off**'}` +
              `${sold ? ` · ${sold.count} sold` : ''}`
            );
          })
          .join('\n'),
        inline: false,
      });
    }
  }

  return embed({
    title: 'Store settings',
    description:
      'Prices and visibility are stored per server. Backgrounds can also be added, edited and ' +
      'deleted by a **Manage Server** member in the Activity store → Backgrounds.',
    color: COLORS.primary,
    fields,
    footer: `Change with ${ctx.isSlash ? '/store-config' : `${config.prefix}store-config`} price|enable|disable|reset`,
  });
}

function unknownItem(ctx, query) {
  return {
    embeds: [
      errorEmbed(
        'Unknown item',
        `I could not find \`${query}\`. Use \`${ctx.isSlash ? '/store-config list' : `${config.prefix}store-config list`}\` to see the keys.`,
      ),
    ],
  };
}

async function handlePrice(ctx) {
  const query = itemOf(ctx);
  const raw = ctx.isSlash ? ctx.getInteger('price') : Number(prefixRest(ctx)[1]);

  const item = query ? findStoreItem(ctx.guildId, query) : null;

  if (!item) {
    await ctx.reply(ephemeral(unknownItem(ctx, query ?? '')));
    return;
  }

  if (!Number.isSafeInteger(raw) || raw < 0) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Invalid price',
            `Send a whole number of coins, for example \`${ctx.isSlash ? '/store-config price item:xp-10 price:50' : `${config.prefix}store-config price xp-10 50`}\`.`,
          ),
        ],
      }),
    );
    return;
  }

  const updated = setStoreOverride(ctx.guildId, item.key, { price: raw });

  await ctx.reply(
    ephemeral({
      embeds: [
        successEmbed(
          'Price updated',
          `**${item.name}** now costs **${formatNumber(updated.price)}** coins ` +
            `(default ${formatNumber(updated.defaultPrice)}).`,
        ),
      ],
    }),
  );
}

async function handleToggle(ctx, enabled) {
  const query = itemOf(ctx);
  const item = query ? findStoreItem(ctx.guildId, query) : null;

  if (!item) {
    await ctx.reply(ephemeral(unknownItem(ctx, query ?? '')));
    return;
  }

  setStoreOverride(ctx.guildId, item.key, { enabled });

  await ctx.reply(
    ephemeral({
      embeds: [
        successEmbed(
          enabled ? 'Item is on sale' : 'Item hidden',
          enabled
            ? `**${item.name}** is back in the store.`
            : `**${item.name}** no longer appears in the store. Balances are untouched.`,
        ),
      ],
    }),
  );
}

async function handleReset(ctx) {
  const query = itemOf(ctx);
  const item = query ? findStoreItem(ctx.guildId, query) : null;

  if (!item) {
    await ctx.reply(ephemeral(unknownItem(ctx, query ?? '')));
    return;
  }

  const updated = clearStoreOverride(ctx.guildId, item.key);

  await ctx.reply(
    ephemeral({
      embeds: [
        successEmbed(
          'Item reset',
          `**${item.name}** is back to its default: ${formatNumber(updated.defaultPrice)} coins and ` +
            `${updated.enabled ? 'on sale' : 'hidden'}.`,
        ),
      ],
    }),
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
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Choose a member',
            `Use \`${ctx.isSlash ? '/store-config reset-user user:@member' : `${config.prefix}store-config reset-user @member`}\`.`,
          ),
        ],
      }),
    );
    return;
  }

  const keyToken = ctx.isSlash ? ctx.getString('item') : prefixRest(ctx)[1] ?? null;
  let key = null;

  if (keyToken) {
    const item = findStoreItem(ctx.guildId, keyToken);

    if (!item) {
      await ctx.reply(ephemeral(unknownItem(ctx, keyToken)));
      return;
    }

    key = item.key;
  }

  const cleared = voidMemberPurchases(ctx.guildId, target.id, key);
  const label = key ? `**${key}**` : 'their purchases';

  if (cleared === 0) {
    await ctx.reply(
      ephemeral({
        embeds: [
          warningEmbed('Nothing to clear', `<@${target.id}> has no fulfilled purchase for ${label}.`),
        ],
      }),
    );
    return;
  }

  await ctx.reply(
    ephemeral({
      embeds: [
        successEmbed(
          'Purchases cleared',
          `Cleared ${cleared} purchase${cleared === 1 ? '' : 's'} for <@${target.id}> ` +
            `(${label}). They can buy again. Roles and emojis already created are not deleted.`,
        ),
      ],
    }),
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('store-config')
    .setDescription('Change store prices or hide items')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub.setName('list').setDescription('Every item, its price and its sales'))
    .addSubcommand((sub) =>
      sub
        .setName('price')
        .setDescription('Set what one item costs')
        .addStringOption((option) =>
          option
            .setName('item')
            .setDescription('Item key')
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addIntegerOption((option) =>
          option
            .setName('price')
            .setDescription('Coins to charge (0 makes it free)')
            .setMinValue(0)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('enable')
        .setDescription('Put a hidden item back on sale')
        .addStringOption((option) =>
          option
            .setName('item')
            .setDescription('Item key')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('disable')
        .setDescription('Hide an item without deleting it')
        .addStringOption((option) =>
          option
            .setName('item')
            .setDescription('Item key')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reset')
        .setDescription('Return an item to its default price and visibility')
        .addStringOption((option) =>
          option
            .setName('item')
            .setDescription('Item key')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reset-user')
        .setDescription('Clear a member’s purchases so they can buy again')
        .addUserOption((option) =>
          option.setName('user').setDescription('Member').setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('item')
            .setDescription('Only this item (default: everything)')
            .setRequired(false)
            .setAutocomplete(true),
        ),
    ),

  name: 'store-config',
  aliases: ['store-admin', 'shop-config'],
  description: 'Change store prices or hide items',
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
