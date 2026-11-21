import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { errorReply, okReply } from '../../lib/replies.js';
import { parseReference, resolveMember } from '../../lib/resolve.js';

const logger = createLogger('nickname');

const MAX_LENGTH = 32;

// `reset` and friends clear the nickname instead of setting it to that word.
const RESET_WORDS = new Set(['reset', 'clear', 'remove', 'none', '-', '_', 'default']);

function ephemeral(payload) {
  return {
    ...payload,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  };
}

function reasonFor(ctx) {
  return `أمر الاسم بواسطة ${ctx.user.tag ?? ctx.user.username}`.slice(0, 500);
}

function escapeMarkdown(value) {
  return String(value).replace(/([\\`*_~|>])/g, '\\$1');
}

/**
 * Turns the typed text into `{ value }` for a new nickname or `{ value: null }`
 * for a reset. Empty text means reset, which is how `/nickname` without the
 * option behaves.
 */
function normalizeNickname(raw) {
  const text = String(raw ?? '').trim();

  if (!text || RESET_WORDS.has(text.toLowerCase())) return { value: null };

  if (text.length > MAX_LENGTH) {
    return {
      problem: `الأسماء محدودة بـ **${MAX_LENGTH}** حرف — الاسم هذا فيه **${text.length}**.`,
    };
  }

  return { value: text };
}

/** The member to rename: the mentioned one, or else the author. */
async function slashTarget(ctx) {
  const user = ctx.getUser('user');
  const text = (ctx.getString('nickname') ?? '').trim();

  if (!user) return { member: ctx.member, text };

  const member =
    ctx.getMember('user') ??
    (await ctx.guild.members.fetch(user.id).catch(() => null));

  return { member, text };
}

async function prefixTarget(ctx) {
  const [first] = ctx.args;
  const ref = first ? parseReference(first) : null;

  if (ref && (ref.kind === 'user' || ref.kind === 'id')) {
    const member = await resolveMember(ctx.guild, first, ctx.message);

    // A member mention or id targets that member; anything else is the author
    // typing a nickname that happens to start with an id-like number.
    if (member) {
      return { member, text: ctx.args.slice(1).join(' ').trim() };
    }
  }

  return { member: ctx.member, text: ctx.args.join(' ').trim() };
}

function apiProblem(error) {
  if (error?.code === 50013) {
    return 'ديسكورد رفض التغيير. أحتاج **إدارة الأسماء**، ورتبتي لازم تكون فوق رتبة العضو. صاحب السيرفر ما ينفع يتغيّر اسمه أصلًا.';
  }

  if (error?.code === 50035) {
    return 'ديسكورد رفض الاسم. خله أقل من 32 حرف وبدون رموز تحكم.';
  }

  if (error?.code === 429 || /rate limit/i.test(String(error?.message))) {
    return 'ديسكورد يحدّ تغييرات الأسماء الآن. انتظر دقيقة وجرّب مرة ثانية.';
  }

  return error?.message
    ? `ديسكورد قال: ${String(error.message).slice(0, 300)}`
    : 'صار خطأ وأنا أغيّر الاسم.';
}

/** Refusal: ephemeral, one or two readable lines, no embed. */
function fail(ctx, title, body) {
  return ctx.fail(ephemeral(errorReply(title, body)));
}

export default {
  data: new SlashCommandBuilder()
    .setName('nickname')
    .setDescription('غيّر اسمك، أو اسم عضو ثاني إذا عندك إدارة الأسماء')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option
        .setName('user')
        .setDescription('العضو اللي تبي تغيّر اسمه (الافتراضي أنت)')
        .setRequired(false),
    )
    .addStringOption((option) =>
      option
        .setName('nickname')
        .setDescription('الاسم الجديد — اتركه فاضي عشان ترجّع الاسم الأصلي')
        .setMaxLength(MAX_LENGTH)
        .setRequired(false),
    ),

  name: 'nickname',
  aliases: ['nick'],
  description: 'غيّر اسمك، أو اسم عضو ثاني إذا عندك إدارة الأسماء',
  category: 'Moderation',
  usage: 'nickname [@member] [name] | nickname [@member] reset',
  cooldown: 3,
  guildOnly: true,

  async execute(ctx) {
    // The member fetch and the API call can pass three seconds on a cold cache.
    if (ctx.isSlash) await ctx.defer({ ephemeral: true });

    const { member, text } = ctx.isSlash
      ? await slashTarget(ctx)
      : await prefixTarget(ctx);

    if (!member) {
      await fail(
        ctx,
        'عضو غير معروف',
        'منشن عضو من هذا السيرفر أو الصق الآيدي، مثل `:-nickname @member اسم جديد`.',
      );
      return;
    }

    const self = member.id === ctx.user.id;

    if (!self && !ctx.member?.permissions?.has(PermissionFlagsBits.ManageNicknames)) {
      await fail(
        ctx,
        'صلاحيات ناقصة',
        'تحتاج **إدارة الأسماء** عشان تغيّر اسم غيرك. اسمك تقدر تغيّره دائمًا.',
      );
      return;
    }

    const me = ctx.guild.members?.me;

    if (!me) {
      await fail(ctx, 'ما أقدر أغيّر الاسم', 'ما قدرت أقرأ ملفي في السيرفر. جرّب بعد لحظة.');
      return;
    }

    if (!me.permissions?.has(PermissionFlagsBits.ManageNicknames)) {
      await fail(ctx, 'صلاحيات ناقصة', 'أحتاج **إدارة الأسماء** عشان أغيّر الأسماء.');
      return;
    }

    if (member.id === me.id) {
      await fail(
        ctx,
        'هذا أنا',
        'ما أقدر أغيّر اسمي من أمر — غيّره من **إعدادات السيرفر → الأعضاء**.',
      );
      return;
    }

    if (member.id === ctx.guild.ownerId) {
      await fail(
        ctx,
        'صاحب السيرفر',
        'ديسكورد ما يسمح لأحد يغيّر اسم صاحب السيرفر.',
      );
      return;
    }

    if (!self) {
      const botTop = me.roles?.highest?.position ?? 0;
      const memberTop = member.roles?.highest?.position ?? 0;

      if (memberTop >= botTop) {
        await fail(
          ctx,
          'رتبته أعلى من رتبتي',
          `${member} رتبته أعلى من رتبتي أو نفسها، فما أقدر أغيّر اسمه. ارفع رتبتي في **إعدادات السيرفر → الرتب** وجرّب مرة ثانية.`,
        );
        return;
      }
    }

    const parsed = normalizeNickname(text);

    if (parsed.problem) {
      await fail(ctx, 'الاسم طويل', parsed.problem);
      return;
    }

    try {
      await member.setNickname(parsed.value, reasonFor(ctx));
    } catch (error) {
      logger.warn(`Nickname change failed for ${member.id}: ${error.message}`);
      await fail(ctx, 'ما قدرت أغيّر الاسم', apiProblem(error));
      return;
    }

    logger.info(
      `${ctx.user.tag ?? ctx.user.username} (${ctx.user.id}) set nickname of ${member.id} to ${parsed.value ?? 'reset'}`,
    );

    const body = parsed.value
      ? self
        ? `اسمك الحين **${escapeMarkdown(parsed.value)}**.`
        : `اسم ${member} الحين **${escapeMarkdown(parsed.value)}**.`
      : self
        ? 'رجعت اسمك الأصلي.'
        : `رجعت اسم ${member} الأصلي.`;

    await ctx.reply(
      ephemeral(okReply(parsed.value ? 'تم تغيير الاسم' : 'تمت إعادة الاسم', body)),
    );
  },
};
