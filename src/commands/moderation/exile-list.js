import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { COLORS, embed, errorEmbed, infoEmbed } from '../../lib/embeds.js';
import {
  countActiveExiles,
  getExileLogChannelId,
  levelLabel,
  listActiveExiles,
} from '../../services/exile-store.js';

const MAX_SHOWN = 30;

function ephemeral(payload) {
  return { ...payload, flags: MessageFlags.Ephemeral };
}

async function requireManageServer(ctx) {
  if (ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;

  await ctx.reply(
    ephemeral({
      embeds: [errorEmbed('Missing permissions', 'You need **Manage Server** to see active exiles.')],
    }),
  );

  return false;
}

function listPayload(ctx) {
  const exiles = listActiveExiles(ctx.guildId);

  if (exiles.length === 0) {
    return infoEmbed(
      'No active exiles',
      'Nobody is exiled right now. Use `/exile user:@member` to start one.',
    );
  }

  const shown = exiles.slice(0, MAX_SHOWN);
  const lines = shown.map((entry) => {
    const reason = entry.reason?.trim() ? ` — ${entry.reason.trim().slice(0, 80)}` : '';

    return `\u200E• <@${entry.userId}> — **${levelLabel(entry.level)}** — <t:${Math.floor(entry.createdAt / 1000)}:R> by <@${entry.createdBy}>${reason}`;
  });

  if (exiles.length > shown.length) {
    lines.push(`…and ${exiles.length - shown.length} more`);
  }

  const logChannelId = getExileLogChannelId(ctx.guildId);

  return embed({
    title: `Active exiles (${countActiveExiles(ctx.guildId)})`,
    description: lines.join('\n').slice(0, 4000),
    color: COLORS.warning,
    footer: logChannelId
      ? `Audit log: <#${logChannelId}>`
      : 'No exile log channel set — run /exile-log channel:#mod-log.',
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('exile-list')
    .setDescription('Show every member who is currently exiled')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild),

  name: 'exile-list',
  aliases: ['exiles'],
  description: 'Show every member who is currently exiled',
  category: 'Moderation',
  usage: 'exile-list',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ManageGuild'],

  async execute(ctx) {
    if (!(await requireManageServer(ctx))) return;

    await ctx.reply(ephemeral({ embeds: [listPayload(ctx)] }));
  },
};
