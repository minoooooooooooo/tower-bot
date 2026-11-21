import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { formatDate, formatNumber } from '../../lib/activity-format.js';
import { embed } from '../../lib/embeds.js';
import { okReply, warnReply } from '../../lib/replies.js';
import { normalizeForMatch } from '../../lib/text.js';
import {
  cancelAudit,
  cancelBackfill,
  countBackfillableChannels,
  currentAuditJob,
  currentBackfillJob,
  startAudit,
  startBackfill,
} from '../../services/activity-backfill.js';
import {
  auditStats,
  backfillStats,
  messagesSince,
  trackingSince,
  voiceSince,
} from '../../services/activity-store.js';

const ACTIONS = new Map([
  ['start', 'start'],
  ['resume', 'start'],
  ['status', 'status'],
  ['progress', 'status'],
  ['audit', 'audit'],
  ['dryrun', 'audit'],
  ['cancel', 'cancel'],
  ['stop', 'cancel'],
]);

function parseAction(ctx) {
  const raw = (ctx.isSlash ? ctx.getString('action') : ctx.args[0]) ?? 'status';
  return ACTIONS.get(normalizeForMatch(raw)) ?? null;
}

function stateLabel(running, job, channelTotal, handled, stats) {
  if (running) return job.cancelled ? 'يتوقف' : 'يشتغل';

  if (channelTotal > 0 && handled >= channelTotal) {
    return stats.errors === 0 ? 'مكتمل' : 'مكتمل مع تخطيات';
  }

  if (stats.channels > 0) return 'متوقف مؤقتًا';

  return 'ما بدأ';
}

function statusPayload(ctx) {
  const job = currentBackfillJob(ctx.guildId);
  const stats = backfillStats(ctx.guildId);
  const total = countBackfillableChannels(ctx.guild);
  const running = Boolean(job && !job.finishedAt);
  const channelTotal = Math.max(total, stats.channels);
  const done = Math.min(stats.done, channelTotal || stats.done);
  const handled = stats.done + stats.errors;
  const state = stateLabel(running, job, channelTotal, handled, stats);

  const description = running
    ? 'يقرأ الرسائل القديمة في الخلفية. التقدّم ينحفظ بعد كل صفحة.'
    : state === 'مكتمل'
      ? 'كل قناة نصية انقرأت رجوعًا لبداية سيرفرك.'
      : state === 'مكتمل مع تخطيات'
        ? 'كل قناة مقروءة انستوردت. القنوات المتخطّاة تحتاج عادةً **قراءة سجل الرسائل**؛ صلّحها وشغّل `/backfill start` عشان تعيد المحاولة.'
        : state === 'متوقف مؤقتًا'
          ? 'آخر تشغيل وقف بدري. `/backfill start` يكمّل من المؤشر المحفوظ لكل قناة.'
          : 'الرسائل القديمة ما انستوردت. شغّل `/backfill start` مرة واحدة.';

  return embed({
    title: 'استيراد النشاط',
    description,
    fields: [
      { name: 'الحالة', value: state, inline: true },
      {
        name: 'القنوات',
        value: `${formatNumber(done)} / ${formatNumber(channelTotal)}`,
        inline: true,
      },
      {
        name: 'الرسائل المستوردة',
        value: formatNumber(stats.fetched),
        inline: true,
      },
      {
        name: 'أقدم رسالة مستوردة',
        value: stats.oldestAt ? formatDate(stats.oldestAt) : '—',
        inline: true,
      },
      {
        name: 'قنوات متخطّاة',
        value: formatNumber(stats.errors),
        inline: true,
      },
      {
        name: 'القناة الحالية',
        value: running && job.channelId ? `<#${job.channelId}>` : '—',
        inline: true,
      },
      {
        name: 'الرسائل منذ',
        value: formatDate(messagesSince(ctx.guildId)),
        inline: true,
      },
      {
        name: 'الصوت منذ',
        value: formatDate(voiceSince(ctx.guildId)),
        inline: true,
      },
    ],
    footer: 'سجل الصوت ما ينستورد · /backfill cancel يحفظ التقدّم',
  });
}

