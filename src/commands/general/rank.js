import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  InteractionContextType,
  SlashCommandBuilder,
} from 'discord.js';
import { formatNumber, rankBadge } from '../../lib/activity-format.js';
import { embed, warningEmbed } from '../../lib/embeds.js';
import { createLogger } from '../../lib/logger.js';
import { linkedPoints } from '../../services/ebot-vex.js';
import { rankedProfiles } from '../../services/profile-store.js';

const logger = createLogger('rank');

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 25;
const PAGER_TIMEOUT_MS = 10 * 60 * 1000;

/** Every current member, because linked points can rank someone without a row. */
async function currentMemberIds(guild) {
  const cache = guild.members.cache;
  const total = guild.memberCount ?? cache.size;

  if (cache.size >= total) return [...cache.keys()];

  try {
    const members = await guild.members.fetch();
    return [...members.keys()];
  } catch {
    return [...cache.keys()];
  }
}

function parsePageSize(ctx) {
  if (ctx.isSlash) {
    return Math.max(1, Math.min(MAX_PAGE_SIZE, ctx.getInteger('per_page') ?? DEFAULT_PAGE_SIZE));
  }

  const token = ctx.args[0];

  if (token === undefined) return DEFAULT_PAGE_SIZE;
  if (!/^\d+$/.test(String(token))) return null;

  return Math.max(1, Math.min(MAX_PAGE_SIZE, Number(token)));
}

function pagerRow(page, pages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('rank:first')
      .setLabel('« First')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId('rank:prev')
      .setLabel('‹ Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId('rank:page')
      .setLabel(`Page ${page} / ${pages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId('rank:next')
      .setLabel('Next ›')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pages),
    new ButtonBuilder()
      .setCustomId('rank:last')
      .setLabel('Last »')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= pages),
  );
}

/**
 * One page of the level leaderboard. The leading LRM keeps the rank column on
 * the left even when a member's display name starts with Arabic text.
 */
function buildPage(rows, state) {
  if (rows.length === 0) return null;

  const pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
  const page = Math.min(Math.max(1, state.page), pages);
  const start = (page - 1) * state.pageSize;

  const lines = rows.slice(start, start + state.pageSize).map(
    (row, index) =>
      `\u200E${rankBadge(start + index)} <@${row.userId}>\u200E — ` +
      `Level **${row.level}** · Vex **${formatNumber(row.vex)}** · ` +
      `Nightmare **${formatNumber(row.nightmare)}**`,
  );

  const payload = {
    embeds: [
      embed({
        title: 'Member levels',
        description: lines.join('\n'),
        footer: [
          'Ordered by level · Vex + Nightmare',
          pages > 1 ? `Page ${page} / ${pages}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
        timestamp: false,
      }),
    ],
    allowedMentions: { parse: [] },
  };

  if (pages > 1) payload.components = [pagerRow(page, pages)];

  return { payload, page, pages };
}

function attachPager({ message, rows, state }) {
  if (!message?.createMessageComponentCollector) return;

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: PAGER_TIMEOUT_MS,
  });

  collector.on('collect', async (interaction) => {
    const action = String(interaction.customId).split(':')[1];
    const built = buildPage(rows, state);

    if (!built) {
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    if (action === 'first') state.page = 1;
    else if (action === 'last') state.page = built.pages;
    else if (action === 'next') state.page = built.page + 1;
    else if (action === 'prev') state.page = built.page - 1;

    const next = buildPage(rows, state);

    if (!next) {
      await interaction.deferUpdate().catch(() => {});
      return;
    }

    await interaction.update(next.payload).catch((error) => {
      logger.warn(`Could not update the rank page: ${error.message}`);
    });
  });

  collector.on('end', () => {
    message.edit({ components: [] }).catch(() => {});
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Rank members by level, Vex and Nightmare points')
    .setContexts(InteractionContextType.Guild)
    .addIntegerOption((option) =>
      option
        .setName('per_page')
        .setDescription('Members per page (1–25, default 10)')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(MAX_PAGE_SIZE),
    ),

  name: 'rank',
  // `rank` is already a prefix alias of /top, so this command deliberately
  // does not claim it: `:-rank` keeps running /top. Use `:-levels` or `:-ranks`.
  aliases: ['levels', 'levelboard', 'ranks'],
  description: 'Rank members by level, Vex and Nightmare points',
  category: 'Profile',
  usage: 'rank [per page]',
  cooldown: 5,
  guildOnly: true,

  async execute(ctx, client) {
    const pageSize = parsePageSize(ctx);

    if (!pageSize) {
      await ctx.fail({
        embeds: [
          warningEmbed(
            'Invalid page size',
            `Use a number from 1 to ${MAX_PAGE_SIZE}, for example ` +
              `\`${ctx.isSlash ? '/rank per_page:10' : ':-levels 10'}\`.`,
          ),
        ],
      });
      return;
    }

    // The linked bots and a full member fetch can exceed Discord's three-second
    // acknowledgement window, so acknowledge before reading them.
    if (ctx.isSlash) await ctx.defer();

    const [memberIds, linked] = await Promise.all([
      currentMemberIds(ctx.guild),
      linkedPoints(client, ctx.guildId),
    ]);
    const rows = rankedProfiles(ctx.guildId, memberIds, linked);
    const state = { page: 1, pageSize };
    const built = buildPage(rows, state);

    if (!built) {
      await ctx.reply({
        embeds: [
          warningEmbed(
            'No ranked members yet',
            'Levels come from Vex and Nightmare points. Staff can add them with ' +
              `\`${ctx.isSlash ? '/profile-edit' : ':-profile-edit'}\`, and the linked ` +
              'bots contribute automatically.',
          ),
        ],
        allowedMentions: { parse: [] },
      });
      return;
    }

    // After a slash defer this is the follow-up message; for prefix it is the
    // reply. Both are real messages, so the pager can attach to either.
    const sent = await ctx.reply(built.payload);

    if (!built.payload.components) return;

    attachPager({ message: sent, rows, state });
  },
};
