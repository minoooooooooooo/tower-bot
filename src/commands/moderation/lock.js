import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { lockChannel } from '../../services/channel-locks.js';
import { done, fail, info } from './_shared.js';
import {
  botPermissionProblem,
  discordProblem,
  targetChannel,
  threadProblem,
  unknownChannel,
  unsupportedProblem,
} from './_locks.js';

export default {
  data: new SlashCommandBuilder()
    .setName('lock')
    .setDescription('Stop members from talking in a channel')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Channel to lock — defaults to this one')
        .setRequired(false),
    ),

  name: 'lock',
  description: 'Stop members from talking in a channel (defaults to this one)',
  category: 'Moderation',
  usage: 'lock [#channel]',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ManageChannels'],

  async execute(ctx) {
    const { channel, problem } = await targetChannel(ctx);

    if (problem) {
      await unknownChannel(ctx, problem);
      return;
    }

    const result = await lockChannel({
      guild: ctx.guild,
      channel,
      actor: { id: ctx.user.id, name: ctx.member?.displayName ?? ctx.user.username },
    });

    if (!result.ok) {
      if (result.reason === 'thread') {
        await fail(ctx, 'Thread channel', threadProblem(channel));
      } else if (result.reason === 'unsupported') {
        await fail(ctx, 'Unsupported channel', unsupportedProblem(channel));
      } else if (result.reason === 'bot-permissions') {
        await fail(ctx, 'Missing permissions', botPermissionProblem(channel));
      } else {
        await fail(ctx, 'Could not lock the channel', discordProblem(result));
      }

      return;
    }

    const unlockHint = ctx.isSlash ? `/unlock channel:${channel.id}` : `:-unlock ${channel}`;

    if (result.already) {
      await info(
        ctx,
        'Already locked',
        result.external
          ? `${channel} is already locked, but not by me. ${unlockHint} will open it again.`
          : `${channel} is already locked. ${unlockHint} will restore it.`,
      );
      return;
    }

    await done(
      ctx,
      'Channel locked',
      [
        `${channel} is locked. Members can no longer send messages, react, or start threads.`,
        '',
        `Open it again with ${unlockHint}.`,
      ].join('\n'),
    );
  },
};
