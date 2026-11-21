import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import {
  PERIOD_CHOICES,
  formatNumber,
  formatPeriod,
  formatVoiceTime,
  relativeTime,
} from '../../lib/activity-format.js';
import { embed } from '../../lib/embeds.js';
import { errorReply, warnReply } from '../../lib/replies.js';
import { resolveUser } from '../../lib/resolve.js';
import { normalizeForMatch } from '../../lib/text.js';
import { memberStats, periodStart } from '../../services/activity-store.js';

const PERIODS = new Map([
  ['all', 'all'],
  ['كل', 'all'],
  ['7d', '7d'],
  ['7', '7d'],
  ['week', '7d'],
  ['اسبوع', '7d'],
  ['30d', '30d'],
  ['30', '30d'],
  ['month', '30d'],
  ['شهر', '30d'],
]);

function parsePrefix(args) {
  const tokens = [...args];
  let period = 'all';

  if (tokens.length > 2) {
    const key = normalizeForMatch(tokens[tokens.length - 1]);

    if (PERIODS.has(key)) {
      period = PERIODS.get(key);
      tokens.pop();
    }
  }

  if (tokens.length !== 2) {
    return { error: 'عطني عضوين بالضبط عشان أقارن.' };
  }

  return { period, tokens };
}

async function resolveCompared(ctx, client, token, option) {
  if (ctx.isSlash) {
    return ctx.getUser(option) ?? ctx.getMember(option)?.user ?? null;
  }

  return resolveUser(client, token, ctx.message);
}

/**
 * One stacked card per member. Discord does not resolve mentions inside field
 * names, so the header uses the display name and the values carry the numbers.
 */
function memberField(name, messages, voiceSeconds, lastActiveAt) {
  return {
    name: `\u200E${name}`,
    value: [
      `**الرسائل:** ${formatNumber(messages)}`,
      `**وقت الصوت:** ${formatVoiceTime(voiceSeconds)}`,
      `**آخر نشاط:** ${relativeTime(lastActiveAt)}`,
    ].join('\n'),
    inline: false,
  };
}

function memberName(ctx, user, option) {
  const member = ctx.isSlash
    ? ctx.getMember(option)
    : ctx.guild.members?.cache?.get(user.id);

  return member?.displayName ?? user.globalName ?? user.username ?? String(user.id);
}

export default {
  data: new SlashCommandBuilder()
    .setName('compare')
    .setDescription('قارن نشاط عضوين')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('first').setDescription('العضو الأول').setRequired(true),
    )
    .addUserOption((option) =>
      option.setName('second').setDescription('العضو الثاني').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('period')
        .setDescription('المدة (الافتراضي: كل الوقت)')
        .setRequired(false)
        .addChoices(...PERIOD_CHOICES),
    ),

  name: 'compare',
  aliases: ['versus', 'vs'],
  description: 'قارن نشاط عضوين',
  category: 'Activity',
  usage: 'compare <@member> <@member> [all|7d|30d]',
  cooldown: 5,
  guildOnly: true,

  async execute(ctx, client) {
    const parsed = ctx.isSlash ? null : parsePrefix(ctx.args);

    if (parsed?.error) {
      await ctx.fail(
        warnReply(
          'منو أقارن؟',
          `${parsed.error}\nاستخدم \`${ctx.isSlash ? '/compare first:@a second:@b' : ':-compare @a @b'} [all|7d|30d]\`.`,
        ),
      );
      return;
    }

    const period = ctx.isSlash ? ctx.getString('period') ?? 'all' : parsed.period;
    const [firstRef, secondRef] = parsed?.tokens ?? [null, null];

    const [first, second] = await Promise.all([
      resolveCompared(ctx, client, firstRef, 'first'),
      resolveCompared(ctx, client, secondRef, 'second'),
    ]);

    if (!first || !second) {
      await ctx.fail(
        errorReply(
          'عضو غير معروف',
          !first && !second
            ? 'ما لقيت أي واحد منهم. منشنهم أو الصق آيدياتهم.'
            : `ما لقيت ${!first ? 'العضو الأول' : 'العضو الثاني'}. منشنه أو الصق آيديه.`,
        ),
      );
      return;
    }

    if (first.id === second.id) {
      await ctx.fail(warnReply('نفس العضو', 'اختر عضوين مختلفين عشان تقارن.'));
      return;
    }

    const since = periodStart(period);
    const a = memberStats(ctx.guildId, first.id, since);
    const b = memberStats(ctx.guildId, second.id, since);
    const aMessages = since ? a.period.messages : a.messages;
    const bMessages = since ? b.period.messages : b.messages;
    const aVoice = since ? a.period.voiceSeconds : a.voiceSeconds;
    const bVoice = since ? b.period.voiceSeconds : b.voiceSeconds;

    if (aMessages === 0 && bMessages === 0 && aVoice === 0 && bVoice === 0) {
      await ctx.reply({
        content: warnReply(
          'ما فيه نشاط مسجّل',
          since
            ? `ما فيه نشاط لأي منهم في ${formatPeriod(period)}.`
            : 'ما فيه نشاط متابَع لأي منهم بعد.',
        ).content,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const aTag = `<@${first.id}>`;
    const bTag = `<@${second.id}>`;
    const aName = memberName(ctx, first, 'first');
    const bName = memberName(ctx, second, 'second');
    const leads = [];

    if (aMessages !== bMessages) {
      leads.push(
        `متقدّم في الرسائل: \u200E${aMessages > bMessages ? aTag : bTag}`,
      );
    }

    if (aVoice !== bVoice) {
      leads.push(`متقدّم في وقت الصوت: \u200E${aVoice > bVoice ? aTag : bTag}`);
    }

    await ctx.reply({
      embeds: [
        embed({
          title: 'مقارنة عضوين',
          description: leads.length ? leads.join('\n') : 'تعادل تام لين الحين.',
          fields: [
            memberField(aName, aMessages, aVoice, a.lastActiveAt),
            memberField(bName, bMessages, bVoice, b.lastActiveAt),
          ],
          footer: `${formatPeriod(period)} · آخر نشاط لكل الوقت`,
        }),
      ],
      allowedMentions: { parse: [] },
    });
  },
};
