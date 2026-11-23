import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from '../../config.js';
import { formatDurationArabic } from '../../lib/durations.js';
import { COLORS, embed } from '../../lib/embeds.js';
import { createLogger } from '../../lib/logger.js';
import { permissionName } from '../../lib/permissions.js';
import { ephemeral, errorReply, infoReply, okReply } from '../../lib/replies.js';
import { aiConfigured } from '../../lib/ai.js';
import { getGuildSettings } from '../../services/birthday-store.js';
import {
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  getSchedule,
  getSummaryChannel,
  listSchedules,
  removeSchedule,
  setScheduleEnabled,
  upsertSchedule,
} from '../../services/report-store.js';
import { KIND_ALIASES, KIND_KEYS, SUMMARY_KINDS } from '../../services/summary.js';
import {
  formatClock,
  nextRunAt,
  parseClock,
  parseInterval,
} from '../../services/summary-scheduler.js';

const logger = createLogger('autoreport');

const MAX_SCHEDULES = 10;
const MAX_PROMPT = 500;

async function requireManageGuild(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await ctx.fail(
    ephemeral(errorReply('صلاحيات ناقصة', 'تحتاج **إدارة السيرفر** عشان تجدول التقارير.')),
  );

  return false;
}

async function resolveChannel(ctx, id) {
  if (!id) return null;

  const cached = ctx.guild.channels.cache.get(id);

  if (cached) return cached;

  return ctx.guild.channels.fetch(id).catch(() => null);
}

function timeZoneFor(guildId) {
  return getGuildSettings(guildId).timezone ?? config.timezone;
}

function stamp(ms) {
  return `<t:${Math.floor(ms / 1000)}:F> (<t:${Math.floor(ms / 1000)}:R>)`;
}

function cadenceLabel(schedule) {
  return schedule.mode === 'daily'
    ? `كل يوم الساعة ${formatClock(schedule.minuteOfDay)}`
    : `كل ${formatDurationArabic(schedule.intervalMs)}`;
}

function kindLabel(kind) {
  return `${SUMMARY_KINDS[kind]?.emoji ?? ''} ${SUMMARY_KINDS[kind]?.arLabel ?? kind}`.trim();
}

function kindChoices() {
  return KIND_KEYS.map((key) => ({
    name: `${SUMMARY_KINDS[key].arLabel} (${key}) — ${SUMMARY_KINDS[key].arBrief}`,
    value: key,
  }));
}

/**
 * `set #channel 6h [kind] [focus…]` or `set #channel 09:00 [kind] [focus…]`.
 * A token with a colon is a wall-clock time, otherwise a duration.
 */
function parsePrefixSet(ctx) {
  const tokens = [...ctx.args];
  let channelId = null;
  let intervalMs = null;
  let minuteOfDay = null;
  let kind = 'general';
  const prompt = [];

  for (const token of tokens) {
    const mention = /^<#(\d{17,20})>$/.exec(token);

    if (mention) {
      channelId ??= mention[1];
      continue;
    }

    if (/^\d{17,20}$/.test(token) && !channelId) {
      channelId = token;
      continue;
    }

    if (intervalMs === null && minuteOfDay === null) {
      const clock = parseClock(token);

      if (clock !== null) {
        minuteOfDay = clock;
        continue;
      }

      const interval = parseInterval(token);

      if (interval !== null) {
        intervalMs = interval;
        continue;
      }
    }

    const alias = KIND_ALIASES[token.toLowerCase()];

    if (alias && kind === 'general') {
      kind = alias;
      continue;
    }

    prompt.push(token);
  }

  return {
    channelId,
    intervalMs,
    minuteOfDay,
    kind,
    prompt: prompt.join(' ').trim(),
    rawEvery: null,
    rawTime: null,
  };
}

function setOptions(ctx) {
  if (ctx.isSlash) {
    const rawEvery = (ctx.getString('every') ?? '').trim();
    const rawTime = (ctx.getString('time') ?? '').trim();

    return {
      channelId: ctx.getChannel('channel')?.id ?? null,
      intervalMs: rawEvery ? parseInterval(rawEvery) : null,
      minuteOfDay: rawTime ? parseClock(rawTime) : null,
      kind: (ctx.getString('kind') ?? 'general').toLowerCase(),
      prompt: (ctx.getString('prompt') ?? '').trim(),
      rawEvery,
      rawTime,
    };
  }

  return parsePrefixSet(ctx);
}

