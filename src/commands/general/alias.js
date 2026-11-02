import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from '../../config.js';
import { COLORS, embed, errorEmbed, successEmbed } from '../../lib/embeds.js';
import {
  MAX_ALIASES,
  MAX_TRIGGER_LENGTH,
  countAliases,
  getAlias,
  listAliases,
  normalizeTrigger,
  removeAlias,
  saveAlias,
} from '../../services/alias-store.js';

// Letters, marks (Arabic diacritics), digits, underscore and dash. Anything
// else (mentions, punctuation, emoji) would make matching ambiguous or hijack
// messages in odd ways.
const TRIGGER_PATTERN = /^[\p{L}\p{M}\p{N}_-]+$/u;

// Words that start a huge share of ordinary sentences. An alias on one of
// these runs the command on messages that were never meant as commands, so the
// admin gets a warning instead of surprise moderation.
const COMMON_WORDS = new Set(
  [
    'من', 'في', 'على', 'الي', 'عن', 'مع', 'هذا', 'هذه', 'هو', 'هي', 'لا', 'نعم',
    'ما', 'ان', 'انه', 'كان', 'يا', 'او', 'كل', 'بس', 'شو', 'ليش', 'كيف', 'وين',
    'متى', 'انا', 'انت', 'انتي', 'احنا', 'هم', 'لازم', 'بدي', 'ابي', 'اريد',
    'the', 'a', 'an', 'to', 'is', 'are', 'i', 'we', 'you',
  ].map(normalizeTrigger),
);

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

async function requireManageGuild(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await ctx.reply(
    ephemeral({
      embeds: [errorEmbed('Missing permissions', 'You need **Manage Server** to change aliases.')],
    }),
  );

  return false;
}

function cleanCommandInput(value) {
  let text = String(value ?? '').trim();

  if (config.prefix && text.startsWith(config.prefix)) {
    text = text.slice(config.prefix.length);
  }

  if (text.startsWith('/') || text.startsWith('!')) text = text.slice(1);

  return text.trim().toLowerCase();
}

/** `مسح` is valid; `مسح 100`, `@here` and a 40-character word are not. */
function validateTrigger(value, client) {
  const label = String(value ?? '').trim();

  if (!label) {
    return { error: 'Give the word you want to type, for example `مسح`.' };
  }

  if (label.length > MAX_TRIGGER_LENGTH) {
    return { error: `Keep the word under ${MAX_TRIGGER_LENGTH} characters.` };
  }

  if (/\s/.test(label)) {
    return { error: 'An alias is one word — everything after it becomes the command arguments.' };
  }

  if (!TRIGGER_PATTERN.test(label)) {
    return { error: 'Use letters, numbers, `_` or `-` only — no emoji, mentions or punctuation.' };
  }

  const name = label.toLowerCase();

  if (client.commands.has(name) || client.aliases.has(name)) {
    return {
      error: `\`${label}\` is already a command name. Run it as \`${config.prefix}${label}\` instead.`,
    };
  }

  return { label };
}

function resolveCommand(client, value) {
  const name = cleanCommandInput(value);
  if (!name) return null;

  return client.commands.get(client.aliases.get(name) ?? name) ?? null;
}

/** `clear <amount> [user]` becomes `مسح <amount> [user]`. */
function usageFor(alias, command) {
  const usage = command.usage ?? command.name;
  const rest = usage.startsWith(command.name) ? usage.slice(command.name.length) : usage;
  return `${alias}${rest}`.replace(/\s+/g, ' ').trim();
}

function describeAdd({ alias, command, updated }) {
  const lines = [
    `Typing **${alias.label}** now runs \`${command.name}\`.`,
    `Usage: \`${usageFor(alias.label, command)}\``,
    `Only members who can already use \`${command.name}\` will trigger it — everyone else is ignored.`,
  ];

  if (COMMON_WORDS.has(normalizeTrigger(alias.label))) {
    lines.push(
      '',
      `⚠️ **${alias.label}** is a very common word, so any message that starts with it runs the command. ` +
        'A distinctive word is safer.',
    );
  }

  return successEmbed(updated ? 'Alias updated' : 'Alias saved', lines.join('\n'));
}

async function handleAdd(ctx, client) {
  if (!(await requireManageGuild(ctx))) return;

  const triggerInput = ctx.isSlash ? ctx.getString('trigger') : ctx.args[1];
  const commandInput = ctx.isSlash ? ctx.getString('command') : ctx.args[2];

  if (!ctx.isSlash && ctx.args.length > 3) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'One word only',
            `Usage: \`${config.prefix}alias add <word> <command>\` — for example \`${config.prefix}alias add مسح clear\`.`,
          ),
        ],
      }),
    );
    return;
  }

  const trigger = validateTrigger(triggerInput, client);

  if (trigger.error) {
    await ctx.reply(ephemeral({ embeds: [errorEmbed('Invalid word', trigger.error)] }));
    return;
  }

  const command = resolveCommand(client, commandInput);

  if (!command) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Unknown command',
            commandInput
              ? `There is no command called \`${cleanCommandInput(commandInput)}\`. Run \`${config.prefix}help\` to see them all.`
              : `Name the command it should run, for example \`${config.prefix}alias add ${trigger.label} clear\`.`,
          ),
        ],
      }),
    );
    return;
  }

  if (command.slashOnly) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'No prefix form',
            `\`${command.name}\` only exists as a slash command, so it cannot be triggered by a word.`,
          ),
        ],
      }),
    );
    return;
  }

  if (command.name === 'alias') {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Not allowed',
            'An alias cannot point at the alias command itself. Pick the command you actually want to shorten.',
          ),
        ],
      }),
    );
    return;
  }

  const existing = getAlias(ctx.guildId, trigger.label);

  if (!existing && countAliases(ctx.guildId) >= MAX_ALIASES) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Too many aliases',
            `This server already has ${MAX_ALIASES}. Remove one with \`${config.prefix}alias remove <word>\` first.`,
          ),
        ],
      }),
    );
    return;
  }

  const alias = saveAlias({
    guildId: ctx.guildId,
    trigger: trigger.label,
    label: trigger.label,
    command: command.name,
    createdBy: ctx.user.id,
  });

  await ctx.reply(ephemeral({ embeds: [describeAdd({ alias, command, updated: Boolean(existing) })] }));
}

