import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { formatDate, formatNumber } from '../../lib/activity-format.js';
import { embed } from '../../lib/embeds.js';
import { okReply, warnReply } from '../../lib/replies.js';
import { normalizeForMatch } from '../../lib/text.js';
import { countBackfillableChannels } from '../../services/activity-backfill.js';
import {
  cancelEmojiBackfill,
  currentEmojiBackfillJob,
  startEmojiBackfill,
} from '../../services/emoji-backfill.js';
import {
  emojiBackfillStats,
  emojiBackfilledSince,
  emojiTrackingSince,
  ensureEmojiTracking,
} from '../../services/emoji-store.js';

const ACTIONS = new Map([
  ['start', 'start'],
  ['resume', 'start'],
  ['status', 'status'],
  ['progress', 'status'],
  ['cancel', 'cancel'],
  ['stop', 'cancel'],
]);

function parseAction(ctx) {
  const raw = (ctx.isSlash ? ctx.getString('action') : ctx.args[0]) ?? 'status';
  return ACTIONS.get(normalizeForMatch(raw)) ?? null;
}

function stateOf(ctx) {
  const job = currentEmojiBackfillJob(ctx.guildId);
  const stats = emojiBackfillStats(ctx.guildId);
  const total = countBackfillableChannels(ctx.guild);
  const running = Boolean(job && !job.finishedAt);
  const channelTotal = Math.max(total, stats.channels);
  const done = Math.min(stats.done, channelTotal || stats.done);
  const handled = stats.done + stats.errors;

  let state = 'ما بدأ';

  if (running) state = job.cancelled ? 'يتوقف' : 'يشتغل';
  else if (channelTotal > 0 && handled >= channelTotal) {
    state = stats.errors === 0 ? 'مكتمل' : 'مكتمل مع تخطيات';
  } else if (stats.channels > 0) state = 'متوقف مؤقتًا';

  return { job, stats, total, running, channelTotal, done, state };
}

