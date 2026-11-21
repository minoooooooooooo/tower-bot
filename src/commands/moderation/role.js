import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { errorReply, okReply, warnReply } from '../../lib/replies.js';
import { findRoleMatches, parseReference, resolveMember, resolveRole } from '../../lib/resolve.js';

const logger = createLogger('role');

// A bulk run makes one API call per member. The cap keeps a giant server from
// holding the interaction open until it expires; the summary says when it bites.
const BULK_LIMIT = 500;

const ACTION_WORDS = { add: 'add', '+': 'add', remove: 'remove', '-': 'remove', toggle: 'toggle' };
const TARGET_WORDS = { all: 'humans', humans: 'humans', bots: 'bots' };

const USAGE = {
  slash: [
    '/role toggle role:@Role [user:@member]',
    '/role add role:@Role [user:@member]',
    '/role remove role:@Role [user:@member]',
    '/role bulk action:add role:@Role target:humans',
  ],
  prefix: [
    ':-role @Role            بدّلها على نفسك',
    ':-role +@Role           ضيفها لنفسك',
    ':-role -@Role           اشلها من نفسك',
    ':-role @member +@Role   ضيفها لعضو واحد',
    ':-role all +@Role       ضيفها لكل الأعضاء',
    ':-role bots -@Role      اشلها من كل البوتات',
  ],
};

function ephemeral(payload) {
  return {
    ...payload,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  };
}

function reasonFor(ctx) {
  return `أمر الرتبة بواسطة ${ctx.user.tag ?? ctx.user.username}`.slice(0, 500);
}

function usageLines(ctx) {
  const examples = ctx.isSlash ? USAGE.slash : USAGE.prefix;
  return ['**الاستخدام:**', ...examples.map((line) => `\`${line}\``)].join('\n');
}

function fail(ctx, title, description) {
  return ctx.fail(ephemeral(errorReply(title, description)));
}

function respond(ctx, payload) {
  const body = { ...payload, allowedMentions: { parse: [] } };

  if (ctx.isSlash) return ctx.editReply(body);
  return ctx.reply(body);
}

function done(ctx, title, description) {
  return respond(ctx, ephemeral(okReply(title, description)));
}

function info(ctx, title, description) {
  return respond(ctx, ephemeral(warnReply(title, description)));
}

function apiProblem(error) {
  if (error?.code === 50013) {
    return 'ديسكورد يقول ما عندي صلاحية. تأكد من **إدارة الرتب** وأن رتبتي فوق رتبة الهدف والرتبة المطلوبة.';
  }

  if (error?.code === 50035) {
    return 'ديسكورد رفض الطلب كأنه غير صالح. راجع الرتبة والعضو.';
  }

  if (error?.code === 429 || /rate limit/i.test(String(error?.message))) {
    return 'ديسكورد يحدّ تغييرات الرتب الآن. انتظر دقيقة وجرّب مرة ثانية.';
  }

  return error?.message
    ? `ديسكورد قال: ${String(error.message).slice(0, 300)}`
    : 'صار خطأ وأنا أغيّر الرتبة.';
}

function botProblem(guild) {
  const me = guild.members?.me;

  if (!me) return 'ما قدرت أقرأ ملفي في السيرفر. جرّب بعد لحظة.';

  if (!me.permissions?.has(PermissionFlagsBits.ManageRoles)) {
    return 'أحتاج صلاحية **إدارة الرتب** عشان أغيّر الرتب.';
  }

  return null;
}

/** Refuses roles Discord will not let a bot assign by hand. */
function roleProblem(guild, role) {
  if (!role) {
    return 'حدّد الرتبة — منشنها (`@Role`)، الصق آيديها، أو اكتب اسمها بالضبط.';
  }

  if (role.id === guild.id) {
    return 'رتبة **@everyone** ما تنضاف ولا تنشال.';
  }

  if (role.managed) {
    return `**${role.name}** مرتبطة بتكامل وما تنضاف يدويًا.`;
  }

  const botTop = guild.members?.me?.roles?.highest?.position ?? 0;

  if ((role.position ?? 0) >= botTop) {
    return `رتبتي لازم تكون **فوق ${role.name}**. ارفع رتبتي في **إعدادات السيرفر → الرتب** وجرّب مرة ثانية.`;
  }

  return null;
}

/** Refuses members the bot cannot outrank. Managing its own roles is allowed. */
function memberProblem(member, me) {
  if (!member) return 'حدّد عضو من هذا السيرفر.';
  if (!me) return 'ما قدرت أقرأ ملفي في السيرفر. جرّب بعد لحظة.';
  if (member.id === me.id) return null;

  const botTop = me.roles?.highest?.position ?? 0;
  const memberTop = member.roles?.highest?.position ?? 0;

  if (memberTop >= botTop) {
    const name = member.displayName ?? member.user?.username ?? 'هذا العضو';
    return `**${name}** رتبته أعلى من رتبتي أو نفسها، فما أقدر أغيّر رتبه. ارفع رتبتي أول.`;
  }

  return null;
}

