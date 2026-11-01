import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { COLORS, embed, errorEmbed, infoEmbed, successEmbed } from '../../lib/embeds.js';
import { createLogger } from '../../lib/logger.js';
import {
  MAX_TERMS_PER_USER,
  MAX_TERM_LENGTH,
  MIN_TERM_LENGTH,
  addWatchTerm,
  clearWatchTerms,
  countTerms,
  listUserTerms,
  removeWatchTerm,
} from '../../services/watch-store.js';
import { invalidateWatchCache } from '../../services/watch.js';

const logger = createLogger('watch');

const MAX_SHOWN = 20;

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

function extractTerm(ctx) {
  if (ctx.isSlash) return (ctx.getString('keyword') ?? '').trim();

  const [action, ...rest] = ctx.args;

  if (!['add', 'remove', 'delete', 'clear', 'list', 'test'].includes(action)) {
    return [action, ...rest].join(' ').trim();
  }

  return rest.join(' ').trim();
}

function listPayload(ctx) {
  const terms = listUserTerms(ctx.guildId, ctx.user.id);

  if (terms.length === 0) {
    return embed({
      title: 'No keywords yet',
      description:
        `Add one with \`${ctx.isSlash ? '/watch add keyword:' : ':-watch add '}your word\`.\n` +
        'When anyone says it in this server, I send you a DM with a jump link.',
      color: COLORS.muted,
    });
  }

  const broken = terms.some((term) => term.broken);
  const shown = terms.slice(0, MAX_SHOWN);
  const lines = shown.map((term) => `- \`${term.term}\`${term.broken ? ' ⚠️' : ''}`);

  if (terms.length > shown.length) lines.push(`…and ${terms.length - shown.length} more`);

  if (broken) {
    lines.push('', '⚠️ A DM could not be delivered. Allow **Direct Messages** from server members, then run `/watch test`.');
  }

  return embed({
    title: `Your keywords (${terms.length}/${MAX_TERMS_PER_USER})`,
    description: lines.join('\n'),
    footer: 'Alerts arrive as a DM with a jump link',
    color: COLORS.primary,
  });
}

async function handleAdd(ctx) {
  const term = extractTerm(ctx);

  if (term.length < MIN_TERM_LENGTH || term.length > MAX_TERM_LENGTH) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Invalid keyword',
            `Use ${MIN_TERM_LENGTH}–${MAX_TERM_LENGTH} characters, for example \`/watch add keyword:leak\`.`,
          ),
        ],
      }),
    );
    return;
  }

  const result = addWatchTerm(ctx.guildId, ctx.user.id, term);

  if (!result.added && result.reason === 'limit') {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Too many keywords',
            `You already watch ${countTerms(ctx.guildId, ctx.user.id)} words. Remove one first.`,
          ),
        ],
      }),
    );
    return;
  }

  if (!result.added && result.reason === 'duplicate') {
    await ctx.reply(
      ephemeral({ embeds: [infoEmbed('Already watching', `\`${term}\` is already on your list.`)] }),
    );
    return;
  }

  invalidateWatchCache(ctx.guildId);

  await ctx.reply(
    ephemeral({
      embeds: [
        successEmbed('Keyword added', `I will DM you when \`${term}\` appears anywhere in this server.`),
      ],
    }),
  );
}

async function handleRemove(ctx) {
  const term = extractTerm(ctx);

  if (!term) {
    await ctx.reply(
      ephemeral({
        embeds: [errorEmbed('Which keyword?', 'Use `/watch remove keyword:word` or `:-watch remove word`.')],
      }),
    );
    return;
  }

  const removed = removeWatchTerm(ctx.guildId, ctx.user.id, term);
  invalidateWatchCache(ctx.guildId);

  await ctx.reply(
    ephemeral({
      embeds: [
        removed > 0
          ? successEmbed('Keyword removed', `\`${term}\` is no longer watched.`)
          : infoEmbed('Not on your list', `You were not watching \`${term}\`.`),
      ],
    }),
  );
}

async function handleClear(ctx) {
  const removed = clearWatchTerms(ctx.guildId, ctx.user.id);
  invalidateWatchCache(ctx.guildId);

  await ctx.reply(
    ephemeral({
      embeds: [
        removed > 0
          ? successEmbed('Keywords cleared', `Removed ${removed} keyword${removed === 1 ? '' : 's'}.`)
          : infoEmbed('Nothing to clear', 'You were not watching any keywords.'),
      ],
    }),
  );
}

async function handleTest(ctx) {
  try {
    await ctx.user.send({
      embeds: [
        embed({
          title: 'Keyword alerts are working',
          description: 'This is how an alert will look. Every alert includes a link back to the message.',
          color: COLORS.success,
        }),
      ],
    });

    await ctx.reply(
      ephemeral({ embeds: [successEmbed('Check your DMs', 'The test message was delivered.')] }),
    );
  } catch (error) {
    logger.warn(`Watch test DM failed for ${ctx.user.id}: ${error.message}`);

    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Could not send a DM',
            'Enable **Direct Messages** in this server\'s Privacy Settings, then try again.',
          ),
        ],
      }),
    );
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName('watch')
    .setDescription('DM me when a keyword is mentioned anywhere in this server')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Watch a word or phrase')
        .addStringOption((option) =>
          option
            .setName('keyword')
            .setDescription('Word or short phrase')
            .setRequired(true)
            .setMinLength(MIN_TERM_LENGTH)
            .setMaxLength(MAX_TERM_LENGTH),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Stop watching a word')
        .addStringOption((option) =>
          option.setName('keyword').setDescription('Word to stop watching').setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Show your keywords'))
    .addSubcommand((sub) => sub.setName('clear').setDescription('Remove all your keywords'))
    .addSubcommand((sub) => sub.setName('test').setDescription('Send a test DM to check delivery')),

  name: 'watch',
  aliases: ['alert', 'keywords'],
  description: 'Get a DM when a keyword is mentioned anywhere in the server',
  category: 'Community',
  usage: 'watch add <keyword> | remove <keyword> | list | clear | test',
  cooldown: 3,
  guildOnly: true,

  async execute(ctx) {
    const sub = ctx.isSlash
      ? ctx.getSubcommand()
      : ['add', 'remove', 'delete', 'list', 'clear', 'test'].includes(ctx.args[0])
        ? ctx.args[0]
        : 'add';

    if (sub === 'add') return handleAdd(ctx);
    if (sub === 'remove' || sub === 'delete') return handleRemove(ctx);
    if (sub === 'clear') return handleClear(ctx);
    if (sub === 'test') return handleTest(ctx);

    await ctx.reply(ephemeral({ embeds: [listPayload(ctx)] }));
  },
};
