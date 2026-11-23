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
import { AiError, aiConfigured, aiProblemHint } from '../../lib/ai.js';
import { getGuildSettings } from '../../services/birthday-store.js';
import {
  getSummary,
  getSummaryChannel,
  listSummaries,
  saveSummary,
  setSummaryChannel,
} from '../../services/report-store.js';
import {
  exportPayload,
  produceSummary,
  reportPayloads,
} from '../../services/report-runner.js';
import { KIND_KEYS, SUMMARY_KINDS, KIND_ALIASES } from '../../services/summary.js';

const logger = createLogger('summary');

const MAX_HOURS = 168;
const DEFAULT_HOURS = 24;

function kindChoices() {
  return KIND_KEYS.map((key) => ({
    name: `${SUMMARY_KINDS[key].arLabel} (${key}) — ${SUMMARY_KINDS[key].arBrief}`,
    value: key,
  }));
}

function kindList() {
  return KIND_KEYS.map((key) => SUMMARY_KINDS[key].arLabel).join('، ');
}

function durationLabel(hours) {
  return formatDurationArabic(hours * 60 * 60 * 1000);
}

async function requireManageGuild(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await ctx.fail(
    ephemeral(errorReply('صلاحيات ناقصة', 'تحتاج **إدارة السيرفر** عشان تغيّر هذا الإعداد.')),
  );

  return false;
}

/** Resolves `#channel`, a raw id, or nothing (the current channel). */
async function resolveChannel(ctx, id) {
  if (!id) return ctx.channel;

  const cached = ctx.guild.channels.cache.get(id);

  if (cached) return cached;

  return ctx.guild.channels.fetch(id).catch(() => null);
}

function slashParams(ctx) {
  return {
    channelId: ctx.getChannel('channel')?.id ?? null,
    hours: ctx.getInteger('hours') ?? DEFAULT_HOURS,
    kind: ctx.getString('kind') ?? 'general',
    prompt: ctx.getString('prompt') ?? '',
    isPrivate: ctx.getBoolean('private') === true,
  };
}

/**
 * `:-summary [#channel] [hours|Nd] [general|tasks|ask] [private] [focus…]` in any
 * order. A leading `run` / `channel` / `export` / `history` picks the action.
 */
function parsePrefix(ctx) {
  const tokens = [...ctx.args];
  let channelId = null;
  let hours = DEFAULT_HOURS;
  let kind = 'general';
  let isPrivate = false;
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

    const duration = /^(\d{1,3})(h|d)?$/i.exec(token);

    if (duration) {
      const value = Number.parseInt(duration[1], 10);
      hours = duration[2]?.toLowerCase() === 'd' ? value * 24 : value;
      continue;
    }

    const alias = KIND_ALIASES[token.toLowerCase()];

    if (alias && kind === 'general') {
      kind = alias;
      continue;
    }

    if (/^(private|me|silent)$/i.test(token)) {
      isPrivate = true;
      continue;
    }

    prompt.push(token);
  }

  return { channelId, hours, kind, prompt: prompt.join(' ').trim(), isPrivate };
}

