import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { config } from '../config.js';
import { errorEmbed, infoEmbed } from '../lib/embeds.js';
import { createLogger } from '../lib/logger.js';
import { getGuildSettings } from './birthday-store.js';
import { buildSummaryHtml } from './report-export.js';
import { getSummary, glossaryPrompt } from './report-store.js';
import { isEmptySummary, renderSummary, summarizeTranscript } from './summary.js';
import { buildSpeakerRoster, buildTranscript, collectRangeMessages, resolveDisplayNames } from './summary-source.js';

const logger = createLogger('report-runner');

export const EXPORT_BUTTON_PREFIX = 'summary:export:';

export function exportButton(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${EXPORT_BUTTON_PREFIX}${id}`)
      .setLabel('Export as HTML')
      .setEmoji('📄')
      .setStyle(ButtonStyle.Secondary),
  );
}

function requesterLabel(createdBy) {
  return /^\d{17,20}$/.test(String(createdBy ?? '')) ? `<@${createdBy}>` : 'an automatic schedule';
}

export function exportPayload(summary, timeZone) {
  const { buffer, filename } = buildSummaryHtml({
    data: summary.body,
    meta: {
      kind: summary.kind,
      channelId: summary.channelId,
      channelName: null,
      messageCount: summary.messageCount,
      rangeStart: summary.rangeStart,
      rangeEnd: summary.rangeEnd,
      model: config.ai.model,
      requestedBy: requesterLabel(summary.createdBy),
      prompt: summary.prompt,
      timeZone,
      generatedAt: summary.createdAt,
    },
  });

  return {
    embeds: [
      infoEmbed(
        'Report exported',
        'The HTML file opens in any browser. Use **Print → Save as PDF** for a PDF copy.',
      ),
    ],
    files: [new AttachmentBuilder(buffer, { name: filename })],
  };
}

/**
 * The export button is routed globally from `interactionCreate`, not through a
 * per-message collector: a scheduled report is read hours later, and a five
 * minute collector (or a restart) would leave its button dead.
 */
export async function handleExportInteraction(interaction) {
  if (!interaction.guildId) {
    await interaction
      .reply({
        embeds: [errorEmbed('Not available here', 'Report export buttons only work inside the server.')],
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  const id = Number.parseInt(String(interaction.customId ?? '').split(':')[2], 10);

  if (!Number.isFinite(id)) {
    await interaction
      .reply({ embeds: [errorEmbed('Unknown report', 'That button is not valid.')], flags: MessageFlags.Ephemeral })
      .catch(() => {});
    return;
  }

  const summary = getSummary(interaction.guildId, id);

  if (!summary) {
    await interaction
      .reply({
        embeds: [
          errorEmbed('Report not found', 'This report is no longer stored, so it cannot be exported.'),
        ],
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  const isModerator = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages);
  const isOwner = String(summary.createdBy ?? '') === interaction.user?.id;

  if (!isModerator && !isOwner) {
    await interaction
      .reply({
        embeds: [errorEmbed('Not allowed', 'Only moderators or the person who scheduled this report can export it.')],
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  // The 07:00 report of 2026-11-02 was stored with an empty body before the
  // guard existed; exporting it would hand the user a blank file.
  if (isEmptySummary(summary.body)) {
    await interaction
      .reply({
        embeds: [
          errorEmbed(
            'Empty report',
            'That report was saved before the empty-report fix and contains nothing to export. The next scheduled run will post a real one.',
          ),
        ],
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
    return;
  }

  const timeZone =
    getGuildSettings(interaction.guildId)?.timezone ?? config.timezone;

  try {
    await interaction.reply({
      ...exportPayload(summary, timeZone),
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    logger.warn(`Export failed: ${error.message}`);
  }
}

/**
 * Read → summarize. Everything that decides *what* a report says lives here,
 * so a manual run and a scheduled run cannot produce different shapes.
 * Returns `data: null` when the window had no messages or the model found
 * nothing to report, with `reason` saying which — an empty report must never
 * be posted as a lone button.
 */
export async function produceSummary({
  guildId,
  channel,
  kind = 'general',
  prompt = null,
  since,
  until = Date.now(),
  timeZone = 'UTC',
  requestedBy = null,
  onProgress = null,
}) {
  const collected = await collectRangeMessages(channel, { since, until });

  if (collected.messages.length === 0) {
    return { data: null, collected, meta: null, reason: 'no-messages' };
  }

  // Nicknames are what the team calls each other; the raw handle is only there
  // so the model can tell that two spellings are one person.
  const names = await resolveDisplayNames(collected.messages, channel.guild, {
    maxFetches: 30,
  });
  const transcript = buildTranscript(collected.messages, { timeZone, names });
  const roster = buildSpeakerRoster(collected.messages, names);
  const data = await summarizeTranscript({
    transcript,
    kind,
    prompt,
    glossary: glossaryPrompt(guildId),
    roster,
    onProgress,
  });

  if (isEmptySummary(data)) {
    return { data: null, collected, meta: null, reason: 'empty-summary' };
  }

  return {
    data,
    collected,
    meta: {
      kind,
      channelId: channel.id,
      channelName: channel.name,
      messageCount: collected.messages.length,
      rangeStart: since,
      rangeEnd: until,
      model: config.ai.model,
      requestedBy,
      prompt: prompt || null,
      timeZone,
    },
  };
}

/**
 * Message payloads for a finished report. Discord's 6,000-character limit is
 * the **sum across every embed in one message**, not per embed, so a detailed
 * report is split into one message per embed. The export button rides on the
 * last message.
 */
export function reportPayloads({ data, meta, id, collected }) {
  const { embeds, truncated } = renderSummary({ data, meta });
  const notes = [];

  if (truncated) {
    notes.push('The report outgrew Discord\'s message limit — the export has the full text.');
  }

  if (collected?.truncated) {
    notes.push(
      `Scanned the newest ${collected.scanned} messages only — narrow the window for full coverage.`,
    );
  }

  if (notes.length > 0) {
    embeds[embeds.length - 1].setFooter({ text: notes.join(' ').slice(0, 200) });
  }

  return embeds.map((embed, index) => ({
    embeds: [embed],
    components: index === embeds.length - 1 ? [exportButton(id)] : [],
    allowedMentions: { parse: [] },
  }));
}
