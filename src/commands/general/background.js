import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { config } from '../../config.js';
import { COLORS, embed } from '../../lib/embeds.js';
import { PAGER_PAGE_SIZE, attachPager, pagerMessage, withPager } from '../../lib/pager.js';
import { ephemeral, errorReply, infoReply, okReply } from '../../lib/replies.js';
import { resolveUser } from '../../lib/resolve.js';
import { linkedPoints } from '../../services/ebot-vex.js';
import {
  BACKGROUNDS,
  CUSTOM_ID,
  CUSTOM_LEVEL,
  WallpaperError,
  backgroundById,
  customWallpaperPath,
  deleteCustomWallpaper,
  findBackground,
  hasCustomWallpaper,
  isBackgroundUnlocked,
  nextBackground,
  pointsForLevel,
  resolveBackground,
  saveCustomWallpaper,
  syncAutoBackground,
  unlockedBackgrounds,
} from '../../services/profile-backgrounds.js';
import {
  getProfile,
  profileLevel,
  setProfileBackground,
} from '../../services/profile-store.js';
import { designItemKey, ownedBackgroundIds, storeItem } from '../../services/store.js';

const logger = createLogger('background');

const SUBCOMMANDS = new Set(['list', 'set', 'custom', 'reset']);

const SUBCOMMAND_ALIASES = {
  show: 'list',
  view: 'list',
  designs: 'list',
  themes: 'list',
  use: 'set',
  choose: 'set',
  pick: 'set',
  select: 'set',
  upload: 'custom',
  wallpaper: 'custom',
  remove: 'reset',
  clear: 'reset',
  delete: 'reset',
};

const DEFAULT_WORDS = new Set(['default', 'classic', 'original', 'none', 'off']);
const CUSTOM_WORDS = new Set(['custom', 'wallpaper', 'own', 'upload']);

/** Arabic wording for the upload failures; the service keeps its English text. */
const WALLPAPER_PROBLEMS = {
  missing: 'ارفق صورة مع الأمر، أو ارفعها في نفس الرسالة.',
  'too-large': 'الصورة كبيرة. الحد 8 ميجابايت.',
  type: 'الملف لازم يكون PNG أو JPEG أو WebP أو GIF.',
  download: 'ما قدرت أنزّل الصورة من ديسكورد. جرّب ترفعها مرة ثانية.',
  decode: 'الملف ما انقرأ كصورة. جرّب صورة ثانية.',
  dimensions: 'أبعاد الصورة ما تناسب البطاقة. جرّب صورة أكبر.',
  path: 'ما أقدر أستخدم هذي الصورة كخلفية.',
  name: 'اكتب اسم للخلفية (1–40 حرف).',
  image: 'ارفق صورة للخلفية.',
  unknown: 'هذي الخلفية ما عادت موجودة.',
};

function wallpaperProblem(error) {
  return WALLPAPER_PROBLEMS[error.code] ?? error.message;
}

/** Personal settings read better as a private slash reply; prefix stays public. */
function respond(ctx, payload) {
  return ctx.reply(ctx.isSlash ? ephemeral(payload) : payload);
}

function formatPoints(points) {
  return Number(points).toLocaleString('en-US');
}

/** Paid designs use the shop's effective price (per-server override first). */
function effectivePrice(guildId, background) {
  if (Number(background?.price) <= 0) return 0;

  return storeItem(guildId, designItemKey(background.id))?.price ?? background.price;
}

/** Prefix commands may name the subcommand, or start straight with a design. */
function subcommandOf(ctx) {
  if (ctx.isSlash) return ctx.getSubcommand() ?? 'list';

  const raw = String(ctx.args[0] ?? '').toLowerCase();
  if (!raw) return 'list';

  const mapped = SUBCOMMAND_ALIASES[raw] ?? raw;
  return SUBCOMMANDS.has(mapped) ? mapped : 'set';
}

function prefixRest(ctx) {
  const raw = String(ctx.args[0] ?? '').toLowerCase();
  const mapped = SUBCOMMAND_ALIASES[raw] ?? raw;
  return SUBCOMMANDS.has(mapped) ? ctx.args.slice(1) : ctx.args;
}

async function levelOf(ctx, client, userId) {
  // Linked-bot points count toward the level exactly as they do on the card.
  const linked = await linkedPoints(client, ctx.guildId);
  return profileLevel(ctx.guildId, userId, linked);
}

