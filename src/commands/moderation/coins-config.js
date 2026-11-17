import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from '../../config.js';
import { COLORS, embed, errorEmbed, successEmbed } from '../../lib/embeds.js';
import { setTransferEnabled, transferEnabled } from '../../services/profile-store.js';

const OFF_WORDS = ['off', 'disable', 'disabled', 'false', 'no', 'stop'];
const ON_WORDS = ['on', 'enable', 'enabled', 'true', 'yes', 'start'];

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

async function requireManageServer(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await ctx.reply(
    ephemeral({
      embeds: [
        errorEmbed(
          'Missing permissions',
          'You need **Manage Server** to change coin transfers.',
        ),
      ],
    }),
  );

  return false;
}

function statusEmbed(guildId) {
  const enabled = transferEnabled(guildId);

  return embed({
    title: enabled ? 'Coin transfers are on' : 'Coin transfers are off',
    description: enabled
      ? `Members can send coins with \`${config.prefix}coins @member <amount>\`.`
      : 'Members cannot send coins to each other. Balances can still be checked.',
    color: enabled ? COLORS.success : COLORS.warning,
    footer: `Change it with ${config.prefix}coins-config on|off`,
  });
}

/** Applies one state token. Returns the payload to send back (or null to show status). */
function applyState(ctx, token) {
  const raw = String(token ?? '').trim().toLowerCase();

  if (!raw || raw === 'status' || raw === 'show') return null;

  if (ON_WORDS.includes(raw)) {
    setTransferEnabled(ctx.guildId, true);

    return ephemeral({
      embeds: [
        successEmbed(
          'Coin transfers are on',
          `Members can now send coins with \`${config.prefix}coins @member <amount>\`.`,
        ),
      ],
    });
  }

  if (OFF_WORDS.includes(raw)) {
    setTransferEnabled(ctx.guildId, false);

    return ephemeral({
      embeds: [
        successEmbed(
          'Coin transfers are off',
          'Only balances can be checked now. Turn transfers back on with ' +
            `\`${config.prefix}coins-config on\`.`,
        ),
      ],
    });
  }

  return undefined;
}

export default {
  data: new SlashCommandBuilder()
    .setName('coins-config')
    .setDescription('Turn coin transfers between members on or off')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName('state')
        .setDescription('on, off, or status (default: status)')
        .addChoices(
          { name: 'status', value: 'status' },
          { name: 'on', value: 'on' },
          { name: 'off', value: 'off' },
        )
        .setRequired(false),
    ),

  name: 'coins-config',
  aliases: ['coin-config', 'coinsconfig'],
  description: 'Turn coin transfers between members on or off',
  category: 'Moderation',
  usage: 'coins-config [on|off|status]',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ManageGuild'],

  async execute(ctx) {
    if (!(await requireManageServer(ctx))) return;

    const token = ctx.isSlash ? ctx.getString('state') ?? 'status' : ctx.args[0] ?? 'status';
    const payload = applyState(ctx, token);

    if (payload === undefined) {
      await ctx.reply(
        ephemeral({
          embeds: [
            errorEmbed(
              'Unknown value',
              `Use \`${config.prefix}coins-config on\`, \`${config.prefix}coins-config off\`, ` +
                `or \`${config.prefix}coins-config status\`.`,
            ),
          ],
        }),
      );
      return;
    }

    await ctx.reply(payload ?? ephemeral({ embeds: [statusEmbed(ctx.guildId)] }));
  },
};
