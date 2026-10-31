import { PermissionsBitField } from 'discord.js';
import { config } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { dateKey, isBirthdayToday } from '../lib/dates.js';
import * as store from './birthday-store.js';
import { addBirthdayRole, removeBirthdayRole } from './birthday-roles.js';
import { announceBirthdays } from './birthday-greetings.js';

const logger = createLogger('birthdays');

// A member whose role could not be added is retried hourly, not every minute.
const FAILURE_RETRY_MS = 60 * 60 * 1000;
const failedRoleAttempts = new Map();

const warned = new Map();
const WARN_INTERVAL_MS = 60 * 60 * 1000;

function warnThrottled(key, message) {
  const now = Date.now();
  if (now - (warned.get(key) ?? 0) < WARN_INTERVAL_MS) return;
  warned.set(key, now);
  logger.warn(message);
}

export function timezoneForGuild(guildId) {
  return store.getGuildSettings(guildId).timezone ?? config.timezone;
}

/**
 * Effective time zone for a birthday row: the member's override, then the
 * guild default, then the environment default.
 */
export function timezoneForBirthday(birthday, settings) {
  return birthday?.timezone ?? settings?.timezone ?? config.timezone;
}

export function timezoneForUser(guildId, userId) {
  return timezoneForBirthday(
    store.getBirthday(guildId, userId),
    store.getGuildSettings(guildId),
  );
}

/**
 * Brings one member's role and greeting in line with today's date in their own
 * time zone. Used when a birthday or time zone changes outside the scheduler.
 */
export async function syncUserBirthday(guild, userId, now = new Date()) {
  const settings = store.getGuildSettings(guild.id);
  const birthday = store.getBirthday(guild.id, userId);
  const timeZone = timezoneForBirthday(birthday, settings);

  if (birthday && isBirthdayToday(birthday.month, birthday.day, timeZone, now)) {
    if (settings.birthdayRoleId) {
      const result = await addBirthdayRole(guild, userId, settings.birthdayRoleId);
      if (result.ok) {
        store.upsertAssignment(guild.id, userId, settings.birthdayRoleId, dateKey(now, timeZone));
      }
    }

    if (settings.birthdayChannelId) {
      await announceBirthdays(guild, settings, now);
    }

    return;
  }

  const assignment = store.getAssignment(guild.id, userId);
  if (!assignment) return;

  await removeBirthdayRole(guild, userId, assignment.roleId);
  store.deleteAssignment(guild.id, userId);
}

/**
 * Full pass for one guild. Every member is evaluated against their own time
 * zone, so "today" can differ between members. Runs every minute; database
 * reads are cheap and network calls only happen on a state change.
 */
export async function reconcileGuild(guild, now = new Date()) {
  const settings = store.getGuildSettings(guild.id);
  const defaultZone = settings.timezone ?? config.timezone;
  const birthdays = store.listBirthdays(guild.id);
  const byUser = new Map(birthdays.map((birthday) => [birthday.userId, birthday]));

  if (settings.birthdayRoleId) {
    const me = guild.members.me;

    if (!me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      warnThrottled(
        `role-perm:${guild.id}`,
        `[${guild.name}] Missing "Manage Roles" - skipping birthday roles`,
      );
    } else {
      const assignments = new Map(
        store.listAssignments(guild.id).map((assignment) => [assignment.userId, assignment]),
      );

      for (const birthday of birthdays) {
        const timeZone = birthday.timezone ?? defaultZone;
        const assignment = assignments.get(birthday.userId);

        if (!isBirthdayToday(birthday.month, birthday.day, timeZone, now)) {
          if (assignment) {
            await removeBirthdayRole(guild, assignment.userId, assignment.roleId);
            store.deleteAssignment(guild.id, assignment.userId);
          }

          continue;
        }

        const todayKey = dateKey(now, timeZone);
        const applied =
          assignment &&
          assignment.dateKey === todayKey &&
          assignment.roleId === settings.birthdayRoleId;

        if (applied) continue;

        const attemptKey = `${guild.id}:${birthday.userId}:${todayKey}`;
        const lastFailure = failedRoleAttempts.get(attemptKey) ?? 0;

        if (now.getTime() - lastFailure < FAILURE_RETRY_MS) continue;

        const result = await addBirthdayRole(guild, birthday.userId, settings.birthdayRoleId);

        if (result.ok) {
          store.upsertAssignment(
            guild.id,
            birthday.userId,
            settings.birthdayRoleId,
            todayKey,
          );
          failedRoleAttempts.delete(attemptKey);
        } else {
          failedRoleAttempts.set(attemptKey, now.getTime());
        }
      }

      // Assignments for members whose birthday row was deleted.
      for (const assignment of assignments.values()) {
        if (byUser.has(assignment.userId)) continue;
        await removeBirthdayRole(guild, assignment.userId, assignment.roleId);
        store.deleteAssignment(guild.id, assignment.userId);
      }
    }
  }

  if (settings.birthdayChannelId) {
    await announceBirthdays(guild, settings, now);
  }

  logger.debug(`[${guild.name}] reconciled ${birthdays.length} birthday(s)`);
}

/**
 * Runs every minute so each member's own midnight is handled within a minute.
 * Safe on restarts: assignments and greetings are persisted and re-checked.
 */
export function startBirthdayScheduler(client, intervalMs = config.birthdayCheckIntervalMs) {
  const tick = async () => {
    for (const guild of client.guilds.cache.values()) {
      try {
        const settings = store.getGuildSettings(guild.id);
        if (!settings.birthdayRoleId && !settings.birthdayChannelId) continue;

        await reconcileGuild(guild);
      } catch (error) {
        logger.error(`[${guild.name}] Birthday reconciliation failed`, error);
      }
    }
  };

  tick().catch((error) => logger.error('Birthday scheduler startup failed', error));

  const timer = setInterval(() => {
    tick().catch((error) => logger.error('Birthday scheduler tick failed', error));
  }, intervalMs);

  timer.unref();

  logger.info(`Birthday scheduler running (checks every ${Math.round(intervalMs / 1000)}s)`);
  return timer;
}