function attachmentOf(ctx) {
  return (
    ctx.getAttachment('image') ??
    ctx.message?.attachments?.first?.() ??
    null
  );
}

/** Server managers can upload custom wallpapers at any level, for any member. */
function canManageGuild(ctx) {
  return Boolean(ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild));
}

function selectionState(ctx, stored, level, hasCustom, owned) {
  const selected = resolveBackground({
    selected: stored.background,
    level,
    hasCustom,
    customPath: hasCustom ? customWallpaperPath(ctx.guildId, ctx.user.id) : null,
    owned,
  });

  const requestedTier = backgroundById(stored.background);
  const lockedTier =
    requestedTier && !isBackgroundUnlocked(requestedTier, level, owned) ? requestedTier : null;
  const customMissing = stored.background === CUSTOM_ID && !hasCustom;

  return { selected, lockedTier, customMissing };
}

function designLabel(background) {
  return background?.name ?? background?.id ?? '';
}

function listEmbed(ctx, level, stored, hasCustom, owned, manager = false, page = 1) {
  const { selected, lockedTier, customMissing } = selectionState(ctx, stored, level, hasCustom, owned);
  const unlocked = new Set(unlockedBackgrounds(level, owned).map((background) => background.id));
  const free = BACKGROUNDS.filter((background) => Number(background.price) <= 0);
  const paid = BACKGROUNDS.filter((background) => Number(background.price) > 0);
  const paidOwned = paid.filter((background) => unlocked.has(background.id));

  const lines = free.map((background) => {
    const current =
      stored.background === background.id || (!stored.background && background.id === 'default');
    const mark = current ? '➡️' : unlocked.has(background.id) ? '✅' : '🔒';
    const levelText =
      background.id === 'default' ? 'دائمًا' : `المستوى ${background.level}`;
    const lock =
      unlocked.has(background.id) || background.id === 'default'
        ? ''
        : ` · ${formatPoints(pointsForLevel(background.level))} نقطة`;

    return `${mark} **${designLabel(background)}** — ${levelText}${lock}`;
  });

  const ownedNames = paidOwned.slice(0, 6).map((background) => background.name).join('، ');
  const paidLine =
    `${paidOwned.length} من ${paid.length} مملوكة` +
    (ownedNames ? ` · ${ownedNames}${paidOwned.length > 6 ? '…' : ''}` : '') +
    `\nتصفّحها وتشتريها من \`${ctx.isSlash ? '/store' : `${config.prefix}store`}\` ← **الخلفيات**.`;

  const customMark =
    stored.background === CUSTOM_ID ? '➡️' : hasCustom || level >= CUSTOM_LEVEL || manager ? '✅' : '🔒';
  const customText = hasCustom
    ? 'مضبوطة — ارفق صورة جديدة عشان تبدّلها'
    : level >= CUSTOM_LEVEL || manager
      ? `مفتوحة — ارفعها بـ \`${ctx.isSlash ? '/background custom' : ':-background custom'}\``
      : `المستوى ${CUSTOM_LEVEL} · ${formatPoints(pointsForLevel(CUSTOM_LEVEL))} نقطة`;

  lines.push(`${customMark} **خلفية خاصة** — ${customText}`);

  const shown = selected.id === CUSTOM_ID ? 'خلفية خاصة' : designLabel(selected);
  const selectedNote = lockedTier
    ? `\nاختيارك المحفوظ **${designLabel(lockedTier)}** مقفول عند المستوى ${level}، فالبطاقة الكلاسيكية تظهر لين ترفع مستواك.`
    : customMissing
      ? '\nملف خلفيتك الخاصة مو موجود، فالبطاقة الكلاسيكية تظهر.'
      : '';

  const next = nextBackground(level);
  const pages = Math.max(1, Math.ceil(lines.length / PAGER_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const start = (safePage - 1) * PAGER_PAGE_SIZE;
  const ladder = lines.slice(start, start + PAGER_PAGE_SIZE).join('\n');

  const card = embed({
    title: 'خلفيات الملف',
    description:
      `أنت في **المستوى ${level}**. أحدث تصميم مجاني يتفعّل تلقائيًا، وتقدر تختار أي تصميم مفتوح. البطاقة الكلاسيكية متاحة دائمًا.` +
      (manager
        ? '\nعندك **إدارة السيرفر**، فرفع الخلفيات الخاصة مفتوح في أي مستوى، لك أو لأي عضو.'
        : '') +
      selectedNote,
    color: COLORS.primary,
    fields: [
      { name: 'المختار', value: `**${shown}**`, inline: true },
      {
        name: 'التصاميم',
        value: `${unlocked.size} من ${BACKGROUNDS.length} مفتوحة`,
        inline: true,
      },
      {
        name: 'التصميم التالي',
        value: next
          ? `**${next.name}** عند المستوى ${next.level} · ${formatPoints(pointsForLevel(next.level))} نقطة`
          : level >= CUSTOM_LEVEL
            ? 'كل شي مفتوح.'
            : `**خلفية خاصة** عند المستوى ${CUSTOM_LEVEL} · ${formatPoints(pointsForLevel(CUSTOM_LEVEL))} نقطة`,
        inline: false,
      },
      { name: 'تصاميم المتجر', value: paidLine, inline: false },
      { name: 'السلّم', value: ladder, inline: false },
    ],
    footer: [
      pages > 1 ? `صفحة ${safePage} / ${pages}` : null,
      `اختر بـ ${ctx.isSlash ? '/background set design:' : ':-background set '}<الاسم أو المستوى>`,
    ]
      .filter(Boolean)
      .join(' · '),
  });

  return { embed: card, pages, page: safePage };
}

async function handleList(ctx, client) {
  const level = await levelOf(ctx, client, ctx.user.id);
  const hasCustom = hasCustomWallpaper(ctx.guildId, ctx.user.id);
  const stored = getProfile(ctx.guildId, ctx.user.id);
  const owned = ownedBackgroundIds(ctx.guildId, ctx.user.id);
  const manager = canManageGuild(ctx);

  // Apply the newest free design before showing the ladder, so a member who
  // just crossed a level sees the same pick their card will use.
  stored.background = syncAutoBackground(ctx.guildId, ctx.user.id, level, { hasCustom });

  const first = listEmbed(ctx, level, stored, hasCustom, owned, manager, 1);
  const render = (page) => ({
    embeds: [listEmbed(ctx, level, stored, hasCustom, owned, manager, page).embed],
  });

  const sent = await respond(
    ctx,
    withPager({ id: 'background', page: 1, pages: first.pages, payload: render(1) }),
  );

  await attachPager({
    ctx,
    message: await pagerMessage(ctx, sent),
    id: 'background',
    pages: first.pages,
    render,
  });
}

async function handleSet(ctx, client, query) {
  const raw = String(query ?? '').trim();
  const level = await levelOf(ctx, client, ctx.user.id);
  const owned = ownedBackgroundIds(ctx.guildId, ctx.user.id);

  if (!raw) {
    await respond(
      ctx,
      errorReply(
        'اختر تصميم',
        `استخدم \`${ctx.isSlash ? '/background set design:' : ':-background set '}<الاسم أو المستوى>\`، مثل \`15\` أو \`المد\` أو \`default\` أو \`custom\`.`,
      ),
    );
    return;
  }

  const word = raw.toLowerCase();

  if (DEFAULT_WORDS.has(word)) {
    // Store `default` rather than clearing the column: an explicit Classic
    // choice must not be overwritten by the next automatic unlock.
    setProfileBackground(ctx.guildId, ctx.user.id, 'default');
    await respond(ctx, okReply('تغيّرت الخلفية', 'رجعت بطاقتك إلى **الكلاسيكية**.'));
    return;
  }

  if (CUSTOM_WORDS.has(word)) {
    if (!hasCustomWallpaper(ctx.guildId, ctx.user.id)) {
      await respond(
        ctx,
        errorReply(
          'ما عندك خلفية خاصة بعد',
          `ارفعها أول بـ \`${ctx.isSlash ? '/background custom image:<file>' : ':-background custom'}\` (المستوى ${CUSTOM_LEVEL} أو أعلى، أو إدارة السيرفر).`,
        ),
      );
      return;
    }

    setProfileBackground(ctx.guildId, ctx.user.id, CUSTOM_ID);
    await respond(ctx, okReply('تغيّرت الخلفية', 'خلفيتك الخاصة الحين على بطاقتك.'));
    return;
  }

  const background = findBackground(raw);

  if (!background) {
    await respond(
      ctx,
      errorReply(
        'تصميم غير معروف',
        `شغّل \`${ctx.isSlash ? '/background' : ':-background'}\` عشان تشوف السلّم. تقدر تكتب الاسم أو المستوى.`,
      ),
    );
    return;
  }

  if (!isBackgroundUnlocked(background, level, owned)) {
    if (background.price > 0) {
      const cost = effectivePrice(ctx.guildId, background);
      await respond(
        ctx,
        errorReply(
          'ما انفتح بعد',
          `**${background.name}** تصميم من المتجر وسعره **${formatPoints(cost)}** عملة. ` +
            `اشتره بـ \`${ctx.isSlash ? '/store buy item:' : `${config.prefix}store buy `}design:${background.id}\`.`,
        ),
      );
      return;
    }

    await respond(
      ctx,
      errorReply(
        'لسا مقفول',
        `**${background.name}** ينفتح عند المستوى **${background.level}** ` +
          `(${formatPoints(pointsForLevel(background.level))} نقطة). أنت في المستوى ${level}.`,
      ),
    );
    return;
  }

  setProfileBackground(ctx.guildId, ctx.user.id, background.id);
  await respond(
    ctx,
    okReply(
      'تغيّرت الخلفية',
      `**${background.name}** الحين على بطاقتك. شغّل \`${ctx.isSlash ? '/profile' : ':-profile'}\` عشان تشوفها.`,
    ),
  );
}

/**
 * The member a subcommand acts on: the `user` option on slash, the first
 * argument on prefix, otherwise the author.
 */
async function targetOf(ctx, client) {
  if (ctx.isSlash) return { target: ctx.getUser('user') ?? ctx.user, unknown: false };

  const token = prefixRest(ctx)[0];
  if (!token) return { target: ctx.user, unknown: false };

  const target = await resolveUser(client, token, ctx.message);
  return { target: target ?? null, unknown: !target };
}

function lockedCustomMessage(level, self) {
  return (
    `الخلفيات الخاصة تنفتح عند المستوى **${CUSTOM_LEVEL}** ` +
    `(${formatPoints(pointsForLevel(CUSTOM_LEVEL))} نقطة). ` +
    (self ? `أنت في المستوى ${level}.` : `هذا العضو في المستوى ${level}.`) +
    ' وأصحاب **إدارة السيرفر** يرفعونها في أي مستوى.'
  );
}

async function handleCustom(ctx, client, attachment) {
  const { target, unknown } = await targetOf(ctx, client);

  if (unknown) {
    await respond(ctx, errorReply('عضو غير معروف', 'منشن العضو أو الصق الآيدي.'));
    return;
  }

  const self = target.id === ctx.user.id;
  const manager = canManageGuild(ctx);

  if (!self && !manager) {
    await respond(
      ctx,
      errorReply(
        'ما مسموح',
        'أصحاب **إدارة السيرفر** فقط يقدرون يغيّرون خلفية عضو ثاني.',
      ),
    );
    return;
  }

  const level = await levelOf(ctx, client, target.id);
  const hasCustom = hasCustomWallpaper(ctx.guildId, target.id);
  // Manage Server bypasses the level gate, for the author and for the member
  // they are setting it for.
  const unlocked = manager || level >= CUSTOM_LEVEL || hasCustom;

  if (!attachment) {
    const hint = hasCustom
      ? `ارفق صورة جديدة عشان تبدّل ${self ? 'خلفيتك' : 'خلفيته'}. تنقص تلقائيًا على مقاس البطاقة، والـ GIF يظل متحرك.`
      : `ارفق صورة PNG أو JPEG أو WebP أو GIF${self ? '' : ` لـ <@${target.id}>`}. تنقص تلقائيًا على مقاس البطاقة، والـ GIF يظل متحرك.`;

    await respond(
      ctx,
      unlocked
        ? infoReply('خلفية خاصة', hint)
        : errorReply('لسا مقفول', lockedCustomMessage(level, self)),
    );
    return;
  }

  if (!unlocked) {
    await respond(ctx, errorReply('لسا مقفول', lockedCustomMessage(level, self)));
    return;
  }

  // Downloading, decoding and re-encoding can pass Discord's three-second
  // acknowledgement window. The result is a personal setting, so keep the
  // slash reply private.
  if (ctx.isSlash) await ctx.defer({ ephemeral: true });

  try {
    const saved = await saveCustomWallpaper(ctx.guildId, target.id, attachment);
    setProfileBackground(ctx.guildId, target.id, CUSTOM_ID);

    const payload = okReply(
      'ضبطت الخلفية الخاصة',
      `محفوظة بمقاس ${saved.sourceWidth}x${saved.sourceHeight} ومقصوصة على البطاقة. ` +
        (saved.animated
          ? `متحركة (${saved.frames} إطار). `
          : saved.wasGif
            ? 'الـ GIF ما انحرك (كبير أو طويل)، فانحفظ أول إطار. '
            : '') +
        (self
          ? `شغّل \`${ctx.isSlash ? '/profile' : ':-profile'}\` عشان تشوفها.`
          : `الحين هي على ملف <@${target.id}>.`),
    );

    if (ctx.isSlash) await ctx.editReply(payload);
    else await ctx.reply(payload);
  } catch (error) {
    if (error instanceof WallpaperError) {
      await ctx.fail(errorReply('ما قدرت أستخدم هذي الصورة', wallpaperProblem(error)));
      return;
    }

    logger.error(`Could not save the wallpaper for ${target.id}`, error);
    await ctx.fail(
      errorReply('ما قدرت أحفظ الخلفية', 'الصورة ما انحفظت. جرّب بعد لحظة.'),
    );
  }
}

async function handleReset(ctx, client) {
  const { target } = await targetOf(ctx, client);

  if (!target) {
    await respond(ctx, errorReply('عضو غير معروف', 'منشن العضو أو الصق الآيدي.'));
    return;
  }

  if (target.id !== ctx.user.id && !canManageGuild(ctx)) {
    await respond(
      ctx,
      errorReply('ما مسموح', 'أصحاب **إدارة السيرفر** فقط يقدرون يصفّرون خلفية عضو ثاني.'),
    );
    return;
  }

  // `default` is explicit, not null: auto-equip must not undo a reset.
  setProfileBackground(ctx.guildId, target.id, 'default');
  await deleteCustomWallpaper(ctx.guildId, target.id);

  await respond(
    ctx,
    okReply(
      'انصفّرت الخلفية',
      target.id === ctx.user.id
        ? 'رجعت بطاقتك إلى **الكلاسيكية** وانحذفت خلفيتك الخاصة.'
        : `رجعت بطاقة <@${target.id}> إلى **الكلاسيكية** وانحذفت خلفيته الخاصة.`,
    ),
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('background')
    .setDescription('اختر أو ارفع خلفية بطاقة ملفك')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('اعرض كل التصاميم ومستواك والفتح القادم'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('استخدم تصميم مفتوح عندك')
        .addStringOption((option) =>
          option
            .setName('design')
            .setDescription('الاسم أو المستوى: 15، المد، default، custom')
            .setRequired(true)
            .setMaxLength(40),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('custom')
        .setDescription(`ارفع خلفية (المستوى ${CUSTOM_LEVEL} أو أعلى، أو إدارة السيرفر لأي عضو)`)
        .addAttachmentOption((option) =>
          option
            .setName('image')
            .setDescription('PNG أو JPEG أو WebP أو GIF. تنقص على البطاقة، والـ GIF يتحرك.')
            .setRequired(false),
        )
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('إدارة السيرفر: اضبطها لهذا العضو بدل نفسك')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reset')
        .setDescription('ارجع للبطاقة الكلاسيكية واحذف الخلفية الخاصة')
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('مشرف: صفّر خلفية عضو ثاني (إدارة السيرفر)')
            .setRequired(false),
        ),
    ),

  name: 'background',
  aliases: ['bg', 'theme', 'wallpaper'],
  description: 'اختر أو ارفع خلفية بطاقة ملفك',
  category: 'General',
  usage: 'background [list | set <design> | custom [user] | reset [user]]',
  cooldown: 4,
  guildOnly: true,

  async execute(ctx, client) {
    const subcommand = subcommandOf(ctx);

    switch (subcommand) {
      case 'set': {
        const query = ctx.isSlash ? ctx.getString('design') : prefixRest(ctx).join(' ');
        return handleSet(ctx, client, query);
      }
      case 'custom':
        return handleCustom(ctx, client, attachmentOf(ctx));
      case 'reset':
        return handleReset(ctx, client);
      default:
        return handleList(ctx, client);
    }
  },
};
