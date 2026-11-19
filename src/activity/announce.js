import { config } from '../config.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('activity');

const ID_PATTERN = /^\d{15,20}$/;

/**
 * Posts the fresh quick-tunnel address to ACTIVITY_URL_CHANNEL_ID, if set.
 *
 * The address changes on every restart and Discord only loads the activity from
 * the URL mapping in the Developer Portal, so the new value has to reach a
 * human. Printing it to the console works, but on a panel that means opening
 * the console every time; a channel message is easier to find from a phone.
 *
 * Fire-and-forget by design: a wrong channel id, missing permission or a send
 * failure only logs a warning and never touches the tunnel or the bot.
 */
export async function announceActivityUrl(client, url) {
  const channelId = config.activity.urlChannelId;

  if (!channelId) return;

  if (!ID_PATTERN.test(channelId)) {
    logger.warn('ACTIVITY_URL_CHANNEL_ID is not a channel id (copy it with Developer Mode on).');
    return;
  }

  let channel;

  try {
    channel = await client.channels.fetch(channelId);
  } catch (error) {
    logger.warn(`Could not read ACTIVITY_URL_CHANNEL_ID ${channelId}: ${error.message}`);
    return;
  }

  if (!channel || typeof channel.send !== 'function' || !channel.isTextBased?.()) {
    logger.warn(`Channel ${channelId} cannot receive messages; the address is only in the console.`);
    return;
  }

  // Discord renders a bare URL as a link and can display it with a trailing
  // slash, which makes it unclear what to paste into the portal. Post it in a
  // code block instead so the value is copied exactly, and normalise it here.
  const address = String(url).trim().replace(/\/+$/, '');

  if (!address) {
    logger.warn('The tunnel reported an empty address; nothing was posted.');
    return;
  }

  try {
    await channel.send({
      content: [
        '**Store address updated**',
        '',
        '```',
        address,
        '```',
        '',
        'Developer Portal → **Activities → URL Mappings** → prefix `/` → paste the address above.',
        '',
        '-# The free tunnel address changes every time the bot restarts.',
      ].join('\n'),
      allowedMentions: { parse: [] },
    });

    logger.info(`Posted the store address in #${channel.name ?? channelId}.`);
  } catch (error) {
    logger.warn(`Could not post the store address in ${channelId}: ${error.message}`);
  }
}
