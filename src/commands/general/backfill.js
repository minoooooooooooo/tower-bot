import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { formatDate, formatNumber } from '../../lib/activity-format.js';
import { embed, warningEmbed } from '../../lib/embeds.js';
import { normalizeForMatch } from '../../lib/text.js';
import {
  cancelBackfill,
  countBackfillableChannels,
  currentBackfillJob,
  startBackfill,
} from '../../services/activity-backfill.js';
import {
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
  ['cancel', 'cancel'],
  ['stop', 'cancel'],
]);

function parseAction(ctx) {
  const raw = (ctx.isSlash ? ctx.getString('action') : ctx.args[0]) ?? 'status';
  return ACTIONS.get(normalizeForMatch(raw)) ?? null;
}

function statusPayload(ctx) {
  const job = currentBackfillJob(ctx.guildId);
  const stats = backfillStats(ctx.guildId);
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

  const description = running
    ? 'Reading older messages in the background. Progress is saved after every page.'
    : state === 'Complete'
      ? 'Every text channel has been read back to your server’s beginning.'
      : state === 'Complete with skips'
        ? 'Every readable channel was imported. The skipped channels usually need Read Message History; fix that and run `/backfill start` to retry them.'
        : state === 'Paused'
          ? 'The last run stopped early. `/backfill start` continues from each channel’s saved cursor.'
          : 'Older messages have not been imported. Run `/backfill start` once.';

  return embed({
    title: 'Activity backfill',
    description,
    fields: [
      { name: 'State', value: state, inline: true },
      {
        name: 'Channels',
        value: `${formatNumber(done)} / ${formatNumber(channelTotal)}`,
        inline: true,
      },
      {
        name: 'Messages imported',
        value: formatNumber(stats.fetched),
        inline: true,
      },
      {
        name: 'Oldest imported',
        value: stats.oldestAt ? formatDate(stats.oldestAt) : '—',
        inline: true,
      },
      {
        name: 'Skipped channels',
        value: formatNumber(stats.errors),
        inline: true,
      },
      {
        name: 'Current channel',
        value: running && job.channelId ? `<#${job.channelId}>` : '—',
        inline: true,
      },
      {
        name: 'Messages since',
        value: formatDate(messagesSince(ctx.guildId)),
        inline: true,
      },
      {
        name: 'Voice since',
        value: formatDate(voiceSince(ctx.guildId)),
        inline: true,
      },
    ],
    footer: 'Voice history cannot be backfilled · /backfill cancel keeps saved progress',
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('backfill')
    .setDescription('Import older message history into activity stats')
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

  name: 'backfill',
  aliases: ['importactivity', 'historyimport'],
  description: 'Import older message history into activity stats',
  category: 'Activity',
  usage: 'backfill [start|status|cancel]',
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
            `Use \`${ctx.isSlash ? '/backfill' : ':-backfill'} [start|status|cancel]\`.`,
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
      const job = cancelBackfill(ctx.guildId);

      if (!job) {
        await ctx.reply({
          embeds: [
            warningEmbed(
              'Nothing is running',
              'Start an import with `/backfill start`. Saved progress is kept.',
            ),
          ],
        });
        return;
      }

      await ctx.reply({
        embeds: [
          embed({
            title: 'Stopping backfill',
            description:
              'The current page finishes, then the import stops. Every completed page is saved, so `/backfill start` resumes from there.',
          }),
        ],
      });
      return;
    }

    const stats = backfillStats(ctx.guildId);
    const total = countBackfillableChannels(ctx.guild);

    if (total === 0) {
      await ctx.reply({
        embeds: [
          warningEmbed(
            'Nothing to import',
            'I cannot see any text channels with readable message history. Check my View Channel and Read Message History permissions, then try again.',
          ),
        ],
      });
      return;
    }

    if (total > 0 && stats.done >= total && stats.errors === 0) {
      await ctx.reply({
        embeds: [
          warningEmbed(
            'Backfill already complete',
            `All ${formatNumber(total)} text channels were imported back to ${stats.oldestAt ? formatDate(stats.oldestAt) : 'the beginning'}.`,
          ),
        ],
      });
      return;
    }

    const result = startBackfill(client, ctx.guildId);

    if (!result.started) {
      await ctx.reply({
        embeds: [
          warningEmbed(
            'Already running',
            'Use `/backfill status` to watch progress or `/backfill cancel` to stop it.',
          ),
        ],
      });
      return;
    }

    await ctx.reply({
      embeds: [
        embed({
          title: 'Backfill started',
          description: [
            `Reading ${formatNumber(total)} text channel(s) backwards from ${formatDate(trackingSince(ctx.guildId) ?? Date.now())}, which is when live tracking began.`,
            'Only messages older than that are added, so nothing is counted twice. Threads and voice history cannot be backfilled.',
            'It runs in the background: `/backfill status` shows progress, `/backfill cancel` stops after the current page, and a restart resumes from the saved per-channel cursor.',
          ].join('\n\n'),
          footer: 'This can take a while on a large server',
        }),
      ],
    });
  },
};
