import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { formatListDate, zonedDate } from '../lib/dates.js';
import { embed } from '../lib/embeds.js';
import { ordinal, renderMessage, unknownPlaceholders } from '../lib/template.js';

/**
 * The six welcome layouts. A style owns its *skeleton*; only the strings in
 * `pieces` are stored in the database (`welcome_texts`), so editing text can
 * never break the alignment or the structure.
 *
 * Discord allows five text inputs in one modal, which is exactly why every
 * style exposes at most five pieces.
 */
export const STYLES = [
  {
    key: 'ledger',
    name: 'Ledger',
    summary: 'Aligned date-first rows, the same grammar as /birthday list',
    color: 0x5865f2,
    pieces: [
      { key: 'title', label: 'Title', default: '🎫 Member Pass', max: 256 },
      {
        key: 'rowLabels',
        label: 'Row labels (Account | Next)',
        default: 'account | next',
        max: 80,
      },
      { key: 'nextText', label: 'Next step', default: 'read {rules}, then say hi', max: 200 },
      { key: 'footer', label: 'Footer', default: '{server} · {count} members', max: 200 },
    ],
  },
  {
    key: 'classic',
    name: 'Classic',
    summary: 'Avatar, mention, two inline fields and an optional GIF',
    color: 0x57f287,
    pieces: [
      { key: 'title', label: 'Title', default: 'Welcome to {server}', max: 256 },
      {
        key: 'description',
        label: 'Description',
        default:
          '{user} just joined as member #{count}.\nMake yourself at home — the rules are in {rules}.',
        max: 2000,
        paragraph: true,
      },
      // Two labels in one input: the modal has room for five inputs and the GIF
      // needs the fifth. Split on "|" — a single value is used for both fields.
      { key: 'fieldLabels', label: 'Field labels (Account | Joined)', default: 'Created | Joined', max: 160 },
      { key: 'footer', label: 'Footer', default: '{server} · {count} members', max: 200 },
    ],
  },
  {
    key: 'poster',
    name: 'Poster',
    summary: 'Full-width server banner with a single headline',
    color: 0xeb459e,
    pieces: [
      { key: 'headline', label: 'Headline', default: '**{user}** has entered.', max: 500 },
      { key: 'links', label: 'Links line', default: '{rules} · {general}', max: 300 },
      { key: 'footer', label: 'Footer', default: '{server}', max: 200 },
    ],
  },
  {
    key: 'story',
    name: 'Story',
    summary: 'Narrative welcome that turns the member count into floors',
    color: 0x9b59b6,
    pieces: [
      { key: 'title', label: 'Title', default: '🏰 Floor {count}', max: 256 },
      {
        key: 'body',
        label: 'Body',
        default:
          'The gate swings open. {user} steps inside.\n\nStart in {general} — they will make room.',
        max: 2000,
        paragraph: true,
      },
      { key: 'footer', label: 'Footer', default: '{count} inside', max: 200 },
    ],
  },
  {
    key: 'whisper',
    name: 'Whisper',
    summary: 'Two quiet lines. No fields, no fuss.',
    color: 0x99aab5,
    timestamp: false,
    pieces: [
      { key: 'line1', label: 'First line', default: 'welcome, {name}.', max: 200 },
      { key: 'line2', label: 'Second line', default: "you're #{count}.", max: 200 },
    ],
  },
  {
    key: 'concierge',
    name: 'Concierge',
    summary: 'Onboarding card with link buttons to rules and chat',
    color: 0x1abc9c,
    pieces: [
      { key: 'title', label: 'Title', default: '👋 Welcome to {server}', max: 256 },
      {
        key: 'description',
        label: 'Description',
        default: '{user}, {count} of us now. A few things before you post:',
        max: 2000,
        paragraph: true,
      },
      {
        key: 'buttonLabels',
        label: 'Button labels (Rules | Say hi)',
        default: '📜 Rules | 👋 Say hi',
        max: 160,
      },
      { key: 'footer', label: 'Footer', default: '{server} · {count} members', max: 200 },
    ],
  },
];

