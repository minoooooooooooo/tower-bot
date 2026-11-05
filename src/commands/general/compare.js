import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import {
  PERIOD_CHOICES,
  formatNumber,
  formatPeriod,
  formatVoiceTime,
  relativeTime,
} from '../../lib/activity-format.js';
import { errorEmbed, embed, warningEmbed } from '../../lib/embeds.js';
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
    return { error: 'Give exactly two members to compare.' };
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
 * One stacked card per member. The old side-by-side fields squeezed two names
 * and four numbers into half a width each; a full-width field per member keeps
 * the numbers scannable and gives long Arabic names room to breathe.
 */
function memberField(tag, messages, voiceSeconds, lastActiveAt) {
  return {
    name: `\u200E${tag}`,
    value: [
      `**Messages:** ${formatNumber(messages)}`,
      `**Voice time:** ${formatVoiceTime(voiceSeconds)}`,
      `**Last active:** ${relativeTime(lastActiveAt)}`,
    ].join('\n'),
    inline: false,
  };
}

export default {
  data: new SlashCommandBuilder()
    .setName('compare')
    .setDescription('Compare two members’ activity')
    .setContexts(InteractionContextType.Guild)
    .addUserOption((option) =>
      option.setName('first').setDescription('First member').setRequired(true),
    )
    .addUserOption((option) =>
      option.setName('second').setDescription('Second member').setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('period')
        .setDescription('Time window (default: all time)')
        .setRequired(false)
        .addChoices(...PERIOD_CHOICES),
    ),

  name: 'compare',
  aliases: ['versus', 'vs'],
  description: 'Compare two members’ activity',
  category: 'Activity',
  usage: 'compare <@member> <@member> [all|7d|30d]',
  cooldown: 5,
  guildOnly: true,

  async execute(ctx, client) {
    const parsed = ctx.isSlash ? null : parsePrefix(ctx.args);

    if (parsed?.error) {
      await ctx.fail({
        embeds: [
          warningEmbed(
            'Who should I compare?',
            `${parsed.error}\nUse \`${ctx.isSlash ? '/compare first:@a second:@b' : ':-compare @a @b'} [all|7d|30d]\`.`,
          ),
        ],
      });
      return;
    }

    const period = ctx.isSlash ? ctx.getString('period') ?? 'all' : parsed.period;
    const [firstRef, secondRef] = parsed?.tokens ?? [null, null];

    const [first, second] = await Promise.all([
      resolveCompared(ctx, client, firstRef, 'first'),
      resolveCompared(ctx, client, secondRef, 'second'),
    ]);

    if (!first || !second) {
      await ctx.fail({
        embeds: [
          errorEmbed(
            'Unknown member',
            !first && !second
              ? 'I could not find either member. Mention them or paste their ids.'
              : `I could not find ${!first ? 'the first member' : 'the second member'}. Mention them or paste an id.`,
          ),
        ],
      });
      return;
    }

    if (first.id === second.id) {
      await ctx.fail({
        embeds: [warningEmbed('Same member', 'Pick two different members to compare.')],
      });
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
        embeds: [
          warningEmbed(
            'No activity recorded',
            `Neither member has ${since ? `activity in the ${formatPeriod(period).toLowerCase()}` : 'tracked activity yet'}.`,
          ),
        ],
        allowedMentions: { parse: [] },
      });
      return;
    }

    const aTag = `<@${first.id}>`;
    const bTag = `<@${second.id}>`;
    const leads = [];

    if (aMessages !== bMessages) {
      leads.push(
        `\u200E${aMessages > bMessages ? aTag : bTag} leads in messages`,
      );
    }

    if (aVoice !== bVoice) {
      leads.push(`\u200E${aVoice > bVoice ? aTag : bTag} leads in voice time`);
    }

    await ctx.reply({
      embeds: [
        embed({
          title: 'Member comparison',
          description: [
            `\u200E${aTag} vs ${bTag}`,
            leads.length ? leads.join(' · ') : 'Dead heat so far.',
          ].join('\n'),
          fields: [
            memberField(aTag, aMessages, aVoice, a.lastActiveAt),
            memberField(bTag, bMessages, bVoice, b.lastActiveAt),
          ],
          footer: period
            ? `${formatPeriod(period)} · last active is all-time`
            : formatPeriod(period),
        }),
      ],
      allowedMentions: { parse: [] },
    });
  },
};
