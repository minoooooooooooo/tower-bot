import {
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import { errorEmbed, successEmbed, warningEmbed } from '../../lib/embeds.js';
import { resolveRole } from '../../lib/resolve.js';
import { addGrant, listGrants, removeGrant } from '../../services/permission-store.js';

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

async function findCommand(client, name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key) return null;

  return client.commands.get(client.aliases.get(key) ?? key) ?? null;
}

function roleName(id, guild) {
  return guild.roles.cache.get(id)?.toString() ?? `<@&${id}>`;
}

async function doGrant(ctx, client, { grant }) {
  const role = ctx.isSlash ? ctx.getRole('role') : await resolveRole(ctx.guild, ctx.args[1]);
  const command = await findCommand(
    client,
    ctx.isSlash ? ctx.getString('command') : ctx.args[2],
  );

  if (!role) {
    await ctx.reply(
      ephemeral({
        embeds: [errorEmbed('Unknown role', 'Mention the role or paste its id.')],
      }),
    );
    return;
  }

  if (role.id === ctx.guild.id) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Not @everyone',
            'Granting a command to @everyone would give it to every member. Pick a real role.',
          ),
        ],
      }),
    );
    return;
  }

  if (!command) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Unknown command',
            `No command matches that name. Try \`${ctx.isSlash ? '/perm list' : ':-perm list'}\` to see the current grants.`,
          ),
        ],
      }),
    );
    return;
  }

  if (command.name === 'perm' || command.grantable === false) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Not grantable',
            '**perm** itself cannot be granted — that would let a role hand out more permissions.',
          ),
        ],
      }),
    );
    return;
  }

  if (!command.permissions?.length) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Nothing to grant',
            `**${command.name}** has no permission requirement, so everyone can already use it.`,
          ),
        ],
      }),
    );
    return;
  }

  if (grant) {
    const added = addGrant(ctx.guildId, command.name, role.id, ctx.user.id);

    await ctx.reply({
      embeds: [
        successEmbed(
          added ? 'Permission granted' : 'Already granted',
          added
            ? `${role} can now run **${command.name}** even without ${command.permissions.join(', ')}.\n` +
              '_Hierarchy checks still apply: the role cannot act on someone above it._'
            : `${role} could already run **${command.name}**.`,
        ),
      ],
    });
    return;
  }

  const removed = removeGrant(ctx.guildId, command.name, role.id);

  await ctx.reply({
    embeds: [
      removed
        ? successEmbed(
            'Permission revoked',
            `${role} no longer bypasses the **${command.name}** permission check.`,
          )
        : warningEmbed(
            'Nothing to revoke',
            `${role} did not have a **${command.name}** grant.`,
          ),
    ],
  });
}

function doList(ctx) {
  const filter = String(
    ctx.isSlash ? ctx.getString('command') ?? '' : ctx.args[1] ?? '',
  )
    .trim()
    .toLowerCase();
  const grants = listGrants(ctx.guildId, filter || null);

  if (grants.length === 0) {
    ctx.reply({
      embeds: [
        warningEmbed(
          'No command permissions',
          'No role has a bot-side grant yet.\n' +
            `Add one with \`${ctx.isSlash ? '/perm grant role:@Mod command:kick' : ':-perm grant @Mod kick'}\`.`,
        ),
      ],
    });
    return;
  }

  const byCommand = new Map();

  for (const grant of grants) {
    if (!byCommand.has(grant.command)) byCommand.set(grant.command, []);
    byCommand.get(grant.command).push(roleName(grant.roleId, ctx.guild));
  }

  const lines = [...byCommand.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([command, roles]) => `**${command}** — ${roles.join(', ')}`);

  ctx.reply({
    embeds: [
      successEmbed(
        'Command permissions',
        `${lines.join('\n')}\n\n_These are bot-side grants: the role's real Discord permissions are unchanged._`,
      ),
    ],
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('perm')
    .setDescription('Grant or revoke a command for a role without changing Discord permissions')
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('grant')
        .setDescription('Let a role run a command without its Discord permission')
        .addRoleOption((option) =>
          option.setName('role').setDescription('Role to grant').setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('command').setDescription('Command name, e.g. kick').setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('revoke')
        .setDescription('Remove a role’s grant for a command')
        .addRoleOption((option) =>
          option.setName('role').setDescription('Role to update').setRequired(true),
        )
        .addStringOption((option) =>
          option.setName('command').setDescription('Command name, e.g. kick').setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('list')
        .setDescription('Show every command grant in this server')
        .addStringOption((option) =>
          option
            .setName('command')
            .setDescription('Only show this command')
            .setRequired(false),
        ),
    ),

  name: 'perm',
  aliases: ['perms', 'commandperm'],
  description: 'Grant or revoke a command for a role without changing Discord permissions',
  category: 'Moderation',
  usage: 'perm grant|revoke <@role> <command> | perm list',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ManageGuild'],

  async execute(ctx, client) {
    const action = ctx.isSlash
      ? ctx.getSubcommand()
      : String(ctx.args[0] ?? '').toLowerCase();

    if (action === 'grant' || action === 'revoke') {
      await doGrant(ctx, client, { grant: action === 'grant' });
      return;
    }

    if (action === 'list' || !action) {
      doList(ctx);
      return;
    }

    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Unknown action',
            `Use \`${ctx.isSlash ? '/perm grant' : ':-perm grant'} <role> <command>\`, \`revoke\`, or \`list\`.`,
          ),
        ],
      }),
    );
  },
};
