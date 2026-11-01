import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, embed, errorEmbed, infoEmbed, successEmbed } from '../../lib/embeds.js';
import {
  MAX_GLOSSARY_TERMS,
  MAX_MEANING_LENGTH,
  MAX_TERM_LENGTH,
  clearGlossary,
  listGlossary,
  removeGlossaryTerm,
  setGlossaryTerm,
} from '../../services/report-store.js';

const MAX_LISTED = 40;

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

async function requireManageGuild(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await ctx.reply(
    ephemeral({
      embeds: [
        errorEmbed('Missing permissions', 'You need **Manage Server** to change the glossary.'),
      ],
    }),
  );

  return false;
}

/** `term | meaning` in one prefix argument pair. */
function parsePrefixEntry(ctx) {
  const raw = ctx.args.join(' ').trim();
  const [term, ...rest] = raw.split('|');

  return { term: term?.trim() ?? '', meaning: rest.join('|').trim() };
}

async function handleAdd(ctx) {
  if (!(await requireManageGuild(ctx))) return;

  const entry = ctx.isSlash
    ? {
        term: (ctx.getString('term') ?? '').trim(),
        meaning: (ctx.getString('meaning') ?? '').trim(),
      }
    : parsePrefixEntry(ctx);

  if (!entry.term || entry.term.length > MAX_TERM_LENGTH) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Invalid term',
            `Give a term up to ${MAX_TERM_LENGTH} characters, plus a meaning separated by \`|\`.`,
          ),
        ],
      }),
    );
    return;
  }

  if (!entry.meaning || entry.meaning.length > MAX_MEANING_LENGTH) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Invalid meaning',
            `Explain the term in up to ${MAX_MEANING_LENGTH} characters, for example \`nap | the new event map\`.`,
          ),
        ],
      }),
    );
    return;
  }

  if (listGlossary(ctx.guildId).length >= MAX_GLOSSARY_TERMS) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed('Glossary is full', `Remove a term first (max ${MAX_GLOSSARY_TERMS}).`),
        ],
      }),
    );
    return;
  }

  setGlossaryTerm(ctx.guildId, entry.term, entry.meaning);

  await ctx.reply(
    ephemeral({
      embeds: [
        successEmbed(
          'Term saved',
          `\`${entry.term}\` → ${entry.meaning}\nSummaries will use this meaning from now on.`,
        ),
      ],
    }),
  );
}

async function handleRemove(ctx) {
  if (!(await requireManageGuild(ctx))) return;

  const term = (ctx.isSlash ? ctx.getString('term') : ctx.args.join(' '))?.trim() ?? '';

  if (!term) {
    await ctx.reply(ephemeral({ embeds: [errorEmbed('Which term?', 'Pass the term to remove.')] }));
    return;
  }

  const removed = removeGlossaryTerm(ctx.guildId, term);

  await ctx.reply(
    ephemeral({
      embeds: [
        removed > 0
          ? successEmbed('Term removed', `\`${term}\` is no longer in the glossary.`)
          : infoEmbed('Not found', `\`${term}\` was not in the glossary.`),
      ],
    }),
  );
}

async function handleClear(ctx) {
  if (!(await requireManageGuild(ctx))) return;

  const removed = clearGlossary(ctx.guildId);

  await ctx.reply(
    ephemeral({
      embeds: [
        removed > 0
          ? successEmbed('Glossary cleared', `Removed ${removed} term${removed === 1 ? '' : 's'}.`)
          : infoEmbed('Already empty', 'There were no glossary terms.'),
      ],
    }),
  );
}

async function handleList(ctx) {
  const terms = listGlossary(ctx.guildId);

  if (terms.length === 0) {
    await ctx.reply(
      ephemeral({
        embeds: [
          infoEmbed(
            'No terms yet',
            'Teach me your jargon with `/glossary add term:nap meaning:the new event map`.\nTerms are only used to help the summarizer understand the server.',
          ),
        ],
      }),
    );
    return;
  }

  const shown = terms.slice(0, MAX_LISTED);
  const lines = shown.map((entry) => `**${entry.term}** — ${entry.meaning}`);

  if (terms.length > shown.length) lines.push(`…and ${terms.length - shown.length} more`);

  await ctx.reply(
    ephemeral({
      embeds: [
        embed({
          title: `Glossary (${terms.length})`,
          description: lines.join('\n').slice(0, 4000),
          footer: 'Used as context for every summary',
          color: COLORS.primary,
        }),
      ],
    }),
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('glossary')
    .setDescription('Teach the summarizer your server jargon')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Add or update a term')
        .addStringOption((option) =>
          option
            .setName('term')
            .setDescription('The word or acronym')
            .setRequired(true)
            .setMaxLength(MAX_TERM_LENGTH),
        )
        .addStringOption((option) =>
          option
            .setName('meaning')
            .setDescription('What it means in this server')
            .setRequired(true)
            .setMaxLength(MAX_MEANING_LENGTH),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove a term')
        .addStringOption((option) =>
          option.setName('term').setDescription('Term to remove').setRequired(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Show every term'))
    .addSubcommand((sub) => sub.setName('clear').setDescription('Remove every term')),

  name: 'glossary',
  aliases: ['jargon'],
  description: 'Terms the summarizer should know about this server',
  category: 'Community',
  usage: 'glossary add <term> | <meaning> | remove <term> | list | clear',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ManageMessages'],

  async execute(ctx) {
    const sub = ctx.isSlash
      ? ctx.getSubcommand()
      : ['add', 'remove', 'delete', 'list', 'clear'].includes(ctx.args[0])
        ? ctx.args.shift()
        : 'list';

    if (sub === 'add') return handleAdd(ctx);
    if (sub === 'remove' || sub === 'delete') return handleRemove(ctx);
    if (sub === 'clear') return handleClear(ctx);

    return handleList(ctx);
  },
};
