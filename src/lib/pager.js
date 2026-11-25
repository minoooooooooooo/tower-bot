import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { createLogger } from './logger.js';

const logger = createLogger('pager');

/** How long the buttons stay live, matching /top and /rank. */
export const PAGER_TIMEOUT_MS = 10 * 60 * 1000;

/** Default rows per page. Every paged list uses the same size. */
export const PAGER_PAGE_SIZE = 10;

/** Splits rows into pages of `size`; an empty list still has one page. */
export function chunkPages(rows, size = PAGER_PAGE_SIZE) {
  const pages = [];

  for (let index = 0; index < rows.length; index += size) {
    pages.push(rows.slice(index, index + size));
  }

  return pages.length ? pages : [[]];
}

/** The five buttons /top uses: first, previous, page counter, next, last. */
export function pagerRow(id, page, pages) {
  const atStart = page <= 1;
  const atEnd = page >= pages;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${id}:first`)
      .setLabel('« الأول')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(atStart),
    new ButtonBuilder()
      .setCustomId(`${id}:prev`)
      .setLabel('‹ السابق')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(atStart),
    new ButtonBuilder()
      .setCustomId(`${id}:page`)
      .setLabel(`صفحة ${page} / ${pages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`${id}:next`)
      .setLabel('التالي ›')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(atEnd),
    new ButtonBuilder()
      .setCustomId(`${id}:last`)
      .setLabel('الأخير »')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(atEnd),
  );
}

/**
 * Adds the pager buttons to a payload. Extra rows (for example the store's
 * launch button) sit below the pager and still show when there is one page.
 */
export function withPager({ id, page, pages, payload, extraRows = [] }) {
  const rows = pages > 1 ? [pagerRow(id, page, pages), ...extraRows] : [...extraRows];

  if (rows.length > 0) payload.components = rows;

  return payload;
}

/**
 * Resolves the message the pager listens on. Slash replies are fetched because
 * `interaction.reply()` returns the interaction response, not a message.
 */
export async function pagerMessage(ctx, sent) {
  if (ctx.isSlash && ctx.interaction?.fetchReply) {
    return ctx.interaction.fetchReply().catch(() => null);
  }

  return sent ?? ctx.lastReply ?? null;
}

/**
 * Attaches the five-button collector to a sent message. `render(page)` builds
 * the payload for that page and may return null to leave the message alone.
 * Returns null when there is nothing to page through.
 */
export async function attachPager({ ctx, message, id, pages, page = 1, render }) {
  if (pages <= 1 || !message?.createMessageComponentCollector) return null;

  const state = { page: Math.min(Math.max(1, page), pages) };

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: PAGER_TIMEOUT_MS,
    // The store keeps a launch button on the same message; only pager ids are
    // ours to answer here.
    filter: (interaction) => String(interaction.customId).startsWith(`${id}:`),
  });

  collector.on('collect', async (interaction) => {
    const action = String(interaction.customId).slice(id.length + 1);

    if (action === 'first') state.page = 1;
    else if (action === 'last') state.page = pages;
    else if (action === 'next') state.page = Math.min(pages, state.page + 1);
    else if (action === 'prev') state.page = Math.max(1, state.page - 1);
    else {
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    const payload = render(state.page);

    if (!payload) {
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    // Most commands only rebuild the embed. Rebuild the buttons here too, or
    // the first/last/previous/next states stay frozen at the page they opened
    // on. A render that already supplied components (the store keeps its
    // launch button) keeps them.
    if (!payload.components) {
      payload.components = [pagerRow(id, state.page, pages)];
    }

    await interaction.update(payload).catch((error) => {
      logger.warn(`Could not update the "${id}" page: ${error.message}`);
    });
  });

  collector.on('end', () => {
    message.edit({ components: [] }).catch(() => {});
  });

  return state;
}
