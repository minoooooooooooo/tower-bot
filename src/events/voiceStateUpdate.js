import { createLogger } from '../lib/logger.js';
import { handleVoiceStates } from '../services/activity.js';

const logger = createLogger('voice-activity');

export default {
  name: 'voiceStateUpdate',
  execute(oldState, newState) {
    try {
      handleVoiceStates(oldState, newState);
    } catch (error) {
      // A stats failure must never take down voice handling.
      logger.error('Voice activity tracking failed', error);
    }
  },
};
