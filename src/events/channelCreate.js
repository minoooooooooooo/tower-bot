import { applyCreationRules } from '../services/exile.js';
import { applyMuteRules } from '../services/moderation.js';

/**
 * A channel created after setup must not become a loophole. Both services apply
 * their own rules and swallow failures, so chat is never blocked by a
 * permission problem.
 */
export default {
  name: 'channelCreate',
  async execute(channel) {
    if (!channel?.guild) return;

    await applyCreationRules(channel);
    await applyMuteRules(channel);
  },
};
