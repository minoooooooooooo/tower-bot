import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, embed, errorEmbed, infoEmbed, successEmbed, warningEmbed } from '../../lib/embeds.js';
import { resolveRole } from '../../lib/resolve.js';
import { roleProblem } from '../../services/exile.js';
import {
  EXILE_LEVELS,
  clearRoleMapping,
  isRoleSetUp,
  levelLabel,
  listRoleMappings,
  normalizeLevel,
  setRoleMapping,
} from '../../services/exile-store.js';

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

async function requireManageServer(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await ctx.reply(
    ephemeral({
      embeds: [
        errorEmbed('Missing permissions', 'You need **Manage Server** to map exile levels.'),
      ],
    }),
  );

  return false;
}

const LEVEL_CHOICES = EXILE_LEVELS.map((level) => ({ name: levelLabel(level), value: level }));

async function handleSet(ctx) {
  const rawLevel = ctx.isSlash ? ctx.getString('level') : ctx.args[1];
  const level = normalizeLevel(rawLevel);

  if (!level) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Invalid level',
            `Use \`main\` or a number from 1 to 10, for example \`${ctx.isSlash ? '/exile-role set level:3 role:@Exile 3' : ':-exile-role set 3 @Exile 3'}\`.`,
          ),
        ],
      }),
    );
    return;
  }

  const role = ctx.isSlash
    ? ctx.getRole('role')
    : await resolveRole(ctx.guild, ctx.args[2]).catch(() => null);

  if (!role) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Unknown role',
            'Mention the exile role or paste its id, for example `:-exile-role set 3 @Exile3`.',
          ),
        ],
      }),
    );
    return;
  }

  const problem = roleProblem(ctx.guild, role);

  if (problem) {
    await ctx.reply(ephemeral({ embeds: [errorEmbed('Cannot use that role', problem)] }));
    return;
  }

  const { previous, previousLevel } = setRoleMapping(ctx.guildId, level, role.id);
  const setUp = isRoleSetUp(ctx.guildId, role.id);

  const lines = [`**${levelLabel(level)}** → ${role}`];

  if (previous && previous !== role.id) {
    lines.push(`This level previously used <@&${previous}>.`);
  }

  if (previousLevel && previousLevel !== level) {
    lines.push(`${role} was mapped to **${levelLabel(previousLevel)}** and has been moved.`);
  }

  if (!setUp) {
    lines.push(
      '',
      `⚠️ This role has **not been set up** yet. Run \`/exile-setup role:${role.name}\` before using it — otherwise no channel is hidden.`,
    );
  }

  await ctx.reply(
    ephemeral({
      embeds: [
        (setUp ? successEmbed : warningEmbed)('Exile level saved', lines.join('\n')),
      ],
    }),
  );
}

async function handleClear(ctx) {
  const rawLevel = ctx.isSlash ? ctx.getString('level') : ctx.args[1];
  const level = normalizeLevel(rawLevel);

  if (!level) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed('Invalid level', 'Use `main` or a number from 1 to 10.'),
        ],
      }),
    );
    return;
  }

  const removed = clearRoleMapping(ctx.guildId, level);

  await ctx.reply(
    ephemeral({
      embeds: [
        removed > 0
          ? successEmbed(
              'Exile level cleared',
              `**${levelLabel(level)}** no longer has a role. The role itself and its channel rules are untouched.`,
            )
          : infoEmbed('Nothing to clear', `**${levelLabel(level)}** was not mapped to a role.`),
      ],
    }),
  );
}

function listPayload(ctx) {
  const mappings = new Map(
    listRoleMappings(ctx.guildId).map((entry) => [entry.level, entry.roleId]),
  );

  const lines = EXILE_LEVELS.map((level) => {
    const roleId = mappings.get(level);

    if (!roleId) return `**${levelLabel(level)}** — *not set*`;

    const role = ctx.guild.roles.cache.get(roleId);
    const name = role ? role.toString() : `<@&${roleId}> (deleted)`;
    const ready = isRoleSetUp(ctx.guildId, roleId);

    return `**${levelLabel(level)}** — ${name}${ready ? '' : ' ⚠️ not set up'}`;
  });

  const configured = mappings.size;

  return embed({
    title: `Exile levels (${configured}/${EXILE_LEVELS.length})`,
    description: lines.join('\n'),
    color: configured === EXILE_LEVELS.length ? COLORS.primary : COLORS.warning,
    footer:
      'Map with /exile-role set · hide channels with /exile-setup · use /exile user:@member level:<n>',
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('exile-role')
    .setDescription('Map each exile level to one of your exile roles')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Choose the role used for a level')
        .addStringOption((option) =>
          option
            .setName('level')
            .setDescription('Main or 1–10')
            .setRequired(true)
            .addChoices(...LEVEL_CHOICES),
        )
        .addRoleOption((option) =>
          option.setName('role').setDescription('The exile role').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('clear')
        .setDescription('Forget the role mapped to a level')
        .addStringOption((option) =>
          option
            .setName('level')
            .setDescription('Main or 1–10')
            .setRequired(true)
            .addChoices(...LEVEL_CHOICES),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Show every level and its role')),

  name: 'exile-role',
  description: 'Map each exile level to one of your exile roles',
  category: 'Moderation',
  usage: 'exile-role set <main|1-10> <@role> | clear <main|1-10> | list',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ManageGuild'],

  async execute(ctx) {
    if (!(await requireManageServer(ctx))) return;

    const sub = ctx.isSlash
      ? ctx.getSubcommand()
      : ['set', 'clear', 'delete', 'list'].includes(ctx.args[0])
        ? ctx.args[0]
        : 'list';

    if (sub === 'set') return handleSet(ctx);
    if (sub === 'clear' || sub === 'delete') return handleClear(ctx);

    await ctx.reply(ephemeral({ embeds: [listPayload(ctx)] }));
  },
};
