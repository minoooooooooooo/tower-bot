import { getDb } from '../lib/db.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('permissions');

/**
 * Roles allowed to run one command even though the member lacks the Discord
 * permission the command normally requires. This is a bot-side grant: it never
 * changes the role's real Discord permissions.
 */
export function listGrants(guildId, command = null) {
  const rows = command
    ? getDb()
        .prepare(
          `SELECT command, role_id, created_by, created_at
             FROM command_permissions
            WHERE guild_id = ? AND command = ?
            ORDER BY created_at ASC`,
        )
        .all(guildId, command)
    : getDb()
        .prepare(
          `SELECT command, role_id, created_by, created_at
             FROM command_permissions
            WHERE guild_id = ?
            ORDER BY command, created_at ASC`,
        )
        .all(guildId);

  return rows.map((row) => ({
    command: row.command,
    roleId: row.role_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }));
}

/** Returns false when the grant already existed. */
export function addGrant(guildId, command, roleId, createdBy) {
  return (
    getDb()
      .prepare(
        `INSERT INTO command_permissions (guild_id, command, role_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(guildId, command, roleId, createdBy, Date.now()).changes > 0
  );
}

export function removeGrant(guildId, command, roleId) {
  return getDb()
    .prepare(
      'DELETE FROM command_permissions WHERE guild_id = ? AND command = ? AND role_id = ?',
    )
    .run(guildId, command, roleId).changes;
}

export function hasGrant(guildId, command, roleIds) {
  const wanted = new Set(roleIds);

  if (wanted.size === 0) return false;

  return listGrants(guildId, command).some((grant) => wanted.has(grant.roleId));
}

/**
 * True when any role the member holds is granted this command. The database is
 * only read on the permission-failure path, so normal moderation pays nothing.
 * A missing table must never crash a command, hence the guard.
 */
export function hasGrantForMember(guildId, command, member) {
  try {
    const roles = member?.roles?.cache;

    if (!roles) return false;

    return hasGrant(guildId, command, [...roles.keys()]);
  } catch (error) {
    logger.warn(`Could not read command permissions: ${error.message}`);
    return false;
  }
}