/**
 * Adds, removes or toggles one role. Returns `added`, `removed` or `unchanged`
 * so a bulk run can report exactly what happened.
 */
async function applyRole(member, role, action, reason) {
  const has = member.roles?.cache?.has(role.id) ?? false;
  const shouldHave = action === 'toggle' ? !has : action === 'add';

  if (shouldHave === has) return 'unchanged';

  if (shouldHave) await member.roles.add(role, reason);
  else await member.roles.remove(role, reason);

  return shouldHave ? 'added' : 'removed';
}

function parseAction(tokens) {
  if (tokens.length === 0) return { action: 'toggle', tokens };

  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  const isMarker = (token) => token === '+' || token === '-';

  // `:-role + @Role` / `:-role @Role +`
  if (isMarker(first)) {
    return { action: first === '+' ? 'add' : 'remove', tokens: tokens.slice(1) };
  }

  if (tokens.length > 1 && isMarker(last)) {
    return { action: last === '+' ? 'add' : 'remove', tokens: tokens.slice(0, -1) };
  }

  // `:-role +@Role` / `:-role -@Role`
  if (first.length > 1 && (first[0] === '+' || first[0] === '-')) {
    return {
      action: first[0] === '+' ? 'add' : 'remove',
      tokens: [first.slice(1), ...tokens.slice(1)],
    };
  }

  // `:-role add @Role`
  const word = ACTION_WORDS[String(first).toLowerCase()];

  if (tokens.length > 1 && word) {
    return { action: word, tokens: tokens.slice(1) };
  }

  return { action: 'toggle', tokens };
}

async function prefixPlan(ctx) {
  const args = [...ctx.args];
  let target = { kind: 'self' };

  const first = String(args[0] ?? '').toLowerCase();

  if (TARGET_WORDS[first]) {
    target = { kind: TARGET_WORDS[first] };
    args.shift();
  }

  // A mention or id in front of the role targets one member. A role id is left
  // alone so `:-role 123456789012345678` still toggles that role on yourself.
  if (args.length > 1) {
    const ref = parseReference(args[0]);
    const looksLikeMember =
      ref &&
      (ref.kind === 'user' ||
        (ref.kind === 'id' && !ctx.guild.roles?.cache?.has?.(ref.id)));

    if (looksLikeMember) {
      const member = await resolveMember(ctx.guild, args[0], ctx.message);

      if (member) {
        target = { kind: 'member', member };
        args.shift();
      }
    }
  }

  const { action, tokens } = parseAction(args);

  return { target, action, text: tokens.join(' ').trim() };
}

