import {
  DiscordAPIError,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { colorListEmbed } from '../../lib/color-palette.js';
import { errorReply, infoReply, okReply } from '../../lib/replies.js';
import { createLogger } from '../../lib/logger.js';
import { normalizeForMatch } from '../../lib/text.js';

const logger = createLogger('color');

// Names are convenient on a phone, where typing "#ff0000" is awkward. Values
// are the usual CSS colours, with a couple of Discord-specific extras.
const NAMED_COLORS = {
  red: 0xff0000,
  crimson: 0xdc143c,
  orange: 0xffa500,
  amber: 0xffbf00,
  gold: 0xffd700,
  yellow: 0xffff00,
  lime: 0x00ff00,
  green: 0x008000,
  emerald: 0x50c878,
  mint: 0x98ff98,
  teal: 0x008080,
  cyan: 0x00ffff,
  aqua: 0x00ffff,
  sky: 0x87ceeb,
  blue: 0x0000ff,
  navy: 0x000080,
  indigo: 0x4b0082,
  purple: 0x800080,
  violet: 0xee82ee,
  magenta: 0xff00ff,
  fuchsia: 0xff00ff,
  pink: 0xffc0cb,
  rose: 0xff007f,
  brown: 0xa52a2a,
  maroon: 0x800000,
  olive: 0x808000,
  white: 0xffffff,
  silver: 0xc0c0c0,
  gray: 0x808080,
  grey: 0x808080,
  black: 0x000000,
  blurple: 0x5865f2,
  discord: 0x5865f2,
};

const USAGE = {
  slash: [
    '/color primary:#ff0000 secondary:#00ff00',
    '/color primary:أحمر secondary:أخضر',
    '/color primary:#ff0000',
    '/color secondary:#00ff00',
    '/color list',
    '/color clear:true',
  ],
  prefix: [
    ':-color #ff0000 #00ff00',
    ':-color أحمر أخضر',
    ':-color #ff0000',
    ':-color - #00ff00',
    ':-color list',
    ':-color clear',
  ],
};

// Arabic colour names, stored in the normalized form `normalizeForMatch` produces
// (أ→ا, ة→ه, diacritics and tatweel removed), so "أَحْمَر", "احمر" and "أحمر"
// all match. Keys are what the user actually meant, values are RGB.
const ARABIC_COLORS = {
  احمر: 0xff0000,
  حمراء: 0xff0000,
  قرمزي: 0xdc143c,
  برتقالي: 0xffa500,
  عنبري: 0xffbf00,
  كهرماني: 0xffbf00,
  ذهبي: 0xffd700,
  اصفر: 0xffff00,
  صفراء: 0xffff00,
  ليموني: 0x00ff00,
  اخضر: 0x008000,
  خضراء: 0x008000,
  زمردي: 0x50c878,
  نعناعي: 0x98ff98,
  تركوازي: 0x008080,
  فيروزي: 0x008080,
  سماوي: 0x87ceeb,
  ازرق: 0x0000ff,
  زرقاء: 0x0000ff,
  كحلي: 0x000080,
  نيلي: 0x4b0082,
  بنفسجي: 0x800080,
  ارجواني: 0x800080,
  فوشيا: 0xff00ff,
  وردي: 0xffc0cb,
  زهري: 0xff007f,
  بني: 0xa52a2a,
  عنابي: 0x800000,
  خمري: 0x800000,
  زيتوني: 0x808000,
  ابيض: 0xffffff,
  بيضاء: 0xffffff,
  فضي: 0xc0c0c0,
  رمادي: 0x808080,
  اسود: 0x000000,
  سوداء: 0x000000,
  ديسكورد: 0x5865f2,
  بليربل: 0x5865f2,
};

// Arabic-Indic (٠-٩) and Persian (۰-۹) digits, so "#FF٠٠٠٠" works too.
const NON_LATIN_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/g;

function normalizeDigits(value) {
  return value.replace(NON_LATIN_DIGITS, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code <= 0x0669 ? code - 0x0660 : code - 0x06f0);
  });
}

// Words that ask for the default (no) color instead of a value. Both fields
// accept them so `/color primary:clear` works without remembering the option.
const CLEAR_WORDS = new Set([
  'clear',
  'reset',
  'none',
  'default',
  'مسح',
  'افتراضي',
  'الغاء',
  'ازاله',
]);

