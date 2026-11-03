import { createLogger } from '../lib/logger.js';
import { sendExileLog } from '../services/exile.js';
import { getActiveExile, releaseActiveExile } from '../services/exile-store.js';

const logger = createLogger('exile');

/**
 * Roles disappear with the member, so leaving the server ends the exile. The
 * row is released automatically; otherwise `/exile-list` would keep showing
 * someone who is no longer here.
 */
export default {
  name: 'guildMemberRemove',
  async execute(member, client) {
    if (!member?.guild) return;

    const active = getActiveExile(member.guild.id, member.id);

    if (!active) return;

    try {
      releaseActiveExile({
        guildId: member.guild.id,
        userId: member.id,
        releasedBy: client?.user?.id ?? null,
        reason: 'Member left the server',
      });

      await sendExileLog(member.guild, {
        type: 'release',
        userId: member.id,
        actorId: client?.user?.id ?? active.createdBy,
        level: active.level,
        roleId: active.roleId,
        reason: 'Member left the server (automatic release)',
        at: active.createdAt,
        releasedAt: Date.now(),
        footer: 'Automatic: the member is no longer in the server',
      });
    } catch (error) {
      logger.error(`Could not release the exile of ${member.id} after they left`, error);
    }
  },
};
