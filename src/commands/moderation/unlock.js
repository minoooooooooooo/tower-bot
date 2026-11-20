import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { unlockChannel } from '../../services/channel-locks.js';
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
    .setName('unlock')
    .setDescription('Let members talk in a channel again')
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addChannelOption((option) =>
      option
        .setName('channel')
        .setDescription('Channel to unlock — defaults to this one')
        .setRequired(false),
    ),

  name: 'unlock',
  description: 'Let members talk in a channel again (defaults to this one)',
  category: 'Moderation',
  usage: 'unlock [#channel]',
  cooldown: 3,
  guildOnly: true,
  permissions: ['ManageChannels'],

  async execute(ctx) {
    const { channel, problem } = await targetChannel(ctx);

    if (problem) {
      await unknownChannel(ctx, problem);
      return;
    }

    const result = await unlockChannel({
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
        await fail(ctx, 'Could not unlock the channel', discordProblem(result));
      }

      return;
    }

    if (result.already) {
      await info(ctx, 'Not locked', `${channel} is already open — nothing to restore.`);
      return;
    }

    const lines = [`${channel} is open again.`];

    lines.push(
      result.restored
        ? 'The permissions from before the lock are back.'
        : 'I had no saved state for this channel, so I cleared the lock permissions instead of restoring an earlier setup. Check the channel if it had custom permissions before.',
    );

    await done(ctx, 'Channel unlocked', lines.join('\n'));
  },
};