async function handleSet(ctx) {
  if (!(await requireManageGuild(ctx))) return;

  if (!aiConfigured()) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'الذكاء الاصطناعي غير مضبوط',
          'الجدولة تحتاج الملخّص. أضف `AI_API_KEY` لمتغيرات السيرفر وأعد التشغيل.',
        ),
      ),
    );
    return;
  }

  const options = setOptions(ctx);

  if (!options.channelId) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'أي قناة؟',
          ctx.isSlash
            ? 'اختر القناة اللي تبي تلخّصها.'
            : 'اذكر القناة، مثلاً `:-autoreport set #general 6h`.',
        ),
      ),
    );
    return;
  }

  if (options.rawEvery && options.intervalMs === null) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'فترة غير صالحة',
          `استخدم دقائق أو ساعات أو أيام من ${formatDurationArabic(
            MIN_INTERVAL_MS,
          )} إلى ${formatDurationArabic(MAX_INTERVAL_MS)}: \`90m\`، \`6h\`، \`2d\`.`,
        ),
      ),
    );
    return;
  }

  if (options.rawTime && options.minuteOfDay === null) {
    await ctx.fail(
      ephemeral(
        errorReply('وقت غير صالح', 'استخدم صيغة 24 ساعة `HH:MM`، مثلاً `09:00` أو `21:30`.'),
      ),
    );
    return;
  }

  const hasInterval = options.intervalMs !== null && options.intervalMs !== undefined;
  const hasDaily = options.minuteOfDay !== null && options.minuteOfDay !== undefined;

  if (hasInterval === hasDaily) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'اختر جدولة وحدة',
          [
            'أعط **إما** فترة **أو** وقت يومي:',
            '`:-autoreport set #general 6h` — كل ست ساعات',
            '`:-autoreport set #general 09:00` — كل يوم الساعة 09:00 بتوقيت السيرفر',
            `الفترات من ${formatDurationArabic(MIN_INTERVAL_MS)} إلى ${formatDurationArabic(MAX_INTERVAL_MS)}.`,
          ].join('\n'),
        ),
      ),
    );
    return;
  }

  const kind = KIND_ALIASES[options.kind] ?? options.kind;

  if (!KIND_KEYS.includes(kind)) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'نوع ملخص غير معروف',
          `اختر واحد من: ${KIND_KEYS.map((key) => SUMMARY_KINDS[key].arLabel).join('، ')}.`,
        ),
      ),
    );
    return;
  }

  if (kind === 'targeted' && !options.prompt) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'الجدولة الموجّهة تحتاج تركيز',
          'مثلاً `:-autoreport set #general 09:00 ask جدول الفعاليات`.',
        ),
      ),
    );
    return;
  }

  if (options.prompt.length > MAX_PROMPT) {
    await ctx.fail(
      ephemeral(errorReply('التركيز طويل', `خلّه أقل من ${MAX_PROMPT} حرف.`)),
    );
    return;
  }

  const destinationId = getSummaryChannel(ctx.guildId);

  if (!destinationId) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'ما فيه قناة ملخصات',
          'حدد أول وين تنرسل التقارير: `/summary channel channel:#management`، بعدها جدول. وإلا التقرير المجدول بينزل في القناة اللي يقرأها.',
        ),
      ),
    );
    return;
  }

  const source = await resolveChannel(ctx, options.channelId);
  const destination = await resolveChannel(ctx, destinationId);

  if (!source || !destination) {
    await ctx.fail(
      ephemeral(errorReply('ما لقيت القناة', 'اختر قنوات أقدر أشوفها.')),
    );
    return;
  }

  const me = ctx.guild.members.me;
  const sourcePermissions = me ? source.permissionsFor?.(me) : null;

  if (
    !sourcePermissions?.has(PermissionFlagsBits.ViewChannel) ||
    !sourcePermissions?.has(PermissionFlagsBits.ReadMessageHistory)
  ) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'صلاحيات ناقصة',
          `أحتاج **${permissionName(PermissionFlagsBits.ViewChannel)}** و**${permissionName(
            PermissionFlagsBits.ReadMessageHistory,
          )}** في ${source}.`,
        ),
      ),
    );
    return;
  }

  const existing = getSchedule(ctx.guildId, source.id);

  if (!existing && listSchedules(ctx.guildId).length >= MAX_SCHEDULES) {
    await ctx.fail(
      ephemeral(
        errorReply('جدولة كثيرة', `احذف واحدة أول (الحد ${MAX_SCHEDULES}).`),
      ),
    );
    return;
  }

  const mode = hasDaily ? 'daily' : 'interval';

  const schedule = upsertSchedule({
    guildId: ctx.guildId,
    channelId: source.id,
    kind,
    prompt: kind === 'targeted' ? options.prompt : null,
    mode,
    intervalMs: mode === 'interval' ? options.intervalMs : null,
    minuteOfDay: mode === 'daily' ? options.minuteOfDay : null,
    createdBy: ctx.user.id,
  });

  const next = nextRunAt(schedule, timeZoneFor(ctx.guildId));
  const soon = next !== null && next - Date.now() < 15 * 60 * 1000;

  await ctx.reply(
    ephemeral(
      okReply(
        existing ? 'انحدّثت الجدولة' : 'انضافت الجدولة',
        [
          `ملخص **${kindLabel(kind)}** لقناة ${source}، ${cadenceLabel(schedule)}.`,
          `التقارير تروح إلى ${destination}.`,
          next ? `أول تشغيل: ${stamp(next)}` : null,
          // A report a minute from now only covers that minute. Expecting a
          // full day's summary from it is the most common confusion.
          soon
            ? 'أول تقرير بيغطي الفترة اللي قبله بس — إذا ما انكتب شي في هالفترة، ما بينشر شي.'
            : existing
              ? 'حفظ جدولة موجودة يعيد تشغيل نافذتها، فالتقرير الجاي بيغطي من الحين وراي.'
              : null,
        ]
          .filter(Boolean)
          .join('\n'),
      ),
    ),
  );
}