async function handleRun(ctx) {
  if (!aiConfigured()) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'الذكاء الاصطناعي غير مضبوط',
          [
            'أضف هذي لمتغيرات بيئة السيرفر، وبعدها أعد التشغيل:',
            '```',
            'AI_API_KEY=your-key',
            'AI_MODEL=gemini-3.6-flash',
            '# optional, defaults to Google:',
            'AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai',
            '```',
            'أي مزوّد متوافق مع OpenAI يشتغل (OpenAI، OpenRouter، Groq، DeepSeek، محلي).',
          ].join('\n'),
        ),
      ),
    );
    return;
  }

  const params = ctx.isSlash ? slashParams(ctx) : parsePrefix(ctx);
  const hours = params.hours;

  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'مدة غير صالحة',
          `استخدم من 1 إلى ${MAX_HOURS} ساعة، مثلاً \`24\` أو \`2d\`.`,
        ),
      ),
    );
    return;
  }

  if (!KIND_KEYS.includes(params.kind)) {
    await ctx.fail(
      ephemeral(errorReply('نوع ملخص غير معروف', `اختر واحد من: ${kindList()}.`)),
    );
    return;
  }

  if (params.kind === 'targeted' && !params.prompt?.trim()) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'عن أي شي أدوّر؟',
          'الملخص الموجّه يحتاج تركيز، مثلاً `/summary run kind:Targeted prompt:قوانين السبان الجديدة`.',
        ),
      ),
    );
    return;
  }

  const channel = await resolveChannel(ctx, params.channelId);

  if (!channel) {
    await ctx.fail(
      ephemeral(errorReply('ما لقيت القناة', 'اختر قناة أقدر أشوفها.')),
    );
    return;
  }

  const me = ctx.guild.members.me;
  const permissions = channel.permissionsFor?.(me);

  if (
    !permissions?.has(PermissionFlagsBits.ViewChannel) ||
    !permissions?.has(PermissionFlagsBits.ReadMessageHistory)
  ) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'صلاحيات ناقصة',
          `أحتاج **${permissionName(PermissionFlagsBits.ViewChannel)}** و**${permissionName(
            PermissionFlagsBits.ReadMessageHistory,
          )}** في ${channel}.`,
        ),
      ),
    );
    return;
  }

  const now = Date.now();
  const since = now - hours * 60 * 60 * 1000;
  const timeZone = getGuildSettings(ctx.guildId).timezone ?? config.timezone;
  const working = { content: `🔎 أقرأ رسائل ${channel}…`, allowedMentions: { parse: [] } };

  if (ctx.isSlash) {
    await ctx.defer({ ephemeral: params.isPrivate });
    await ctx.editReply(working);
  } else {
    await ctx.reply(working);
  }

  let lastUpdate = Date.now();

  const onProgress = async (part, total) => {
    if (Date.now() - lastUpdate < 2500) return;
    lastUpdate = Date.now();
    await ctx
      .editReply({ content: `🧠 ألخّص الجزء ${part}/${total}…`, allowedMentions: { parse: [] } })
      .catch(() => {});
  };

  let result;

  try {
    result = await produceSummary({
      guildId: ctx.guildId,
      channel,
      kind: params.kind,
      prompt: params.prompt || null,
      since,
      until: now,
      timeZone,
      hours,
      requestedBy: ctx.user.username,
      onProgress,
    });
  } catch (error) {
    if (error instanceof AiError) {
      await ctx.editReply(errorReply('فشل التلخيص', aiProblemHint(error)));
      return;
    }

    logger.warn(`Could not read #${channel.name}: ${error.message}`);
    await ctx.editReply(
      errorReply('ما قدرت أقرأ الرسائل', 'ما قدرت أجيب سجل هذي القناة.'),
    );
    return;
  }

  if (!result.data) {
    await ctx.editReply(
      errorReply(
        'ما فيه شي ينلخّص',
        result.reason === 'empty-summary'
          ? `${channel} فيه رسائل، بس النموذج ما لقى شي يستاهل التقرير — لا مواضيع ولا قرارات ولا طلبات. جرّب فترة أطول، أو ملخص موجّه بتركيز.`
          : `ما فيه رسائل في ${channel} خلال آخر ${durationLabel(hours)}.`,
      ),
    );
    return;
  }

  const { data, collected, meta } = result;
  const id = saveSummary({
    guildId: ctx.guildId,
    channelId: channel.id,
    kind: params.kind,
    prompt: params.prompt || null,
    rangeStart: meta.rangeStart,
    rangeEnd: meta.rangeEnd,
    messageCount: meta.messageCount,
    body: data,
    createdBy: ctx.user.id,
  });

  const payloads = reportPayloads({ data, meta, id, collected });
  const destinationId = getSummaryChannel(ctx.guildId);
  const destination = destinationId ? await resolveChannel(ctx, destinationId) : ctx.channel;

  const showHere = params.isPrivate || !destination || destination.id === ctx.channel.id;

  try {
    if (showHere) {
      await ctx.editReply(payloads[0]);

      for (const payload of payloads.slice(1)) {
        await ctx.followUp(params.isPrivate ? ephemeral(payload) : payload);
      }
      return;
    }

    for (const payload of payloads) await destination.send(payload);

    await ctx.editReply(
      okReply(
        'اننشر الملخص',
        `ملخص ${SUMMARY_KINDS[params.kind].arLabel} لقناة ${channel} انرسل إلى ${destination}.`,
      ),
    );
  } catch (error) {
    logger.warn(`Could not deliver the summary: ${error.message}`);
    await ctx.editReply(
      errorReply(
        'ما قدرت أوصل الملخص',
        [
          error.message ? `ديسكورد قال: **${String(error.message).slice(0, 500)}**` : '',
          'تأكد إني أقدر **عرض القنوات**، **إرسال الرسائل** و**إرفاق الروابط** في قناة الوجهة.',
        ]
          .filter(Boolean)
          .join('\n\n'),
      ),
    );
  }
}