async function handleRemove(ctx) {
  if (!(await requireManageGuild(ctx))) return;

  const triggerInput = ctx.isSlash ? ctx.getString('trigger') : ctx.args[1];
  const alias = getAlias(ctx.guildId, triggerInput);

  if (!alias) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'No such alias',
            triggerInput
              ? `Nothing is mapped to \`${triggerInput}\`. See them all with \`${config.prefix}alias list\`.`
              : `Say which word to remove, for example \`${config.prefix}alias remove مسح\`.`,
          ),
        ],
      }),
    );
    return;
  }

  removeAlias(ctx.guildId, alias.trigger);

  await ctx.reply(
    ephemeral({
      embeds: [
        successEmbed(
          'Alias removed',
          `**${alias.label}** no longer runs \`${alias.command}\`. The command itself still works as \`${config.prefix}${alias.command}\`.`,
        ),
      ],
    }),
  );
}

async function handleList(ctx) {
  const aliases = listAliases(ctx.guildId);
  const commands = ctx.client.commands;

  if (aliases.length === 0) {
    await ctx.reply(
      ephemeral({
        embeds: [
          embed({
            title: 'No aliases yet',
            description: [
              'An alias lets you run a command by typing a word, with no prefix.',
              `Example: \`${config.prefix}alias add مسح clear\` — then \`مسح 100\` deletes 100 messages.`,
            ].join('\n'),
            color: COLORS.muted,
          }),
        ],
      }),
    );
    return;
  }

  const lines = aliases.map((alias) => {
    const command = commands.get(alias.command);
    const usage = command ? usageFor(alias.label, command) : `${alias.label} …`;
    const broken = command ? '' : ' *(broken — command missing)*';
    return `**${alias.label}** → \`${alias.command}\`${broken}\n\`${usage}\``;
  });

  await ctx.reply(
    ephemeral({
      embeds: [
        embed({
          title: 'Command aliases',
          description: lines.join('\n\n'),
          footer: `${aliases.length} of ${MAX_ALIASES} · ${config.prefix}alias add <word> <command>`,
        }),
      ],
    }),
  );
}

function usageEmbed() {
  return embed({
    title: 'Aliases',
    description: [
      `Type a word instead of a command, so \`مسح 100\` works like \`${config.prefix}clear 100\`.`,
      '',
      `\`${config.prefix}alias add مسح clear\` — create or change one`,
      `\`${config.prefix}alias remove مسح\` — delete one`,
      `\`${config.prefix}alias list\` — show them all`,
      '',
      'Everything after the word is passed to the command as arguments.',
    ].join('\n'),
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('alias')
    .setDescription('Run a command by typing a word, with no prefix')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('add')
        .setDescription('Create or change a word that runs a command')
        .addStringOption((option) =>
          option
            .setName('trigger')
            .setDescription('The word to type, for example مسح')
            .setRequired(true)
            .setMaxLength(MAX_TRIGGER_LENGTH),
        )
        .addStringOption((option) =>
          option
            .setName('command')
            .setDescription('The command it runs, for example clear')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('remove')
        .setDescription('Delete an alias')
        .addStringOption((option) =>
          option
            .setName('trigger')
            .setDescription('The word to stop using')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((subcommand) => subcommand.setName('list').setDescription('Show every alias')),

  name: 'alias',
  aliases: ['aliases', 'shortcut', 'shortcuts'],
  description: 'Run a command by typing a word, with no prefix',
  category: 'General',
  usage: 'alias add <word> <command> | remove <word> | list',
  cooldown: 3,
  guildOnly: true,

  async autocomplete(interaction, client) {
    const focused = interaction.options.getFocused(true);

    if (focused.name === 'command') {
      const query = cleanCommandInput(focused.value);
      const matches = [...client.commands.values()]
        .filter(
          (command) =>
            command.name !== 'alias' && !command.slashOnly && command.name.includes(query),
        )
        .slice(0, 25)
        .map((command) => ({ name: `/${command.name}`, value: command.name }));

      await interaction.respond(matches);
      return;
    }

    const query = normalizeTrigger(focused.value);
    const matches = listAliases(interaction.guildId)
      .filter((alias) => !query || alias.trigger.includes(query))
      .slice(0, 25)
      .map((alias) => ({ name: `${alias.label} → ${alias.command}`, value: alias.label }));

    await interaction.respond(matches);
  },

  async execute(ctx, client) {
    const subcommand = (ctx.isSlash ? ctx.getSubcommand() : ctx.args[0])?.toLowerCase();

    if (subcommand === 'add') return handleAdd(ctx, client);
    if (subcommand === 'remove' || subcommand === 'delete') return handleRemove(ctx);
    if (subcommand === 'list' || subcommand === 'show') return handleList(ctx);

    await ctx.reply(ephemeral({ embeds: [usageEmbed()] }));
  },
};
