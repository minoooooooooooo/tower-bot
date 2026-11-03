import { removeChannelFromExceptions } from '../services/exile-store.js';

/**
 * Deleted channels are removed from every exception list. If a category is
 * deleted its children delete separately, so their own rows are cleaned too.
 */
export default {
  name: 'channelDelete',
  async execute(channel) {
    if (!channel?.guild) return;

    removeChannelFromExceptions(channel.guild.id, channel.id);
  },
};