async function handleChannel(ctx) {
  if (!(await requireManageGuild(ctx))) return;

  const id = ctx.isSlash ? (ctx.getChannel('channel')?.id ?? null) : (ctx.args[0] ?? null);
  const mention = id ? (/^<#(\d{17,20})>$/.exec(id)?.[1] ?? id) : null;

  if (!mention) {
    const current = getSummaryChannel(ctx.guildId);

    await ctx.reply(
      ephemeral(
        infoReply(
          'قناة الملخصات',
          current
            ? `التقارير تنرسل إلى <#${current}>.\nغيّرها بـ \`/summary channel channel:#room\` أو امسحها بـ \`/summary channel\`.`
            : 'ما فيه قناة ملخصات مضبوطة، فكل تقرير ينشر في القناة اللي انكتب فيها الأمر.\nاضبطها بـ `/summary channel channel:#management`.',
        ),
      ),
    );
    return;
  }

  const channel = await resolveChannel(ctx, mention);

  if (!channel) {
    await ctx.fail(ephemeral(errorReply('ما لقيت القناة', 'اختر قناة نصية.')));
    return;
  }

  setSummaryChannel(ctx.guildId, channel.id);

  await ctx.reply(
    ephemeral(okReply('انضبطت قناة الملخصات', `التقارير الحين تنرسل إلى ${channel}.`)),
  );
}

async function handleExport(ctx) {
  const raw = ctx.isSlash ? ctx.getString('id') : ctx.args[0];
  const id = raw ? Number.parseInt(raw, 10) : null;
  const summary = id
    ? getSummary(ctx.guildId, id)
    : listSummaries(ctx.guildId, 1)[0] ?? null;

  if (!summary) {
    await ctx.fail(
      ephemeral(
        errorReply(
          'ما لقيت تقرير',
          id
            ? `ما فيه تقرير #${id} في هذا السيرفر.`
            : 'شغّل `/summary run` أول، بعدها صدّره.',
        ),
      ),
    );
    return;
  }

  const timeZone = getGuildSettings(ctx.guildId).timezone ?? config.timezone;
  const payload = exportPayload(summary, timeZone);

  await ctx.reply(ctx.isSlash ? ephemeral(payload) : payload);
}

async function handleHistory(ctx) {
  const reports = listSummaries(ctx.guildId, 10);

  if (reports.length === 0) {
    await ctx.reply(
      ephemeral(infoReply('ما فيه تقارير بعد', 'شغّل `/summary run` عشان تسوي واحد.')),
    );
    return;
  }

  const lines = reports.map(
    (report) =>
      `\`#${report.id}\` · ${SUMMARY_KINDS[report.kind]?.emoji ?? ''} ${SUMMARY_KINDS[report.kind]?.arLabel ?? report.kind} · <#${report.channelId}> · ${report.messageCount} رسالة · <t:${Math.floor(report.createdAt / 1000)}:R>`,
  );

  await ctx.reply(
    ephemeral({
      embeds: [
        embed({
          title: 'أحدث التقارير',
          description: lines.join('\n'),
          footer: 'صدّر أي واحد بـ /summary export id:<n>',
          color: COLORS.primary,
        }),
      ],
    }),
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('summary')
    .setDescription('لخّص قناة بالذكاء الاصطناعي وانشر التقرير في قناة الإدارة')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((sub) =>
      sub
        .setName('run')
        .setDescription('لخّص فترة من قناة')
        .addChannelOption((option) =>
          option.setName('channel').setDescription('القناة اللي تبي تلخّصها').setRequired(true),
        )
        .addIntegerOption((option) =>
          option
            .setName('hours')
            .setDescription(`كم ترجع ورا (1-${MAX_HOURS}، الافتراضي ${DEFAULT_HOURS})`)
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(MAX_HOURS),
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
            .setDescription('للملخص الموجّه: عن أي شي أدوّر؟')
            .setRequired(false)
            .setMaxLength(500),
        )
        .addBooleanOption((option) =>
          option.setName('private').setDescription('اعرض التقرير لي بس').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('channel')
        .setDescription('اختر القناة اللي تستقبل التقارير (فاضي يعرض الحالية)')
        .addChannelOption((option) =>
          option.setName('channel').setDescription('وين تنرسل التقارير').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('export')
        .setDescription('نزّل التقرير كملف HTML (اطبعه PDF)')
        .addIntegerOption((option) =>
          option.setName('id').setDescription('رقم التقرير (الافتراضي: الأحدث)').setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('history').setDescription('اعرض أحدث التقارير'),
    ),

  name: 'summary',
  aliases: ['summarize', 'report'],
  description: 'لخّص قناة وأرسل التقرير إلى قناة الإدارة',
  category: 'Community',
  usage: 'summary [#channel] [24h] [general|tasks|ask <focus>] [private]',
  cooldown: 5,
  guildOnly: true,
  permissions: ['ManageMessages'],

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);

    if (focused.name !== 'kind') return;

    const query = String(focused.value).toLowerCase();
    const matches = kindChoices().filter((choice) =>
      choice.name.toLowerCase().includes(query),
    );

    await interaction.respond(matches.slice(0, 25));
  },

  async execute(ctx) {
    let sub = 'run';

    if (ctx.isSlash) {
      sub = ctx.getSubcommand();
    } else if (ctx.args[0] === 'run') {
      ctx.args.shift();
    } else if (['channel', 'export', 'history'].includes(ctx.args[0])) {
      sub = ctx.args.shift();
    }

    if (sub === 'channel') return handleChannel(ctx);
    if (sub === 'export') return handleExport(ctx);
    if (sub === 'history') return handleHistory(ctx);

    return handleRun(ctx);
  },
};