async function handleRemove(ctx) {
  if (!(await requireManageGuild(ctx))) return;

  const channelId = ctx.isSlash ? (ctx.getChannel('channel')?.id ?? null) : (ctx.args[0] ?? null);
  const source = await resolveChannel(ctx, channelId?.replace?.(/^<#|>$/g, '') ?? null);

  if (!source) {
    await ctx.fail(
      ephemeral(errorReply('أي قناة؟', 'اذكر القناة المجدولة.')),
    );
    return;
  }

  const removed = removeSchedule(ctx.guildId, source.id);

  await ctx.reply(
    ephemeral(
      removed > 0
        ? okReply('انشالت الجدولة', `ما عاد فيه تقارير تلقائية لـ ${source}.`)
        : infoReply('ما فيه جدولة', `${source} ما كان لها تقرير تلقائي.`),
    ),
  );
}

async function handleToggle(ctx, enabled) {
  if (!(await requireManageGuild(ctx))) return;

  const channelId = ctx.isSlash ? (ctx.getChannel('channel')?.id ?? null) : (ctx.args[0] ?? null);
  const source = await resolveChannel(ctx, channelId?.replace?.(/^<#|>$/g, '') ?? null);

  if (!source) {
    await ctx.fail(
      ephemeral(errorReply('أي قناة؟', 'اذكر القناة المجدولة.')),
    );
    return;
  }

  const changed = setScheduleEnabled(ctx.guildId, source.id, enabled);

  await ctx.reply(
    ephemeral(
      changed > 0
        ? okReply(
            enabled ? 'رجعت الجدولة' : 'انوقفت الجدولة مؤقتًا',
            `${source} — التقارير التلقائية الحين ${enabled ? 'شغالة' : 'موقوفة'}.`,
          )
        : infoReply(
            'ما فيه جدولة',
            `${source} ما عندها تقرير تلقائي ${enabled ? 'يرجع' : 'ينوقف'}.`,
          ),
    ),
  );
}

async function handleList(ctx) {
  const schedules = listSchedules(ctx.guildId);

  if (schedules.length === 0) {
    await ctx.reply(
      ephemeral(
        infoReply(
          'ما فيه تقارير تلقائية',
          [
            'سوِّ واحد بـ:',
            '`:-autoreport set #general 6h` — كل ست ساعات',
            '`:-autoreport set #general 09:00 tasks` — مهام يومية الساعة 09:00',
          ].join('\n'),
        ),
      ),
    );
    return;
  }

  const timeZone = timeZoneFor(ctx.guildId);
  const lines = schedules.map((schedule) => {
    const channel = ctx.guild.channels.cache.get(schedule.channelId);
    const name = channel ? `${channel}` : `\`${schedule.channelId}\``;
    const when = schedule.enabled
      ? `الجاي ${stamp(nextRunAt(schedule, timeZone))}`
      : 'موقوفة';

    return `${schedule.enabled ? '▶️' : '⏸️'} ${name} · ${kindLabel(schedule.kind)} · ${cadenceLabel(schedule)} · ${when}`;
  });

  await ctx.reply(
    ephemeral({
      embeds: [
        embed({
          title: `التقارير التلقائية (${schedules.length})`,
          description: lines.join('\n').slice(0, 4000),
          footer: `الأوقات بتوقيت ${timeZone} · /autoreport remove channel:<#channel>`,
          color: COLORS.primary,
        }),
      ],
    }),
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('autoreport')
    .setDescription('انشر ملخص قناة تلقائيًا، كل فترة أو في وقت ثابت')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('أنشئ جدولة قناة أو عدّلها')
        .addChannelOption((option) =>
          option.setName('channel').setDescription('القناة اللي تبي تلخّصها').setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('every')
            .setDescription('الفترة بين التقارير: 90m، 6h، 2d')
            .setRequired(false)
            .setMaxLength(10),
        )
        .addStringOption((option) =>
          option
            .setName('time')
            .setDescription('يوميًا بهذا التوقيت (24 ساعة): 09:00')
            .setRequired(false)
            .setMaxLength(5),
        )
        .addStringOption((option) =>
          option
            .setName('kind')
            .setDescription('نوع الملخص (الافتراضي: عام)')
            .setRequired(false)
            .addChoices(...kindChoices()),
        )
        .addStringOption((option) =>
          option
            .setName('prompt')
            .setDescription('للجدولة الموجّهة: عن أي شي أدوّر؟')
            .setRequired(false)
            .setMaxLength(MAX_PROMPT),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('وقّف التقرير التلقائي لقناة')
        .addChannelOption((option) =>
          option.setName('channel').setDescription('القناة المجدولة').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('pause')
        .setDescription('وقّف الجدولة مؤقتًا بدون حذفها')
        .addChannelOption((option) =>
          option.setName('channel').setDescription('القناة المجدولة').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('resume')
        .setDescription('رجّع جدولة موقوفة')
        .addChannelOption((option) =>
          option.setName('channel').setDescription('القناة المجدولة').setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('اعرض كل التقارير التلقائية')),

  name: 'autoreport',
  aliases: ['schedule', 'digest'],
  description: 'انشر ملخص قناة تلقائيًا كل فترة أو في وقت ثابت',
  category: 'Community',
  usage: 'autoreport set <#channel> <6h|09:00> [general|tasks|ask <focus>] | remove <#channel> | list',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ManageGuild'],

  async execute(ctx) {
    let sub = 'list';

    if (ctx.isSlash) {
      sub = ctx.getSubcommand() ?? 'list';
    } else if (['set', 'remove', 'pause', 'resume', 'list'].includes(ctx.args[0])) {
      sub = ctx.args.shift();
    }

    try {
      if (sub === 'set') return await handleSet(ctx);
      if (sub === 'remove') return await handleRemove(ctx);
      if (sub === 'pause') return await handleToggle(ctx, false);
      if (sub === 'resume') return await handleToggle(ctx, true);

      return await handleList(ctx);
    } catch (error) {
      logger.warn(`autoreport ${sub} failed: ${error.message}`);
      throw error;
    }
  },
};
