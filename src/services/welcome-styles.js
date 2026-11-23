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
    name: 'سجل',
    summary: 'صفوف مرتّبة تبدأ بالتاريخ، بنفس صيغة /birthday list',
    color: 0x5865f2,
    pieces: [
      { key: 'title', label: 'العنوان', default: '🎫 بطاقة عضو', max: 256 },
      {
        key: 'rowLabels',
        label: 'عناوين الصفوف (الحساب | التالي)',
        default: 'الحساب | التالي',
        max: 80,
      },
      { key: 'nextText', label: 'الخطوة التالية', default: 'اقرأ {rules}، وبعدها سلّم', max: 200 },
      { key: 'footer', label: 'التذييل', default: '{server} · {count} عضو', max: 200 },
    ],
  },
  {
    key: 'classic',
    name: 'كلاسيكي',
    summary: 'الصورة والمنشن وخانتين وجيف اختياري',
    color: 0x57f287,
    pieces: [
      { key: 'title', label: 'العنوان', default: 'أهلًا بك في {server}', max: 256 },
      {
        key: 'description',
        label: 'الوصف',
        default:
          '{user} انضم للتو كعضو رقم #{count}.\nاعتبر نفسك في بيتك — القوانين في {rules}.',
        max: 2000,
        paragraph: true,
      },
      // Two labels in one input: the modal has room for five inputs and the GIF
      // needs the fifth. Split on "|" — a single value is used for both fields.
      { key: 'fieldLabels', label: 'عناوين الخانتين (الحساب | الانضمام)', default: 'أُنشئ | انضم', max: 160 },
      { key: 'footer', label: 'التذييل', default: '{server} · {count} عضو', max: 200 },
    ],
  },
  {
    key: 'poster',
    name: 'ملصق',
    summary: 'بانر السيرفر بعرض كامل مع عنوان واحد',
    color: 0xeb459e,
    pieces: [
      { key: 'headline', label: 'العنوان الرئيسي', default: '**{user}** وصل.', max: 500 },
      { key: 'links', label: 'سطر الروابط', default: '{rules} · {general}', max: 300 },
      { key: 'footer', label: 'التذييل', default: '{server}', max: 200 },
    ],
  },
  {
    key: 'story',
    name: 'قصة',
    summary: 'ترحيب سردي يحوّل عدد الأعضاء إلى طوابق',
    color: 0x9b59b6,
    pieces: [
      { key: 'title', label: 'العنوان', default: '🏰 الطابق {count}', max: 256 },
      {
        key: 'body',
        label: 'النص',
        default:
          'البوابة تنفتح. {user} يدخل.\n\nابدأ في {general} — بيفتحون لك مكان.',
        max: 2000,
        paragraph: true,
      },
      { key: 'footer', label: 'التذييل', default: '{count} داخل', max: 200 },
    ],
  },
  {
    key: 'whisper',
    name: 'همسة',
    summary: 'سطرين هادئين. بدون خانات ولا زحمة.',
    color: 0x99aab5,
    timestamp: false,
    pieces: [
      { key: 'line1', label: 'السطر الأول', default: 'أهلًا، {name}.', max: 200 },
      { key: 'line2', label: 'السطر الثاني', default: 'أنت رقم #{count}.', max: 200 },
    ],
  },
  {
    key: 'concierge',
    name: 'استقبال',
    summary: 'بطاقة تعريف بأزرار روابط للقوانين والدردشة',
    color: 0x1abc9c,
    pieces: [
      { key: 'title', label: 'العنوان', default: '👋 أهلًا بك في {server}', max: 256 },
      {
        key: 'description',
        label: 'الوصف',
        default: '{user}، صرنا {count}. كم شي قبل ما تنشر:',
        max: 2000,
        paragraph: true,
      },
      {
        key: 'buttonLabels',
        label: 'عناوين الأزرار (القوانين | سلّم)',
        default: '📜 القوانين | 👋 سلّم',
        max: 160,
      },
      { key: 'footer', label: 'التذييل', default: '{server} · {count} عضو', max: 200 },
    ],
  },
];

export const WELCOME_PLACEHOLDERS = [
  { key: 'user', description: 'منشن العضو الجديد' },
  { key: 'name', description: 'اسمه الظاهر' },
  { key: 'count', description: 'عدد الأعضاء بعد انضمامه' },
  { key: 'ordinal', description: 'الرقم نفسه بصيغة "48" الترتيبية' },
  { key: 'server', description: 'اسم السيرفر' },
  { key: 'joined', description: 'تاريخ الانضمام، مثل "31 أكتوبر 2026"' },
  { key: 'account_age', description: 'عمر الحساب، مثل "قبل 7 سنوات"' },
  { key: 'rules', description: 'قناة القوانين، أو #rules إذا ما انضبطت' },
  { key: 'general', description: 'القناة العامة، أو #general إذا ما انضبطت' },
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
 * "الحساب | التالي" -> ["الحساب", "التالي"]. A single value names both
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
  return splitPair(value, 'أُنشئ', 'انضم');
}

/** The GIF box shown at the bottom of every style's edit modal. */
export const GIF_INPUT = {
  key: 'gifUrl',
  label: 'رابط GIF (اختياري)',
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
    server: guild.name ?? 'هذا السيرفر',
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
    const [accountLabel, nextLabel] = splitPair(text.rowLabels, 'الحساب', 'التالي');

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
    const [rulesLabel, hiLabel] = splitPair(text.buttonLabels, '📜 القوانين', '👋 سلّم');

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