export const WELCOME_PLACEHOLDERS = [
  { key: 'user', description: 'Mentions the new member' },
  { key: 'name', description: 'Their display name' },
  { key: 'count', description: 'Member count after they joined' },
  { key: 'ordinal', description: 'The same number as "48th"' },
  { key: 'server', description: 'Server name' },
  { key: 'joined', description: 'Join date, like "31 Oct 2026"' },
  { key: 'account_age', description: 'Account age, like "7 years ago"' },
  { key: 'rules', description: 'Rules channel, or #rules when unset' },
  { key: 'general', description: 'General channel, or #general when unset' },
];

export const STYLE_KEYS = STYLES.map((style) => style.key);

const PLACEHOLDER_KEYS = WELCOME_PLACEHOLDERS.map((placeholder) => placeholder.key);
const STYLE_BY_KEY = new Map(STYLES.map((style) => [style.key, style]));

export function getStyle(key) {
  return STYLE_BY_KEY.get(key) ?? null;
}

export function unknownWelcomePlaceholders(text) {
  return unknownPlaceholders(text, PLACEHOLDER_KEYS);
}

/** Style defaults with the guild's overrides applied on top. */
export function styleTexts(style, overrides = {}) {
  const texts = {};

  for (const piece of style.pieces) {
    const value = overrides?.[piece.key];
    texts[piece.key] = typeof value === 'string' && value.trim() ? value : piece.default;
  }

  return texts;
}

/**
 * "Created | Joined" -> ["Created", "Joined"]. A single value names both
 * labels, so the input can never leave one of them blank.
 */
export function splitPair(value, first, second) {
  const parts = String(value ?? '')
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return [first, second];
  return [parts[0], parts[1] ?? parts[0]];
}

export function splitFieldLabels(value) {
  return splitPair(value, 'Created', 'Joined');
}

/** The GIF box shown at the bottom of every style's edit modal. */
export const GIF_INPUT = {
  key: 'gifUrl',
  label: 'GIF URL (optional)',
  max: 1000,
  placeholder: 'https://media.tenor.com/....gif',
  target: 'setting',
};

/**
 * Every input the edit modal shows: the text pieces, then the GIF. Discord caps
 * a modal at five inputs, which is why each style keeps four pieces or fewer.
 */
export function modalInputs(style) {
  return [
    ...style.pieces.map((piece) => ({ ...piece, target: 'text' })),
    { ...GIF_INPUT },
  ];
}

export function enabledStyles(settings) {
  const enabled = Array.isArray(settings?.enabled)
    ? settings.enabled.filter((key) => STYLE_BY_KEY.has(key))
    : [];

  return enabled.length > 0 ? enabled : [...STYLE_KEYS];
}

/**
 * `random` skips the last style used, so two identical cards never land in a
 * row; `rotate` walks the enabled list in order; `single` pins one style.
 */
export function chooseStyle(settings, random = Math.random) {
  const enabled = enabledStyles(settings);

  if (settings?.mode === 'single' && enabled.includes(settings.forcedStyle)) {
    return settings.forcedStyle;
  }

  if (settings?.mode === 'rotate') {
    const last = enabled.indexOf(settings.lastStyle);
    return enabled[(last + 1) % enabled.length];
  }

  const pool =
    enabled.length > 1 ? enabled.filter((key) => key !== settings?.lastStyle) : enabled;
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));

  return pool[index] ?? enabled[0];
}

function buildValues({ guild, member, settings, timeZone, now }) {
  const joinedAt = member.joinedAt instanceof Date ? member.joinedAt : now;
  const zoned = zonedDate(joinedAt, timeZone);
  const count = guild.memberCount ?? 0;

  return {
    user: `<@${member.id}>`,
    name: member.displayName ?? member.user?.username ?? member.id,
    count: String(count),
    ordinal: ordinal(count),
    server: guild.name ?? 'this server',
    joined: formatListDate(zoned.year, zoned.month, zoned.day),
    account_age: `<t:${Math.floor((member.user?.createdTimestamp ?? now.getTime()) / 1000)}:R>`,
    rules: settings.rulesChannelId ? `<#${settings.rulesChannelId}>` : '#rules',
    general: settings.generalChannelId ? `<#${settings.generalChannelId}>` : '#general',
  };
}

function channelUrl(guildId, channelId) {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}

/**
 * The exact payload posted for a new member. The member's mention carries the
 * ping; `allowedMentions` lists that user only, so a card can never ping
 * @everyone or a role by accident.
 */
