import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, embed, errorEmbed, infoEmbed } from '../../lib/embeds.js';
import { resolveChannel, resolveRole } from '../../lib/resolve.js';
import { reconcileRole, roleProblem } from '../../services/exile.js';
import { markRoleSetUp, replaceExceptions } from '../../services/exile-store.js';

const MAX_EXCEPT_REPORTED = 10;

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

async function requireManageServer(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await ctx.reply(
    ephemeral({
      embeds: [
        errorEmbed('Missing permissions', 'You need **Manage Server** to set up exile roles.'),
      ],
    }),
  );

  return false;
}

function tokenList(raw) {
  return String(raw ?? '')
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

async function resolveChannels(guild, tokens) {
  const found = new Map();
  const unknown = [];

  for (const token of tokens) {
    const channel = await resolveChannel(guild, token).catch(() => null);

    if (channel) found.set(channel.id, channel);
    else unknown.push(token);
  }

  return { channels: [...found.values()], unknown };
}

function failureLines(failed) {
  return failed
    .slice(0, MAX_EXCEPT_REPORTED)
    .map((entry) => `• #${entry.name} — ${entry.message}`)
    .join('\n');
}

export default {
  data: new SlashCommandBuilder()
    .setName('exile-setup')
    .setDescription('Hide every channel from an exile role, except the ones you list')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addRoleOption((option) =>
      option
        .setName('role')
        .setDescription('The exile role to configure')
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName('except')
        .setDescription('Channels that stay visible, e.g. #exile-chat #rules (leave empty to hide all)')
        .setRequired(false)
        .setMaxLength(1000),
    ),

  name: 'exile-setup',
  description: 'Hide every channel from an exile role, except the ones you list',
  category: 'Moderation',
  usage: 'exile-setup <@role> [#channel ...]',
  cooldown: 5,
  guildOnly: true,
  permissions: ['ManageGuild'],

  async execute(ctx) {
    if (!(await requireManageServer(ctx))) return;

    const role = ctx.isSlash
      ? ctx.getRole('role')
      : await resolveRole(ctx.guild, ctx.args[0]).catch(() => null);

    if (!role) {
      await ctx.reply(
        ephemeral({
          embeds: [
            errorEmbed(
              'Unknown role',
              `Mention the role or paste its id, for example \`${ctx.isSlash ? '/exile-setup role:@Exile 1' : ':-exile-setup @Exile1 #exile-1'}\`.`,
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

    const rawTokens = ctx.isSlash
      ? tokenList(ctx.getString('except'))
      : ctx.args.slice(1);

    const { channels, unknown } = await resolveChannels(ctx.guild, rawTokens);

    if (unknown.length > 0) {
      await ctx.reply(
        ephemeral({
          embeds: [
            errorEmbed(
              'Unknown channel',
              `I could not find: ${unknown.map((token) => `\`${token}\``).join(', ')}. Mention channels as \`#channel\` or paste their ids.`,
            ),
          ],
        }),
      );
      return;
    }

    // Slash needs an early acknowledgement; applying a role to every channel
    // can take longer than Discord's three-second window.
    if (ctx.isSlash) {
      await ctx.defer({ ephemeral: true });
    } else {
      await ctx.reply({
        embeds: [
          infoEmbed(
            'Applying exile rules…',
            `Hiding every channel from ${role}, except ${channels.length === 0 ? 'none' : channels.map((channel) => channel.toString()).join(', ')}. This can take a moment.`,
          ),
        ],
      });
    }

    replaceExceptions(ctx.guildId, role.id, channels.map((channel) => channel.id));
    markRoleSetUp(ctx.guildId, role.id);

    const result = await reconcileRole(ctx.guild, role, channels.map((channel) => channel.id), {
      reason: `Exile setup: ${role.name}`,
    });

    const lines = [
      `${role} now sees **${channels.length === 0 ? 'no channels' : `${channels.length} channel${channels.length === 1 ? '' : 's'}`}** in this server.`,
      `Applied to **${result.updated}** channel${result.updated === 1 ? '' : 's'}; **${result.skipped}** already matched.`,
    ];

    if (result.failed.length > 0) {
      lines.push(
        '',
        `⚠️ **${result.failed.length}** channel${result.failed.length === 1 ? '' : 's'} could not be edited:`,
        failureLines(result.failed),
      );

      if (result.failed.length > MAX_EXCEPT_REPORTED) {
        lines.push(`…and ${result.failed.length - MAX_EXCEPT_REPORTED} more.`);
      }

      lines.push('Re-run setup to retry the rest once the cause is fixed.');
    }

    if (channels.length > 0) {
      lines.push('', `Kept visible: ${channels.map((channel) => channel.toString()).join(', ')}`);
    }

    await ctx.editReply({
      embeds: [
        embed({
          title: result.failed.length > 0 ? 'Exile setup partially applied' : 'Exile setup saved',
          description: lines.join('\n'),
          color: result.failed.length > 0 ? COLORS.warning : COLORS.success,
          footer:
            'Next: map it with /exile-role set level:<main|1-10> role:@role. New channels are hidden automatically.',
        }),
      ],
    });
  },
};