function statusPayload(ctx) {
  const { job, stats, running, channelTotal, done, state } = stateOf(ctx);

  const description = running
    ? 'يقرأ الرسائل القديمة في الخلفية ويحسب الإيموجيات المخصصة. التقدّم ينحفظ بعد كل صفحة.'
    : state === 'مكتمل'
      ? 'كل قناة نصية مقروءة انفحصت رجوعًا لبداية سيرفرك.'
      : state === 'مكتمل مع تخطيات'
        ? 'كل قناة مقروءة انفحصت. القنوات المتخطّاة تحتاج عادةً **قراءة سجل الرسائل**؛ صلّحها وشغّل `/emojibackfill start` عشان تعيد المحاولة.'
        : state === 'متوقف مؤقتًا'
          ? 'آخر تشغيل وقف بدري. `/emojibackfill start` يكمّل من المؤشر المحفوظ لكل قناة.'
          : 'الرسائل القديمة ما انفحصت لاستخدام الإيموجيات بعد. شغّل `/emojibackfill start` مرة واحدة.';

  return embed({
    title: 'استيراد الإيموجيات',
    description,
    fields: [
      { name: 'الحالة', value: state, inline: true },
      {
        name: 'القنوات',
        value: `${formatNumber(done)} / ${formatNumber(channelTotal)}`,
        inline: true,
      },
      {
        name: 'رسائل مفحوصة',
        value: formatNumber(stats.fetched),
        inline: true,
      },
      {
        name: 'استخدامات إيموجي',
        value: formatNumber(stats.emojiUses),
        inline: true,
      },
      {
        name: 'أقدم رسالة مفحوصة',
        value: stats.oldestAt ? formatDate(stats.oldestAt) : '—',
        inline: true,
      },
      {
        name: 'مستورد منذ',
        value: emojiBackfilledSince(ctx.guildId)
          ? formatDate(emojiBackfilledSince(ctx.guildId))
          : '—',
        inline: true,
      },
      {
        name: 'القناة الحالية',
        value: running && job.channelId ? `<#${job.channelId}>` : '—',
        inline: true,
      },
      {
        name: 'العدّ المباشر منذ',
        value: emojiTrackingSince(ctx.guildId)
          ? formatDate(emojiTrackingSince(ctx.guildId))
          : '—',
        inline: true,
      },
    ],
    footer: 'الاستخدام داخل الرسالة ولحاله ينحسبان منفصلين · /emojibackfill cancel يحفظ التقدّم',
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('emojibackfill')
    .setDescription('استورد الرسائل القديمة في إحصائيات استخدام الإيموجيات')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('action')
        .setDescription('اللي تبي تسويه (الافتراضي: الحالة)')
        .setRequired(false)
        .addChoices(
          { name: 'ابدأ', value: 'start' },
          { name: 'الحالة', value: 'status' },
          { name: 'إلغاء', value: 'cancel' },
        ),
    ),

  name: 'emojibackfill',
  aliases: ['importemojis', 'emojihistory'],
  description: 'استورد الرسائل القديمة في إحصائيات استخدام الإيموجيات',
  category: 'Activity',
  usage: 'emojibackfill [start|status|cancel]',
  cooldown: 10,
  guildOnly: true,
  ownerOnly: true,

  async execute(ctx, client) {
    const action = parseAction(ctx);

    if (!action) {
      await ctx.fail(
        warnReply(
          'إجراء غير معروف',
          `استخدم \`${ctx.isSlash ? '/emojibackfill' : ':-emojibackfill'} [start|status|cancel]\`.`,
        ),
      );
      return;
    }

    if (action === 'status') {
      await ctx.reply({ embeds: [statusPayload(ctx)] });
      return;
    }

    if (action === 'cancel') {
      const job = cancelEmojiBackfill(ctx.guildId);

      if (!job) {
        await ctx.reply(
          warnReply(
            'ما فيه شي يشتغل',
            'ابدأ استيراد بـ `/emojibackfill start`. التقدّم المحفوظ يبقى.',
          ),
        );
        return;
      }

      await ctx.reply(
        warnReply(
          'يتوقف',
          'الصفحة الحالية تخلص، بعدها استيراد الإيموجيات يوقف. كل صفحة مكتملة تنحفظ، فأمر نفسه يكمّل من هناك.',
        ),
      );
      return;
    }

    const { stats, total } = stateOf(ctx);

    if (total === 0) {
      await ctx.reply(
        warnReply(
          'ما فيه شي ينفحص',
          'ما أشوف قنوات نصية فيها سجل رسائل مقروء. تأكد من صلاحيات **عرض القنوات** و**قراءة سجل الرسائل**، وبعدها جرّب.',
        ),
      );
      return;
    }

    if (stats.done >= total && stats.errors === 0) {
      await ctx.reply(
        warnReply(
          'استيراد الإيموجيات مكتمل من قبل',
          `كل ${formatNumber(total)} قناة نصية انفحصت رجوعًا إلى ${stats.oldestAt ? formatDate(stats.oldestAt) : 'البداية'}.`,
        ),
      );
      return;
    }

    const since = ensureEmojiTracking(ctx.guildId, Date.now());
    const result = startEmojiBackfill(client, ctx.guildId);

    if (!result.started) {
      await ctx.reply(
        warnReply(
          'يشتغل من قبل',
          'استخدم `/emojibackfill status` عشان تتابع التقدّم أو `/emojibackfill cancel` عشان توقفه.',
        ),
      );
      return;
    }

    await ctx.reply(
      okReply(
        'بدأ استيراد الإيموجيات',
        [
          `يقرأ ${formatNumber(total)} قناة نصية رجوعًا من ${formatDate(since)}، وهي لحظة بداية العدّ المباشر للإيموجيات.`,
          'الرسائل الأقدم من كذا بس تنحسب، فما ينحسب شي مرتين. الاستخدام داخل الرسالة ولحاله ينحفظان منفصلين وينجمعان للترتيب.',
          'يشتغل في الخلفية: `/emojibackfill status` يعرض التقدّم، `/emojibackfill cancel` يوقف بعد الصفحة الحالية، وإعادة التشغيل تكمّل من المؤشر المحفوظ لكل قناة.',
        ].join('\n\n'),
      ),
    );
  },
};