// Prefix has no optional options, so "-" means "keep this color as it is".
const KEEP_WORDS = new Set(['-', '_', 'keep', 'same', 'ابق']);

const FOOTER = 'تقدر تغيّر أعلى رتبة شخصية عندك فقط.';


// `:-color list` / `primary:list` / bare `/color`.
const LIST_WORDS = new Set([
  'list',
  'colors',
  'palette',
  'الوان',
  'الالوان',
  'قائمه',
  'القائمه',
]);

function toColor(value) {
  return {
    value,
    hex: `#${value.toString(16).padStart(6, '0').toUpperCase()}`,
  };
}

// Discord reserves 0 for "no color", so a literal #000000 would silently clear
// the role instead of coloring it. #000001 is the closest visible black.
function representable(value) {
  return value === 0 ? 1 : value;
}

/**
 * Accepts #rgb, #rrggbb, 0xrrggbb, bare hex, and the names above.
 * Returns `{ value, hex }` or null. Kept pure so it can be tested without
 * a Discord client.
 */
export function parseColor(input) {
  if (typeof input !== 'string') return null;

  const raw = normalizeDigits(input).trim().toLowerCase();
  if (!raw) return null;

  const key = normalizeForMatch(raw);
  const named =
    NAMED_COLORS[key] ?? ARABIC_COLORS[key] ?? ARABIC_COLORS[key.replace(/^ال/, '')];
  if (Number.isInteger(named)) return toColor(representable(named));

  let hex = raw.replace(/^#+/, '');
  if (hex.startsWith('0x')) hex = hex.slice(2);

  if (/^[\da-f]{3}$/.test(hex)) {
    hex = [...hex].map((part) => part + part).join('');
  }

  if (!/^[\da-f]{6}$/.test(hex)) return null;

  return toColor(representable(Number.parseInt(hex, 16)));
}

/**
 * Every role the member alone holds, highest first. Integration roles are
 * skipped: they belong to the app that created them and cannot be edited.
 * `counts` comes from Discord's role member-count endpoint and makes the check
 * exact even when the member cache is cold.
 */
export function findPersonalRoles(member, counts = null) {
  return [...member.roles.cache.values()]
    .filter((role) => role.id !== member.guild.id && !role.managed)
    .sort((a, b) => b.position - a.position)
    .filter((role) => {
      const count = counts?.get?.(role.id);

      if (count !== undefined) return count === 1;

      return role.members.size === 1 && role.members.has(member.id);
    });
}

/**
 * The highest role the member has that nobody else has.
 */
export function findPersonalRole(member, counts = null) {
  return findPersonalRoles(member, counts)[0] ?? null;
}

/**
 * The highest personal role whose position is below `botTop`, so the bot is
 * allowed to edit it. A member can hold several personal roles and only their
 * top one may sit above the bot.
 */
export function findEditablePersonalRole(member, counts = null, botTop = Infinity) {
  return findPersonalRoles(member, counts).find((role) => role.position < botTop) ?? null;
}

/**
 * Resolves the role a member is allowed to recolour, or explains why none can
 * be used. The highest personal role is preferred, but if it sits above the
 * bot the next one it can edit is used instead; refusing outright would leave
 * members with an admin-ish role unable to change any colour at all.
 */
export async function pickColorRole(guild, member) {
  if (!member) {
    return { problem: 'ما قدرت أقرأ ملفك في السيرفر. جرّب بعد لحظة.' };
  }

  const me = guild.members?.me;

  if (!me) {
    return { problem: 'ما قدرت أقرأ ملفي في السيرفر. جرّب بعد لحظة.' };
  }

  const canManage =
    me.permissions?.has(PermissionFlagsBits.ManageRoles) ||
    me.permissions?.has(PermissionFlagsBits.Administrator);

  if (!canManage) {
    return { problem: 'أحتاج صلاحية **إدارة الرتب** عشان أغيّر ألوان الرتب.' };
  }

  let counts = null;

  try {
    counts = (await guild.roles?.fetchMemberCounts?.()) ?? null;
  } catch {
    // Older guilds or a transient API failure: fall back to the member cache.
  }

  if (!counts && (guild.members?.cache?.size ?? 0) < (guild.memberCount ?? 0)) {
    try {
      await guild.members?.fetch?.();
    } catch {
      // Still usable if the cache already covers every role in question.
    }
  }

  const role = findEditablePersonalRole(member, counts, me.roles?.highest?.position ?? 0);

  if (!role) {
    const personal = findPersonalRoles(member, counts);

    if (personal.length === 0) {
      return {
        problem:
          'ما عندك **رتبة شخصية** تقدر أعدّلها — كل رتبك إما مشتركة مع غيرك أو مرتبطة بتكامل.\n' +
          'اطلب من مشرف يعطيك رتبة ما يملكها غيرك، وبعدها شغّل الأمر مرة ثانية.',
      };
    }

    return {
      role: personal[0],
      blocked: personal[0],
      problem:
        `**${personal[0].name}** في نفس مستوى أعلى رتبة عندي أو فوقها، فما أقدر أغيّر ألوانها.\n` +
        'اطلب من مشرف يرفع رتبتي فوقها من **إعدادات السيرفر ← الرتب**، وبعدها جرّب.',
    };
  }

  // If a higher personal role exists but is out of reach, say which one was
  // skipped so the member knows why a different role changed.
  const blocked = findPersonalRoles(member, counts).find((candidate) => candidate.id !== role.id) ?? null;

  return { role, blocked };
}

function privatePayload(payload) {
  return {
    ...payload,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  };
}

async function respond(ctx, payload) {
  const body = { ...payload, allowedMentions: { parse: [] } };

  if (ctx.isSlash) return ctx.editReply(body);
  return ctx.reply(body);
}

// Errors release the cooldown: a bad hex code or a blocked role should not
// stop the user from trying again straight away.
function fail(ctx, title, description) {
  return ctx.fail(privatePayload(errorReply(title, description)));
}

function usageLines(ctx) {
  const examples = ctx.isSlash ? USAGE.slash : USAGE.prefix;

  return ['**الاستخدام:**', ...examples.map((line) => `\`${line}\``)].join('\n');
}

function isClearInput(value) {
  return typeof value === 'string' && CLEAR_WORDS.has(normalizeForMatch(value));
}

function isKeepInput(value) {
  return typeof value === 'string' && KEEP_WORDS.has(normalizeForMatch(value));
}

function isListInput(value) {
  return typeof value === 'string' && LIST_WORDS.has(normalizeForMatch(value));
}

async function showColorList(ctx) {
  ctx.releaseCooldown();
  return ctx.reply(privatePayload({ embeds: [colorListEmbed()] }));
}

function colorSummary(primaryHex, secondaryHex) {
  return secondaryHex
    ? `\`${primaryHex}\` ← \`${secondaryHex}\``
    : `\`${primaryHex}\` (لون واحد)`;
}

function skippedNote(blocked, role) {
  return `${blocked} فوق أعلى رتبة عندي، فما قدرت أعدّلها — استخدمت ${role} بدالها.`;
}

function reasonFor(ctx) {
  return `أمر اللون: ${ctx.user.tag ?? ctx.user.username}`.slice(0, 500);
}

function hexOf(value) {
  return toColor(Number(value ?? 0)).hex;
}

function apiProblem(error) {
  if (error instanceof DiscordAPIError) {
    if (error.code === 50013) {
      return 'ديسكورد يقول ما عندي صلاحية أعدّل هذي الرتبة. ارفع رتبتي فوقها وتأكد أن عندي **إدارة الرتب**.';
    }

    if (error.code === 50035) {
      return 'ديسكورد رفض هذي الألوان. ألوان التدرّج تحتاج سيرفر معزّز، والقيمتين لازم تكونان صحيحتين.';
    }

    if (error.code === 429 || /rate limit/i.test(error.message)) {
      return 'ديسكورد يحدّد سرعة تغيير الرتب الحين. انتظر دقيقة وجرّب.';
    }

    return `ديسكورد قال: ${String(error.message).slice(0, 300)}`;
  }

  return error?.message
    ? `صار خطأ: ${String(error.message).slice(0, 300)}`
    : 'صار خطأ وأنا أغيّر ألوان الرتبة.';
}

/**
 * Resets the role to the default color. Discord treats primary color 0 as "no
 * color", and nulls clear the gradient and holographic third color.
 */
async function clearColors(ctx, role, blocked, current) {
  const already = !current.primaryColor && !current.secondaryColor && !current.tertiaryColor;

  if (already) {
    // Nothing changed, so do not hold the cooldown against the user.
    ctx.releaseCooldown();

    await respond(
      ctx,
      infoReply(
        'اللون فاضي أصلًا',
        `${role} يستخدم اللون الافتراضي من قبل — ما فيه شي ينمسح.`,
      ),
    );
    return;
  }

  try {
    await role.setColors(
      { primaryColor: 0, secondaryColor: null, tertiaryColor: null },
      reasonFor(ctx),
    );

    logger.info(
      `${ctx.user.tag ?? ctx.user.username} (${ctx.user.id}) cleared ${role.name} (${role.id})`,
    );

    const lines = [`${role} رجع للون الافتراضي — بدون تدرّج.`];

    if (blocked) {
      lines.push('', skippedNote(blocked, role));
    }

    await respond(ctx, okReply('انمسح اللون', lines.join('\n')));
  } catch (error) {
    logger.warn(`Color clear failed for ${ctx.user.id} on ${role.id}: ${error.message}`);

    await fail(ctx, 'ما قدرت أمسح الألوان', apiProblem(error));
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName('color')
    .setDescription('غيّر أو امسح ألوان رتبتك الشخصية')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('primary')
        .setDescription('اللون الأول: #ff0000، f00، red، أحمر — أو clear لإزالته')
        .setMinLength(3)
        .setMaxLength(24)
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('secondary')
        .setDescription('اللون الثاني للتدرّج: #00ff00، green، أخضر (اختياري)')
        .setMinLength(3)
        .setMaxLength(24)
        .setRequired(false),
    )
    .addBooleanOption((option) =>
      option
        .setName('clear')
        .setDescription('امسح اللون والتدرّج وارجع للافتراضي (clear / مسح)')
        .setRequired(false),
    ),

  name: 'color',
  aliases: ['colour'],
  description: 'غيّر أو امسح ألوان أعلى رتبة يملكها غيرك ما يملكها',
  category: 'General',
  usage: 'color [primary] [secondary] | color clear',
  cooldown: 10,
  guildOnly: true,

  async execute(ctx) {
    const args = ctx.isSlash ? [] : ctx.args;
    let primaryInput = ctx.isSlash ? ctx.getString('primary') : args[0];
    let secondaryInput = ctx.isSlash ? ctx.getString('secondary') : args[1];
    const clearFlag = ctx.isSlash ? ctx.getBoolean('clear') === true : false;

    // "-" (or "keep") leaves a color untouched, so prefix can change only the
    // second color: `:-color - #00ff00`.
    if (isKeepInput(primaryInput)) primaryInput = undefined;
    if (isKeepInput(secondaryInput)) secondaryInput = undefined;

    if (!ctx.isSlash && args.length > 2) {
      await fail(
        ctx,
        'قيم كثيرة',
        `عطني لون واحد أو لونين أو \`clear\`.\n\n${usageLines(ctx)}`,
      );
      return;
    }

    const firstIsClear = isClearInput(primaryInput);
    const secondIsClear = isClearInput(secondaryInput);

    // `list` anywhere on its own shows the palette instead of changing a role.
    const firstIsList = isListInput(primaryInput);
    const secondIsList = isListInput(secondaryInput);

    if (firstIsList || secondIsList) {
      if (clearFlag || (firstIsList && secondaryInput) || (secondIsList && primaryInput)) {
        await fail(ctx, 'اختر واحد', `استخدم \`list\` لحالها.\n\n${usageLines(ctx)}`);
        return;
      }

      await showColorList(ctx);
      return;
    }

    if (
      (clearFlag && (primaryInput || secondaryInput)) ||
      (firstIsClear && secondaryInput) ||
      (secondIsClear && primaryInput)
    ) {
      await fail(
        ctx,
        'اختر واحد',
        `استخدم ألوان أو \`clear\`، مو الاثنين.\n\n${usageLines(ctx)}`,
      );
      return;
    }

    const wantsClear = clearFlag || firstIsClear || secondIsClear;

    if (!wantsClear && !primaryInput && !secondaryInput) {
      // A bare `/color` or `:-color` is the natural way to ask "what can I use?".
      await showColorList(ctx);
      return;
    }

    const primary = wantsClear ? null : parseColor(primaryInput);
    const secondary = wantsClear ? null : parseColor(secondaryInput);

    if (!wantsClear && (!primary && primaryInput || !secondary && secondaryInput)) {
      const badFirst = !primary && primaryInput;
      const which = badFirst ? 'الأول' : 'الثاني';
      const bad = String(badFirst ? primaryInput : secondaryInput)
        .slice(0, 40)
        .replace(/[`\r\n]/g, ' ');

      await fail(
        ctx,
        'لون غير معروف',
        `\`${String(bad).slice(0, 40)}\` مو لون ${which} صحيح.\n\n` +
          'استخدم كود مثل `#FF0000` أو `#F00`، أو اسم مثل `red` أو `blue` أو `أحمر` أو `أخضر`، أو `list` عشان تشوف كل الألوان.\n\n' +
          usageLines(ctx),
      );
      return;
    }

    // The member-count lookup can take a moment on a large server.
    await ctx.defer({ ephemeral: true });

    const { role, blocked, problem } = await pickColorRole(ctx.guild, ctx.member);

    if (problem) {
      await fail(ctx, 'ما أقدر أغيّر لونك', problem);
      return;
    }

    const current = {
      primaryColor: role.colors?.primaryColor ?? role.color ?? 0,
      secondaryColor: role.colors?.secondaryColor ?? null,
      tertiaryColor: role.colors?.tertiaryColor ?? null,
    };

    if (wantsClear) {
      await clearColors(ctx, role, blocked, current);
      return;
    }

    const nextPrimary = primary ? primary.value : current.primaryColor;
    const nextSecondary = secondary ? secondary.value : current.secondaryColor;

    // A gradient needs a first color. If the role has none yet, a lone second
    // color would be rejected by Discord, so ask for the first one.
    if (secondary && !nextPrimary) {
      await fail(
        ctx,
        'محتاج اللون الأول',
        `**${role.name}** ما عندها لون أول بعد، فعطني إياه مع الثاني.\n\n${usageLines(ctx)}`,
      );
      return;
    }

    if (
      nextPrimary === current.primaryColor &&
      (nextSecondary ?? null) === (current.secondaryColor ?? null) &&
      !current.tertiaryColor
    ) {
      // Nothing changed, so do not hold the cooldown against the user.
      ctx.releaseCooldown();

      await respond(
        ctx,
        infoReply(
          'اللون مضبوط أصلًا',
          `${role} يستخدم ${colorSummary(hexOf(nextPrimary), nextSecondary === null ? null : hexOf(nextSecondary))} من قبل.\n` +
            'جرّب ألوان مختلفة إذا تبي تغيير واضح.',
        ),
      );
      return;
    }

    const title = !secondary
      ? 'تحدّث اللون الأول'
      : !primary
        ? 'تحدّث اللون الثاني'
        : 'تحدّث اللون';

    try {
      await role.setColors(
        {
          primaryColor: nextPrimary,
          secondaryColor: nextSecondary,
          // A holographic role has a third color; clear it so this really is a
          // two-color gradient.
          tertiaryColor: null,
        },
        reasonFor(ctx),
      );

      logger.info(
        `${ctx.user.tag ?? ctx.user.username} (${ctx.user.id}) set ${role.name} (${role.id}) to ${hexOf(nextPrimary)} -> ${nextSecondary === null ? 'none' : hexOf(nextSecondary)}`,
      );

      const solid = nextSecondary === null || nextSecondary === nextPrimary;
      const lines = [
        `${role} الحين يستخدم ${solid ? 'لون واحد' : 'تدرّج'}.`,
        '',
        `**الأول:** \`${hexOf(nextPrimary)}\`${primary ? '' : ' _(محفوظ)_'}`,
      ];

      if (nextSecondary === null) {
        lines.push('**الثاني:** _ما فيه_');
      } else {
        lines.push(
          `**الثاني:** \`${hexOf(nextSecondary)}\`${secondary ? '' : ' _(محفوظ)_'}`,
        );
      }

      if (nextSecondary !== null && nextSecondary === nextPrimary) {
        lines.push('', 'القيمتين نفس اللون، فبتطلع الرتبة بلون واحد.');
      }

      if (blocked) {
        lines.push('', skippedNote(blocked, role));
      }

      await respond(ctx, okReply(title, lines.join('\n')));
    } catch (error) {
      logger.warn(`Color change failed for ${ctx.user.id} on ${role.id}: ${error.message}`);

      await fail(ctx, 'ما قدرت أغيّر الألوان', apiProblem(error));
    }
  },
};