function auditPayload(ctx) {
  const job = currentAuditJob(ctx.guildId);
  const stats = auditStats(ctx.guildId);
  const imported = backfillStats(ctx.guildId).fetched;
  const total = countBackfillableChannels(ctx.guild);
  const running = Boolean(job && !job.finishedAt);
  const channelTotal = Math.max(total, stats.channels);
  const done = Math.min(stats.done, channelTotal || stats.done);
  const handled = stats.done + stats.errors;
  const state = stateLabel(running, job, channelTotal, handled, stats);

  const matches =
    imported > 0 && stats.human === imported
      ? 'يطابق الإجمالي المستورد بالضبط.'
      : `المستورد سجّل ${formatNumber(imported)}.`;

  const description = running
    ? 'يفحص كل رسالة مستوردة. ما ينكتب شي في إجماليات النشاط.'
    : state === 'مكتمل' || state === 'مكتمل مع تخطيات'
      ? `خلصت التجربة الجافة. ${matches}`
      : state === 'متوقف مؤقتًا'
        ? 'آخر فحص وقف بدري. `/backfill audit` يكمّل من كل مؤشر محفوظ.'
        : 'ما فيه تجربة جافة مسجّلة بعد. `/backfill audit` يبدأ واحدة.';

  return embed({
    title: 'فحص الاستيراد · تجربة جافة',
    description,
    fields: [
      { name: 'الحالة', value: state, inline: true },
      {
        name: 'القنوات',
        value: `${formatNumber(done)} / ${formatNumber(channelTotal)}`,
        inline: true,
      },
      { name: 'المقروء', value: formatNumber(stats.seen), inline: true },
      {
        name: 'بشري · قابل للاستيراد',
        value: formatNumber(stats.human),
        inline: true,
      },
      {
        name: 'بوتات / ويب هوك',
        value: formatNumber(stats.bots),
        inline: true,
      },
      {
        name: 'رسائل النظام',
        value: formatNumber(stats.system),
        inline: true,
      },
      {
        name: 'نافذة العدّ · بشري',
        value: formatNumber(stats.newer),
        inline: true,
      },
      {
        name: 'أقدم رسالة مقروءة',
        value: stats.oldestAt ? formatDate(stats.oldestAt) : '—',
        inline: true,
      },
      {
        name: 'المستورد بالاستيراد',
        value: formatNumber(imported),
        inline: true,
      },
      {
        name: 'القناة الحالية',
        value: running && job.channelId ? `<#${job.channelId}>` : '—',
        inline: true,
      },
    ],
    footer: 'تجربة جافة فقط · الإجماليات ما تتغيّر · الثريدات ما تنفحص',
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('backfill')
    .setDescription('استورد سجل الرسائل القديمة في إحصائيات النشاط')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('action')
        .setDescription('اللي تبي تسويه (الافتراضي: الحالة)')
        .setRequired(false)
        .addChoices(
          { name: 'ابدأ', value: 'start' },
          { name: 'الحالة', value: 'status' },
          { name: 'فحص (تجربة جافة)', value: 'audit' },
          { name: 'إلغاء', value: 'cancel' },
        ),
    ),

  name: 'backfill',
  aliases: ['importactivity', 'historyimport'],
  description: 'استورد سجل الرسائل القديمة في إحصائيات النشاط',
  category: 'Activity',
  usage: 'backfill [start|status|audit|cancel]',
  cooldown: 10,
  guildOnly: true,
  ownerOnly: true,

  async execute(ctx, client) {
    const action = parseAction(ctx);

    if (!action) {
      await ctx.fail(
        warnReply(
          'إجراء غير معروف',
          `استخدم \`${ctx.isSlash ? '/backfill' : ':-backfill'} [start|status|audit|cancel]\`.`,
        ),
      );
      return;
    }

    if (action === 'status') {
      const embeds = [statusPayload(ctx)];
      const auditJob = currentAuditJob(ctx.guildId);
      const audit = auditStats(ctx.guildId);

      if (audit.channels > 0 || auditJob) embeds.push(auditPayload(ctx));

      await ctx.reply({ embeds });
      return;
    }

    if (action === 'audit') {
      const total = countBackfillableChannels(ctx.guild);
      const audit = auditStats(ctx.guildId);
      const auditJob = currentAuditJob(ctx.guildId);
      const channelTotal = Math.max(total, audit.channels);

      if (auditJob && !auditJob.finishedAt) {
        await ctx.reply({ embeds: [auditPayload(ctx)] });
        return;
      }

      if (channelTotal > 0 && audit.done >= channelTotal && audit.errors === 0) {
        await ctx.reply({ embeds: [auditPayload(ctx)] });
        return;
      }

      if (total === 0) {
        await ctx.reply(
          warnReply(
            'ما فيه شي ينفحص',
            'ما أشوف قنوات نصية فيها سجل رسائل مقروء. تأكد من صلاحيات **عرض القنوات** و**قراءة سجل الرسائل**.',
          ),
        );
        return;
      }

      const result = startAudit(client, ctx.guildId);

      if (!result.started) {
        await ctx.reply(
          warnReply(
            'يشتغل من قبل',
            result.reason === 'import'
              ? 'استيراد الرسائل لسا يشتغل. انتظره أو ألغه بـ `/backfill cancel`.'
              : 'الفحص يشتغل من قبل. `/backfill status` يعرض التقدّم.',
          ),
        );
        return;
      }

      await ctx.reply(
        okReply(
          'بدأ فحص الاستيراد',
          [
            `يفحص ${formatNumber(total)} قناة نصية من الأحدث للأقدم ويصنّف كل رسالة: بشرية، بوت/ويب هوك، نظام، أو داخل نافذة العدّ.`,
            'هذي تجربة جافة: إجماليات النشاط ما تتغيّر. الثريدات ما تنفحص.',
            '`/backfill status` يعرض التقرير؛ `/backfill cancel` يوقف بعد الصفحة الحالية ويحفظ المؤشر.',
          ].join('\n\n'),
        ),
      );
      return;
    }

    if (action === 'cancel') {
      const importJob = cancelBackfill(ctx.guildId);
      const auditJob = cancelAudit(ctx.guildId);

      if (!importJob && !auditJob) {
        await ctx.reply(
          warnReply(
            'ما فيه شي يشتغل',
            'ابدأ استيراد بـ `/backfill start` أو تجربة جافة بـ `/backfill audit`. التقدّم المحفوظ يبقى.',
          ),
        );
        return;
      }

      const stopped = [
        importJob ? 'استيراد الرسائل' : null,
        auditJob ? 'الفحص الجاف' : null,
      ].filter(Boolean);

      await ctx.reply(
        warnReply(
          'يتوقف',
          `الصفحة الحالية تخلص، بعدها ${stopped.join(' و ')} يوقف. كل صفحة مكتملة تنحفظ، فأمر نفسه يكمّل من هناك.`,
        ),
      );
      return;
    }

    const stats = backfillStats(ctx.guildId);
    const total = countBackfillableChannels(ctx.guild);

    if (total === 0) {
      await ctx.reply(
        warnReply(
          'ما فيه شي ينستورد',
          'ما أشوف قنوات نصية فيها سجل رسائل مقروء. تأكد من صلاحيات **عرض القنوات** و**قراءة سجل الرسائل**، وبعدها جرّب.',
        ),
      );
      return;
    }

    if (total > 0 && stats.done >= total && stats.errors === 0) {
      await ctx.reply(
        warnReply(
          'الاستيراد مكتمل من قبل',
          `كل ${formatNumber(total)} قناة نصية انستوردت رجوعًا إلى ${stats.oldestAt ? formatDate(stats.oldestAt) : 'البداية'}.`,
        ),
      );
      return;
    }

    const result = startBackfill(client, ctx.guildId);

    if (!result.started) {
      await ctx.reply(
        warnReply(
          'يشتغل من قبل',
          result.reason === 'audit'
            ? 'الفحص الجاف يشتغل. انتظره أو ألغه بـ `/backfill cancel`.'
            : 'استخدم `/backfill status` عشان تتابع التقدّم أو `/backfill cancel` عشان توقفه.',
        ),
      );
      return;
    }

    await ctx.reply(
      okReply(
        'بدأ الاستيراد',
        [
          `يقرأ ${formatNumber(total)} قناة نصية رجوعًا من ${formatDate(trackingSince(ctx.guildId) ?? Date.now())}، وهي لحظة بداية العدّ المباشر.`,
          'الرسائل الأقدم من كذا بس تنضاف، فما ينحسب شي مرتين. الثريدات وسجل الصوت ما ينستوردون.',
          'يشتغل في الخلفية: `/backfill status` يعرض التقدّم، `/backfill cancel` يوقف بعد الصفحة الحالية، وإعادة التشغيل تكمّل من المؤشر المحفوظ لكل قناة.',
        ].join('\n\n'),
      ),
    );
  },
};
