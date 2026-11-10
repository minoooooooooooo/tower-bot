import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { formatDate, formatNumber } from '../../lib/activity-format.js';
import { embed, warningEmbed } from '../../lib/embeds.js';
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

  let state = 'Not started';

  if (running) state = job.cancelled ? 'Stopping' : 'Running';
  else if (channelTotal > 0 && handled >= channelTotal) {
    state = stats.errors === 0 ? 'Complete' : 'Complete with skips';
  } else if (stats.channels > 0) state = 'Paused';

  return { job, stats, total, running, channelTotal, done, state };
}

function statusPayload(ctx) {
  const { job, stats, running, channelTotal, done, state } = stateOf(ctx);

  const description = running
    ? 'Reading older messages in the background and counting custom emojis. Progress is saved after every page.'
    : state === 'Complete'
      ? 'Every readable text channel has been scanned back to your server’s beginning.'
      : state === 'Complete with skips'
        ? 'Every readable channel was scanned. The skipped channels usually need Read Message History; fix that and run `/emojibackfill start` to retry them.'
        : state === 'Paused'
          ? 'The last run stopped early. `/emojibackfill start` continues from each channel’s saved cursor.'
          : 'Older messages have not been scanned for emoji usage yet. Run `/emojibackfill start` once.';

  return embed({
    title: 'Emoji backfill',
    description,
    fields: [
      { name: 'State', value: state, inline: true },
      {
        name: 'Channels',
        value: `${formatNumber(done)} / ${formatNumber(channelTotal)}`,
        inline: true,
      },
      {
        name: 'Messages scanned',
        value: formatNumber(stats.fetched),
        inline: true,
      },
      {
        name: 'Emoji uses found',
        value: formatNumber(stats.emojiUses),
        inline: true,
      },
      {
        name: 'Oldest scanned',
        value: stats.oldestAt ? formatDate(stats.oldestAt) : '—',
        inline: true,
      },
      {
        name: 'Backfilled since',
        value: emojiBackfilledSince(ctx.guildId)
          ? formatDate(emojiBackfilledSince(ctx.guildId))
          : '—',
        inline: true,
      },
      {
        name: 'Current channel',
        value: running && job.channelId ? `<#${job.channelId}>` : '—',
        inline: true,
      },
      {
        name: 'Live since',
        value: emojiTrackingSince(ctx.guildId)
          ? formatDate(emojiTrackingSince(ctx.guildId))
          : '—',
        inline: true,
      },
    ],
    footer: 'Inline and standalone uses are counted separately · /emojibackfill cancel keeps saved progress',
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('emojibackfill')
    .setDescription('Import older messages into the emoji usage stats')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('action')
        .setDescription('What to do (default: status)')
        .setRequired(false)
        .addChoices(
          { name: 'Start', value: 'start' },
          { name: 'Status', value: 'status' },
          { name: 'Cancel', value: 'cancel' },
        ),
    ),

  name: 'emojibackfill',
  aliases: ['importemojis', 'emojihistory'],
  description: 'Import older messages into the emoji usage stats',
  category: 'Activity',
  usage: 'emojibackfill [start|status|cancel]',
  cooldown: 10,
  guildOnly: true,
  ownerOnly: true,

  async execute(ctx, client) {
    const action = parseAction(ctx);

    if (!action) {
      await ctx.fail({
        embeds: [
          warningEmbed(
            'Unknown action',
            `Use \`${ctx.isSlash ? '/emojibackfill' : ':-emojibackfill'} [start|status|cancel]\`.`,
          ),
        ],
      });
      return;
    }

    if (action === 'status') {
      await ctx.reply({ embeds: [statusPayload(ctx)] });
      return;
    }

    if (action === 'cancel') {
      const job = cancelEmojiBackfill(ctx.guildId);

      if (!job) {
        await ctx.reply({
          embeds: [
            warningEmbed(
              'Nothing is running',
              'Start an import with `/emojibackfill start`. Saved progress is kept.',
            ),
          ],
        });
        return;
      }

      await ctx.reply({
        embeds: [
          embed({
            title: 'Stopping',
            description:
              'The current page finishes, then the emoji import stops. Every completed page is saved, so the same command resumes from there.',
          }),
        ],
      });
      return;
    }

    const { stats, total } = stateOf(ctx);

    if (total === 0) {
      await ctx.reply({
        embeds: [
          warningEmbed(
            'Nothing to scan',
            'I cannot see any text channels with readable message history. Check my View Channel and Read Message History permissions, then try again.',
          ),
        ],
      });
      return;
    }

    if (stats.done >= total && stats.errors === 0) {
      await ctx.reply({
        embeds: [
          warningEmbed(
            'Emoji backfill already complete',
            `All ${formatNumber(total)} text channels were scanned back to ${stats.oldestAt ? formatDate(stats.oldestAt) : 'the beginning'}.`,
          ),
        ],
      });
      return;
    }

    const since = ensureEmojiTracking(ctx.guildId, Date.now());
    const result = startEmojiBackfill(client, ctx.guildId);

    if (!result.started) {
      await ctx.reply({
        embeds: [
          warningEmbed(
            'Already running',
            'Use `/emojibackfill status` to watch progress or `/emojibackfill cancel` to stop it.',
          ),
        ],
      });
      return;
    }

    await ctx.reply({
      embeds: [
        embed({
          title: 'Emoji backfill started',
          description: [
            `Reading ${formatNumber(total)} text channel(s) backwards from ${formatDate(since)}, which is when live emoji counting began.`,
            'Only messages older than that are counted, so nothing is counted twice. In-message and standalone emoji uses are stored separately and added for the leaderboard.',
            'It runs in the background: `/emojibackfill status` shows progress, `/emojibackfill cancel` stops after the current page, and a restart resumes from the saved per-channel cursor.',
          ].join('\n\n'),
          footer: 'This can take a while on a large server',
        }),
      ],
    });
  },
};
