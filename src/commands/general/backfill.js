import { InteractionContextType, SlashCommandBuilder } from 'discord.js';
import { formatDate, formatNumber } from '../../lib/activity-format.js';
import { embed, warningEmbed } from '../../lib/embeds.js';
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

function auditPayload(ctx) {
  const job = currentAuditJob(ctx.guildId);
  const stats = auditStats(ctx.guildId);
  const imported = backfillStats(ctx.guildId).fetched;
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

  const matches =
    imported > 0 && stats.human === imported
      ? 'It matches the imported total exactly.'
      : `The importer recorded ${formatNumber(imported)}.`;

  const description = running
    ? 'Scanning every fetched message. Nothing is written to the activity totals.'
    : state === 'Complete' || state === 'Complete with skips'
      ? `Dry run finished. ${matches}`
      : state === 'Paused'
        ? 'The last audit stopped early. `/backfill audit` continues from each saved cursor.'
        : 'No dry run has been recorded yet. `/backfill audit` starts one.';

  return embed({
    title: 'Backfill audit · dry run',
    description,
    fields: [
      { name: 'State', value: state, inline: true },
      {
        name: 'Channels',
        value: `${formatNumber(done)} / ${formatNumber(channelTotal)}`,
        inline: true,
      },
      { name: 'Seen', value: formatNumber(stats.seen), inline: true },
      {
        name: 'Human · importable',
        value: formatNumber(stats.human),
        inline: true,
      },
      {
        name: 'Bots / webhooks',
        value: formatNumber(stats.bots),
        inline: true,
      },
      {
        name: 'System messages',
        value: formatNumber(stats.system),
        inline: true,
      },
      {
        name: 'Live window · human',
        value: formatNumber(stats.newer),
        inline: true,
      },
      {
        name: 'Oldest scanned',
        value: stats.oldestAt ? formatDate(stats.oldestAt) : '—',
        inline: true,
      },
      {
        name: 'Imported by backfill',
        value: formatNumber(imported),
        inline: true,
      },
      {
        name: 'Current channel',
        value: running && job.channelId ? `<#${job.channelId}>` : '—',
        inline: true,
      },
    ],
    footer: 'Dry run only · totals unchanged · threads are not scanned',
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
          { name: 'Audit (dry run)', value: 'audit' },
          { name: 'Cancel', value: 'cancel' },
        ),
    ),

  name: 'backfill',
  aliases: ['importactivity', 'historyimport'],
  description: 'Import older message history into activity stats',
  category: 'Activity',
  usage: 'backfill [start|status|audit|cancel]',
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
            `Use \`${ctx.isSlash ? '/backfill' : ':-backfill'} [start|status|audit|cancel]\`.`,
          ),
        ],
      });
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
        await ctx.reply({
          embeds: [
            warningEmbed(
              'Nothing to scan',
              'I cannot see any text channels with readable message history. Check my View Channel and Read Message History permissions.',
            ),
          ],
        });
        return;
      }

      const result = startAudit(client, ctx.guildId);

      if (!result.started) {
        await ctx.reply({
          embeds: [
            warningEmbed(
              'Already running',
              result.reason === 'import'
                ? 'The message import is still running. Wait for it or `/backfill cancel` it first.'
                : 'The audit is already running. `/backfill status` shows progress.',
            ),
          ],
        });
        return;
      }

      await ctx.reply({
        embeds: [
          embed({
            title: 'Backfill audit started',
            description: [
              `Scanning ${formatNumber(total)} text channel(s) newest-first and classifying every message as human, bot/webhook, system or live-window.`,
              'This is a dry run: activity totals are not changed. Threads are not scanned.',
              '`/backfill status` shows the report; `/backfill cancel` stops after the current page and keeps the saved cursor.',
            ].join('\n\n'),
            footer: 'The report compares the human count with the imported total',
          }),
        ],
      });
      return;
    }

    if (action === 'cancel') {
      const importJob = cancelBackfill(ctx.guildId);
      const auditJob = cancelAudit(ctx.guildId);

      if (!importJob && !auditJob) {
        await ctx.reply({
          embeds: [
            warningEmbed(
              'Nothing is running',
              'Start an import with `/backfill start` or a dry run with `/backfill audit`. Saved progress is kept.',
            ),
          ],
        });
        return;
      }

      const stopped = [
        importJob ? 'the message import' : null,
        auditJob ? 'the dry-run audit' : null,
      ].filter(Boolean);

      await ctx.reply({
        embeds: [
          embed({
            title: 'Stopping',
            description: `The current page finishes, then ${stopped.join(' and ')} stops. Every completed page is saved, so the same command resumes from there.`,
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
            result.reason === 'audit'
              ? 'The dry-run audit is running. Wait for it or `/backfill cancel` it first.'
              : 'Use `/backfill status` to watch progress or `/backfill cancel` to stop it.',
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
