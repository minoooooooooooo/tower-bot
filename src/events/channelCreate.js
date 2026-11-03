import { applyCreationRules } from '../services/exile.js';

/**
 * A channel created after setup must not become a loophole. The service applies
 * every configured role and swallows its own failures, so chat is never blocked
 * by a permission problem.
 */
export default {
  name: 'channelCreate',
  async execute(channel) {
    if (!channel?.guild) return;

    await applyCreationRules(channel);
  },
};
