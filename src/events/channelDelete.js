import { removeChannelFromExceptions } from '../services/exile-store.js';
import { markTicketDeletedByChannel } from '../services/ticket-store.js';
import { removeIgnoredChannel } from '../services/watch-store.js';
import { invalidateWatchCache } from '../services/watch.js';

/**
 * Deleted channels are removed from every exception list. If a category is
 * deleted its children delete separately, so their own rows are cleaned too.
 * A deleted channel also leaves the keyword-alert ignore list.
 */
export default {
  name: 'channelDelete',
  async execute(channel) {
    if (!channel?.guild) return;

    removeChannelFromExceptions(channel.guild.id, channel.id);
    markTicketDeletedByChannel(channel.guild.id, channel.id);

    if (removeIgnoredChannel(channel.guild.id, channel.id) > 0) {
      invalidateWatchCache(channel.guild.id);
    }
  },
};