async function collectMembers(guild, kind) {
  const cache = guild.members?.cache;
  let members = [];

  if ((cache?.size ?? 0) > 0 && cache.size >= (guild.memberCount ?? 0)) {
    members = [...cache.values()];
  } else {
    try {
      const fetched = await guild.members.fetch();
      members = [...fetched.values()];
    } catch {
      members = [...(cache?.values?.() ?? [])];
    }
  }

  return members
    .filter((member) => (kind === 'bots' ? member.user?.bot : !member.user?.bot))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

async function runSingle(ctx, member, role, action) {
  const me = ctx.guild.members?.me;
  const problem = memberProblem(member, me);

  if (problem) {
    await fail(ctx, 'ما أقدر أغيّر هذا العضو', problem);
    return;
  }

  await ctx.defer({ ephemeral: true });

  try {
    const result = await applyRole(member, role, action, reasonFor(ctx));
    const self = member.id === ctx.user.id;

    if (result === 'added') {
      await done(
        ctx,
        'تمت إضافة الرتبة',
        self ? `أضفت ${role} لحسابك.` : `أضفت ${role} لـ ${member}.`,
      );
      return;
    }

    if (result === 'removed') {
      await done(
        ctx,
        'تمت إزالة الرتبة',
        self ? `أزلت ${role} من حسابك.` : `أزلت ${role} من ${member}.`,
      );
      return;
    }

    const alreadyThere = action === 'add';

    await info(
      ctx,
      'ما تغيّر شيء',
      alreadyThere
        ? self
          ? `${role} على حسابك أصلًا.`
          : `${role} على ${member} أصلًا.`
        : self
          ? `${role} مو على حسابك أصلًا.`
          : `${role} مو على ${member} أصلًا.`,
    );
  } catch (error) {
    logger.warn(`Role change failed for ${member.id} on ${role.id}: ${error.message}`);
    await fail(ctx, 'ما قدرت أغيّر الرتبة', apiProblem(error));
  }
}

async function runBulk(ctx, target, role, action) {
  await ctx.defer({ ephemeral: true });

  const members = await collectMembers(ctx.guild, target);
  const me = ctx.guild.members?.me;
  const counts = { added: 0, removed: 0, unchanged: 0, skipped: 0, failed: 0 };
  let firstFailure = null;

  for (const member of members.slice(0, BULK_LIMIT)) {
    if (memberProblem(member, me)) {
      counts.skipped += 1;
      continue;
    }

    try {
      const result = await applyRole(member, role, action, reasonFor(ctx));
      counts[result] += 1;
    } catch (error) {
      counts.failed += 1;
      firstFailure ??= `${member}: ${apiProblem(error)}`;
    }
  }

  const audience = target === 'bots' ? 'البوتات' : 'الأعضاء';
  const verb = action === 'add' ? 'إضافة' : action === 'remove' ? 'إزالة' : 'تبديل';
  const okTitle =
    action === 'add'
      ? 'تمت إضافة الرتبة'
      : action === 'remove'
        ? 'تمت إزالة الرتبة'
        : 'تم تبديل الرتبة';
  const warnTitle =
    action === 'add'
      ? 'تمت الإضافة مع أخطاء'
      : action === 'remove'
        ? 'تمت الإزالة مع أخطاء'
        : 'تم التبديل مع أخطاء';

  const lines = [
    `${role} · ${verb} لـ ${audience}`,
    '',
    `أُضيفت: **${counts.added}**`,
    `أُزيلت: **${counts.removed}**`,
    `ما تغيّرت: **${counts.unchanged}**`,
    `انخطى: **${counts.skipped}**${counts.skipped ? ' (رتبتهم أعلى من رتبتي)' : ''}`,
  ];

  if (counts.failed) {
    lines.push(`فشل: **${counts.failed}**`);
    if (firstFailure) lines.push(`> ${firstFailure}`);
  }

  if (members.length > BULK_LIMIT) {
    lines.push(
      '',
      `عالجت أول **${BULK_LIMIT}** عضو فقط — شغّله مرة ثانية للباقي.`,
    );
  }

  logger.info(
    `${ctx.user.tag ?? ctx.user.username} (${ctx.user.id}) ${action} ${role.name} (${role.id}) for ${members.length} ${audience}: +${counts.added} -${counts.removed} =${counts.unchanged} skip${counts.skipped} fail${counts.failed}`,
  );

  const payload = ephemeral(
    counts.failed
      ? warnReply(warnTitle, lines.join('\n'))
      : okReply(okTitle, lines.join('\n')),
  );

  await respond(ctx, payload);
}

/** Escapes the typed word so bold/italic characters cannot break the reply. */
function display(text) {
  return String(text ?? '').replace(/([\\`*_~|>])/g, '\\$1');
}

function ambiguousRoleDescription(text, matches) {
  const shown = matches.slice(0, 10);
  const lines = shown.map((role) => `• **${role.name}**`);

  if (matches.length > shown.length) {
    lines.push(`…و **${matches.length - shown.length}** غيرها.`);
  }

  return [
    `**${display(text)}** يطابق **${matches.length}** رتب:`,
    ...lines,
    '',
    'اكتب جزء أكثر من الاسم، أو منشن الرتبة.',
  ].join('\n');
}

async function executePrefix(ctx) {
  if (ctx.args.length === 0) {
    await respond(ctx, ephemeral(warnReply('أمر الرتبة', usageLines(ctx))));
    return;
  }

  const { target, action, text } = await prefixPlan(ctx);

  if (!text) {
    await fail(ctx, 'أي رتبة؟', `حدّد رتبة واحدة.\n\n${usageLines(ctx)}`);
    return;
  }

  // Mentions and ids are exact by nature. A plain word is searched: exact name
  // first, then names that start with or contain it, so "سكان" finds
  // "سكان البرج" but "رون" refuses when it fits several roles.
  const ref = parseReference(text);
  const matches = ref ? [] : findRoleMatches(ctx.guild, text);
  let role = null;

  if (ref) {
    role = await resolveRole(ctx.guild, text).catch(() => null);
  } else if (matches.length === 1) {
    role = matches[0];
  }

  if (!role) {
    if (matches.length > 1) {
      await fail(ctx, 'الرتبة غير واضحة', ambiguousRoleDescription(text, matches));
      return;
    }

    await fail(
      ctx,
      'رتبة غير معروفة',
      ref
        ? 'حدّد الرتبة — منشنها (`@Role`)، الصق آيديها، أو اكتب اسمها بالضبط.'
        : `ما فيه رتبة اسمها فيه **${display(text)}**. تأكد من الكتابة، أو منشن الرتبة، أو الصق آيديها.`,
    );
    return;
  }

  const problem = roleProblem(ctx.guild, role);

  if (problem) {
    await fail(ctx, 'ما أقدر أستخدم هذي الرتبة', problem);
    return;
  }

  if (target.kind === 'humans' || target.kind === 'bots') {
    await runBulk(ctx, target.kind, role, action);
    return;
  }

  const member = target.kind === 'member' ? target.member : ctx.member;

  if (!member) {
    await fail(ctx, 'عضو غير معروف', 'منشن عضو من هذا السيرفر أو الصق الآيدي.');
    return;
  }

  await runSingle(ctx, member, role, action);
}

async function executeSlash(ctx) {
  const sub = ctx.getSubcommand() ?? 'toggle';

  if (sub === 'bulk') {
    const role = ctx.getRole('role');
    const problem = roleProblem(ctx.guild, role);

    if (problem) {
      await fail(ctx, role ? 'ما أقدر أستخدم هذي الرتبة' : 'رتبة غير معروفة', problem);
      return;
    }

    const action = ctx.getString('action') ?? 'toggle';
    const target = ctx.getString('target') ?? 'humans';

    await runBulk(ctx, target, role, action);
    return;
  }

  const action = ['add', 'remove', 'toggle'].includes(sub) ? sub : 'toggle';
  const role = ctx.getRole('role');
  const problem = roleProblem(ctx.guild, role);

  if (problem) {
    await fail(ctx, role ? 'ما أقدر أستخدم هذي الرتبة' : 'رتبة غير معروفة', problem);
    return;
  }

  const user = ctx.getUser('user');
  const member = user
    ? (ctx.getMember('user') ??
      (await ctx.guild.members.fetch(user.id).catch(() => null)))
    : ctx.member;

  if (!member) {
    await fail(ctx, 'عضو غير معروف', 'منشن عضو من هذا السيرفر أو الصق الآيدي.');
    return;
  }

  await runSingle(ctx, member, role, action);
}

export default {
  data: new SlashCommandBuilder()
    .setName('role')
    .setDescription('أضف رتبة أو اشلها أو بدّلها لك، لعضو، أو للكل')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('toggle')
        .setDescription('بدّل الرتبة: يضيفها إذا مو موجودة ويشيلها إذا موجودة')
        .addRoleOption((option) =>
          option.setName('role').setDescription('الرتبة اللي تبي تبدّلها').setRequired(true),
        )
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('العضو اللي تبي تغيّره (الافتراضي أنت)')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('أضف الرتبة للعضو إذا ما عنده إياها')
        .addRoleOption((option) =>
          option.setName('role').setDescription('الرتبة اللي تبي تضيفها').setRequired(true),
        )
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('العضو اللي تبي تغيّره (الافتراضي أنت)')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('اشل الرتبة من العضو إذا عنده إياها')
        .addRoleOption((option) =>
          option.setName('role').setDescription('الرتبة اللي تبي تشيلها').setRequired(true),
        )
        .addUserOption((option) =>
          option
            .setName('user')
            .setDescription('العضو اللي تبي تغيّره (الافتراضي أنت)')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('bulk')
        .setDescription('طبّق الرتبة على كل الأعضاء أو كل البوتات')
        .addStringOption((option) =>
          option
            .setName('action')
            .setDescription('شنو تبي تسوي بالرتبة')
            .setRequired(true)
            .addChoices(
              { name: 'إضافة', value: 'add' },
              { name: 'إزالة', value: 'remove' },
              { name: 'تبديل', value: 'toggle' },
            ),
        )
        .addRoleOption((option) =>
          option.setName('role').setDescription('الرتبة اللي تبي تغيّرها').setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('target')
            .setDescription('من تبي تغيّر')
            .setRequired(true)
            .addChoices(
              { name: 'الأعضاء', value: 'humans' },
              { name: 'البوتات', value: 'bots' },
            ),
        ),
    ),

  name: 'role',
  aliases: ['roles'],
  description: 'أضف رتبة أو اشلها أو بدّلها (إدارة الرتب)',
  category: 'Moderation',
  usage: 'role [all|bots] [@member] [+|-]<@role>',
  cooldown: 10,
  guildOnly: true,
  permissions: ['ManageRoles'],

  async execute(ctx) {
    const problem = botProblem(ctx.guild);

    if (problem) {
      await fail(ctx, 'صلاحيات ناقصة', problem);
      return;
    }

    if (ctx.isSlash) return executeSlash(ctx);
    return executePrefix(ctx);
  },
};
