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
import { COLORS, embed, errorEmbed, successEmbed, warningEmbed } from '../../lib/embeds.js';
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
  return `${text}\n\nUse \`${ctx.isSlash ? '/store' : `${config.prefix}store`}\` to see the catalogue.`;
}

function needsText(item) {
  const needs = item.needs ?? [];
  const parts = [];

  if (needs.includes('name')) parts.push(item.type === 'title' ? 'title text' : 'a name');
  if (needs.includes('color')) parts.push('an optional colour');
  if (needs.includes('image')) parts.push('an image');

  return parts.length ? ` · needs ${parts.join(' + ')}` : '';
}

function itemLine(item, owned) {
  const bought = item.type === 'background' && owned?.has(item.backgroundId);
  const mark = bought ? '✅' : '•';
  const limit = item.limit > 0 ? ` · max ${item.limit}` : '';
  const stack = item.stackable ? ' each' : '';

  return (
    `${mark} \`${item.key}\` — **${item.name}** · ${formatNumber(item.price)} coins${stack}${limit}` +
    `${bought ? ' · owned' : ''}${needsText(item)}`
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
            'No paid designs yet. A design appears here once its entry in ' +
            '`assets/profile/backgrounds/backgrounds.json` has a `price`.',
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

  fields.unshift({ name: 'Your balance', value: `**${formatNumber(balance)}** coins`, inline: true });

  return embed({
    title: 'Store',
    description:
      'Spend coins on profile and server upgrades. Coins are earned with levels and can be ' +
      'sent to you by other members.',
    color: COLORS.primary,
    fields,
    footer: `Buy with ${ctx.isSlash ? '/store buy item:' : `${config.prefix}store buy `}<key or name>`,
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
            .setLabel('Open store')
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
  if (item?.type === 'behavior' && detail.points) return ` — +${formatNumber(detail.points)} points`;

  return '';
}

async function handleOwned(ctx, client) {
  let target = ctx.user;

  if (ctx.isSlash) {
    target = ctx.getUser('user') ?? ctx.user;
  } else if (ctx.args[1]) {
    target = await resolveUser(client, ctx.args[1], ctx.message);

    if (!target) {
      await respond(ctx, {
        embeds: [errorEmbed('Unknown member', 'Mention the member or paste their id.')],
      });
      return;
    }
  }

  if (target.id !== ctx.user.id && !ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
    await respond(ctx, {
      embeds: [
        errorEmbed('Missing permissions', 'You need **Manage Server** to view another member’s purchases.'),
      ],
    });
    return;
  }

  const purchases = memberPurchases(ctx.guildId, target.id);
  const catalog = new Map(storeCatalog(ctx.guildId).map((item) => [item.key, item]));
  const spent = purchases.reduce((total, row) => total + row.price, 0);
  const lines = purchases
    .slice(0, 20)
    .map((row) => {
      const item = catalog.get(row.item_key);
      return `• **${item?.name ?? row.item_key}** — ${formatNumber(row.price)} coins${detailLine(item, row.detail)}`;
    });

  const title = target.id === ctx.user.id ? 'Your purchases' : `<@${target.id}> · purchases`;

  await respond(ctx, {
    embeds: [
      embed({
        title,
        description:
          lines.length > 0
            ? lines.join('\n')
            : `Nothing bought yet. Use \`${ctx.isSlash ? '/store' : `${config.prefix}store`}\` to see what is for sale.`,
        color: COLORS.primary,
        footer:
          purchases.length > 0
            ? `${purchases.length} purchase${purchases.length === 1 ? '' : 's'} · ${formatNumber(spent)} coins spent`
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
      return {
        title: 'XP added',
        description:
          `**+${formatNumber(detail.xp ?? item.amount)} XP** is on your card. ` +
          'Existing punishments still tax new XP.',
      };
    case 'behavior': {
      const points = detail.points ?? item.amount;
      return {
        title: 'Good behaviour added',
        description: `**+${formatNumber(points)} good behaviour ${
          points === 1 ? 'point' : 'points'
        }** are on your card.`,
      };
    }
    case 'title':
      return {
        title: 'Title updated',
        description: `Your card now says **${detail.title}**.`,
      };
    case 'background': {
      const design = backgroundById(detail.backgroundId);
      return {
        title: 'Background unlocked',
        description:
          `**${design?.name ?? detail.backgroundId}** is yours. Equip it with ` +
          `\`${ctx.isSlash ? '/background set design:' : `${config.prefix}background set `}${design?.name ?? detail.backgroundId}\`.`,
      };
    }
    case 'role':
      return {
        title: 'Custom role created',
        description: `<@&${detail.roleId}> is yours${detail.color ? ` (${detail.color})` : ''}.`,
      };
    case 'emoji':
      return {
        title: 'Emoji added',
        description: `\`:${detail.name}:\` is now available in this server.`,
      };
    default:
      return { title: 'Purchase complete', description: item.name };
  }
}

const FAILURES = {
  unknown: (result, ctx) => ({
    title: 'Unknown item',
    description: hint(ctx, `I could not find \`${result.query}\`.`),
  }),
  disabled: (result) => ({
    title: 'Not for sale',
    description: `**${result.item.name}** is turned off in this server.`,
  }),
  unpriced: (result) => ({
    title: 'Not for sale',
    description: `**${result.item.name}** has no price yet. An admin can set one.`,
  }),
  limit: (result) => ({
    title: 'Limit reached',
    description: `You already own the maximum of **${result.limit}** for **${result.item.name}**.`,
  }),
  funds: (result) => ({
    title: 'Not enough coins',
    description:
      `**${result.item.name}**${result.quantity > 1 ? ` × ${result.quantity}` : ''} costs ` +
      `**${formatNumber(result.totalPrice ?? result.item.price)}** coins and you have ` +
      `**${formatNumber(result.balance)}**.`,
  }),
  name: (result) => ({ title: 'Need a name', description: result.message }),
  color: (result) => ({ title: 'Unknown colour', description: result.message }),
  image: (result) => ({ title: 'Need an image', description: result.message }),
  size: (result) => ({ title: 'Image too large', description: result.message }),
  slots: (result) => ({ title: 'No free emoji slots', description: result.message }),
  permission: (result) => ({ title: 'Missing permission', description: result.message }),
  guild: () => ({ title: 'Not in a server', description: 'The store only works inside a server.' }),
  database: (result) => ({
    title: 'Could not complete the purchase',
    description: `Nothing was charged. Try buying **${result.item.name}** again.`,
  }),
  delivery: (result) => ({
    title: 'Purchase refunded',
    description: result.message ?? 'The delivery failed and your coins were returned.',
  }),
};

async function handleBuy(ctx, client) {
  const key = ctx.isSlash ? ctx.getString('item') : ctx.args[1];

  if (!key) {
    await respond(ctx, {
      embeds: [
        errorEmbed(
          'Choose an item',
          hint(ctx, `Use \`${ctx.isSlash ? '/store buy item:' : `${config.prefix}store buy `}<key>\`.`),
        ),
      ],
    });
    return;
  }

  const item = findStoreItem(ctx.guildId, key);

  if (!item) {
    await respond(ctx, {
      embeds: [errorEmbed('Unknown item', hint(ctx, `I could not find \`${key}\`.`))],
    });
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
    await ctx.fail({
      embeds: [
        errorEmbed('Could not reach the store', 'The purchase was not charged. Try again in a moment.'),
      ],
    });
    return;
  }

  if (!result.ok) {
    const build = FAILURES[result.reason] ?? (() => ({
      title: 'Purchase failed',
      description: hint(ctx, 'That did not work. Try again.'),
    }));
    const text = build(result, ctx);

    await ctx.fail({ embeds: [warningEmbed(text.title, text.description)] });
    return;
  }

  const text = successText(result, ctx);

  await ctx.editReply({
    embeds: [
      successEmbed(
        text.title,
        `${text.description}\n\nBalance: **${formatNumber(result.balance)}** coins.`,
      ),
    ],
    allowedMentions: { parse: [] },
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('store')
    .setDescription('Spend coins on profile and server upgrades')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) => sub.setName('browse').setDescription('Show the catalogue and your balance'))
    .addSubcommand((sub) =>
      sub
        .setName('buy')
        .setDescription('Buy an item from the catalogue')
        .addStringOption((option) =>
          option
            .setName('item')
            .setDescription('Item key, for example xp-10 or design:tier-20')
            .setRequired(true)
            .setAutocomplete(true),
        )
        .addIntegerOption((option) =>
          option
            .setName('quantity')
            .setDescription('Stackable items only, like good behaviour points (default 1)')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(100),
        )
        .addStringOption((option) =>
          option
            .setName('name')
            .setDescription('Role or emoji name, or the title to set')
            .setRequired(false)
            .setMaxLength(64),
        )
        .addStringOption((option) =>
          option
            .setName('color')
            .setDescription('Role colour: #ff8800, red or أحمر')
            .setRequired(false)
            .setMaxLength(32),
        )
        .addAttachmentOption((option) =>
          option
            .setName('image')
            .setDescription('Emoji image: PNG, JPEG, WebP or GIF up to 256 KB')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('owned')
        .setDescription('Show what you have bought')
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('Admin: view another member (Manage Server)')
            .setRequired(false),
        ),
    ),

  name: 'store',
  aliases: ['shop'],
  description: 'Spend coins on profile and server upgrades',
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
        name: `${item.name} · ${formatNumber(item.price)} coins`.slice(0, 100),
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