export function buildWelcomePayload({
  guild,
  member,
  settings = {},
  gifs = {},
  styleKey,
  overrides = {},
  timeZone = 'UTC',
  now = new Date(),
}) {
  const style = getStyle(styleKey) ?? STYLES[0];
  const values = buildValues({ guild, member, settings, timeZone, now });
  const texts = styleTexts(style, overrides);
  const gif = gifs[style.key] ?? undefined;
  const text = {};

  for (const piece of style.pieces) {
    text[piece.key] = renderMessage(texts[piece.key], values);
  }

  const embeds = [];
  const components = [];

  if (style.key === 'ledger') {
    const [accountLabel, nextLabel] = splitPair(text.rowLabels, 'account', 'next');

    embeds.push(
      embed({
        title: text.title,
        description: [
          `\`${values.joined}\` · ${values.user}`,
          `\`#${values.count}\` · ${values.server}`,
          `\`${accountLabel}\` · ${values.account_age}`,
          `\`${nextLabel}\` · ${text.nextText}`,
        ].join('\n'),
        image: gif,
        footer: text.footer,
        color: style.color,
      }),
    );
  } else if (style.key === 'classic') {
    const joinedUnix = Math.floor(
      (member.joinedAt instanceof Date ? member.joinedAt : now).getTime() / 1000,
    );
    const [createdLabel, joinedLabel] = splitFieldLabels(text.fieldLabels);

    embeds.push(
      embed({
        title: text.title,
        description: text.description,
        thumbnail: member.user?.displayAvatarURL?.({ size: 256 }),
        image: gif,
        fields: [
          { name: createdLabel, value: values.account_age, inline: true },
          { name: joinedLabel, value: `<t:${joinedUnix}:R>`, inline: true },
        ],
        footer: text.footer,
        color: style.color,
      }),
    );
  } else if (style.key === 'poster') {
    // A GIF set on this style wins over the server banner.
    const image =
      gif ??
      guild.bannerURL?.({ size: 1024 }) ??
      guild.splashURL?.({ size: 1024 }) ??
      guild.iconURL?.({ size: 1024 }) ??
      undefined;

    embeds.push(
      embed({
        description: `${text.headline}\n\n${text.links}`,
        image,
        footer: text.footer,
        color: style.color,
      }),
    );
  } else if (style.key === 'story') {
    embeds.push(
      embed({
        title: text.title,
        description: text.body,
        image: gif,
        footer: text.footer,
        color: style.color,
      }),
    );
  } else if (style.key === 'whisper') {
    embeds.push(
      embed({
        description: `${text.line1}\n${text.line2}`,
        image: gif,
        color: style.color,
        timestamp: false,
      }),
    );
  } else if (style.key === 'concierge') {
    const row = new ActionRowBuilder();
    const rulesId = settings.rulesChannelId;
    // "Say hi" falls back to the welcome channel, so the card still has a
    // button before any link is configured.
    const generalId = settings.generalChannelId ?? settings.channelId;
    const [rulesLabel, hiLabel] = splitPair(text.buttonLabels, '📜 Rules', '👋 Say hi');

    if (rulesId) {
      row.addComponents(
        new ButtonBuilder()
          .setLabel(rulesLabel.slice(0, 80))
          .setStyle(ButtonStyle.Link)
          .setURL(channelUrl(guild.id, rulesId)),
      );
    }

    if (generalId) {
      row.addComponents(
        new ButtonBuilder()
          .setLabel(hiLabel.slice(0, 80))
          .setStyle(ButtonStyle.Link)
          .setURL(channelUrl(guild.id, generalId)),
      );
    }

    if (row.components.length > 0) components.push(row);

    embeds.push(
      embed({
        title: text.title,
        description: text.description,
        image: gif,
        footer: text.footer,
        color: style.color,
      }),
    );
  }

  // Discord parses mentions in descriptions and field values, but prints them
  // literally in titles, footers and author lines. Only the parsed spots count,
  // so a mention stuck in a title still lands in `content` and really pings.
  const parsedText = embeds
    .flatMap((builder) => [
      builder.data.description ?? '',
      ...(builder.data.fields ?? []).map((field) => field.value ?? ''),
    ])
    .join('\n');
  const hasMention = parsedText.includes(values.user);

  const payload = {
    content: hasMention ? undefined : values.user,
    allowedMentions: { users: [member.id], parse: [] },
    embeds,
  };

  if (components.length > 0) payload.components = components;

  return payload;
}
