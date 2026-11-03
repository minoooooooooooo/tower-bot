import {
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { errorEmbed, successEmbed } from '../../lib/embeds.js';
import { resolveChannel } from '../../lib/resolve.js';
import { getExileLogChannelId, setExileLogChannelId } from '../../services/exile-store.js';

const OFF_WORDS = ['off', 'none', 'clear', 'disable'];

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

async function requireManageServer(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await ctx.reply(
    ephemeral({
      embeds: [
        errorEmbed('Missing permissions', 'You need **Manage Server** to choose the exile log.'),
      ],
    }),
  );

  return false;
}

async function requireSendable(ctx, channel) {
  if (!channel?.isTextBased?.() || channel.isDMBased?.()) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'Not a text channel',
            'Pick a normal server channel, for example `/exile-log channel:#mod-log`.',
          ),
        ],
      }),
    );
    return false;
  }

  const me = ctx.guild.members?.me;
  const permissions = me ? channel.permissionsFor?.(me) : null;

  if (
    permissions &&
    !permissions.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ])
  ) {
    await ctx.reply(
      ephemeral({
        embeds: [
          errorEmbed(
            'I cannot post there',
            `I need **View Channel**, **Send Messages** and **Embed Links** in ${channel}.`,
          ),
        ],
      }),
    );
    return false;
  }

  return true;
}

async function turnOff(ctx) {
  setExileLogChannelId(ctx.guildId, null);

  await ctx.reply(
    ephemeral({
      embeds: [
        successEmbed(
          'Exile log is off',
          'Exile and release actions will no longer be posted anywhere.',
        ),
      ],
    }),
  );
}

export default {
  data: new SlashCommandBuilder()
    .setName('exile-log')
    .setDescription('Choose the channel that receives exile and release records')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Audit channel (leave empty to turn logging off)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ),

  name: 'exile-log',
  description: 'Choose the channel that receives exile and release records',
  category: 'Moderation',
  usage: 'exile-log <#channel|off>',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ManageGuild'],

  async execute(ctx) {
    if (!(await requireManageServer(ctx))) return;

    if (ctx.isSlash) {
      const channel = ctx.getChannel('channel');

      if (!channel) return turnOff(ctx);
      if (!(await requireSendable(ctx, channel))) return;

      setExileLogChannelId(ctx.guildId, channel.id);

      await ctx.reply(
        ephemeral({
          embeds: [
            successEmbed(
              'Exile log saved',
              `Exile, level changes and releases will be posted in ${channel}.`,
            ),
          ],
        }),
      );
      return;
    }

    const raw = (ctx.args[0] ?? '').trim();

    if (!raw || OFF_WORDS.includes(raw.toLowerCase())) return turnOff(ctx);

    const channel = await resolveChannel(ctx.guild, raw).catch(() => null);

    if (!channel) {
      await ctx.reply(
        ephemeral({
          embeds: [
            errorEmbed(
              'Unknown channel',
              `I could not find \`${raw}\`. Mention it as \`#channel\` or paste the channel id. Current log: ${
                getExileLogChannelId(ctx.guildId) ? `<#${getExileLogChannelId(ctx.guildId)}>` : 'off'
              }.`,
            ),
          ],
        }),
      );
      return;
    }

    if (!(await requireSendable(ctx, channel))) return;

    setExileLogChannelId(ctx.guildId, channel.id);

    await ctx.reply(
      ephemeral({
        embeds: [
          successEmbed(
            'Exile log saved',
            `Exile, level changes and releases will be posted in ${channel}.`,
          ),
        ],
      }),
    );
  },
};
