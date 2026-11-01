import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { config } from '../config.js';
import { errorEmbed, infoEmbed } from '../lib/embeds.js';
import { createLogger } from '../lib/logger.js';
import { buildSummaryHtml } from './report-export.js';
import { glossaryPrompt } from './report-store.js';
import { renderSummary, summarizeTranscript } from './summary.js';
import { buildTranscript, collectRangeMessages } from './summary-source.js';

const logger = createLogger('report-runner');

export const EXPORT_TIMEOUT_MS = 5 * 60 * 1000;

export function exportButton(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`summary:export:${id}`)
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
 * Per-message collector: the button is bound to this report only, so nothing
 * global has to route it. Moderators and the requester may press it.
 */
export function attachExportButton({ message, summary, timeZone, ownerId }) {
  if (!message?.createMessageComponentCollector) return;

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: EXPORT_TIMEOUT_MS,
  });

  collector.on('collect', async (interaction) => {
    const canExport = interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages);

    if (!canExport && interaction.user.id !== ownerId) {
      await interaction
        .reply({
          embeds: [errorEmbed('Not allowed', 'Only moderators can export this.')],
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      return;
    }

    try {
      await interaction.reply({
        ...exportPayload(summary, timeZone),
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      logger.warn(`Export failed: ${error.message}`);
    }
  });

  collector.on('end', () => {
    message.edit({ components: [] }).catch(() => {});
  });
}

/**
 * Read → summarize. Everything that decides *what* a report says lives here,
 * so a manual run and a scheduled run cannot produce different shapes.
 * Returns `data: null` when the window had no messages.
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

  if (collected.messages.length === 0) return { data: null, collected, meta: null };

  const transcript = buildTranscript(collected.messages, { timeZone });
  const data = await summarizeTranscript({
    transcript,
    kind,
    prompt,
    glossary: glossaryPrompt(guildId),
    onProgress,
  });

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

/** Message payload for a finished report, including the export button. */
export function reportPayload({ data, meta, id, collected }) {
  const { embeds } = renderSummary({ data, meta });
  const notes = [];

  if (collected?.truncated) {
    notes.push(
      `Scanned the newest ${collected.scanned} messages only — narrow the window for full coverage.`,
    );
  }

  if (notes.length > 0) {
    embeds[embeds.length - 1].setFooter({ text: notes.join(' ').slice(0, 200) });
  }

  return {
    embeds,
    components: [exportButton(id)],
    allowedMentions: { parse: [] },
  };
}
