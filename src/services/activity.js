import { createLogger } from '../lib/logger.js';
import {
  finishAllVoiceSessions,
  finishVoiceSession,
  listVoiceSessions,
  startVoiceSession,
  touchVoiceSessions,
} from './activity-store.js';

const logger = createLogger('activity');

const HEARTBEAT_MS = 5 * 60_000;

let heartbeat = null;

/**
 * Tracks joins, leaves and channel moves. AFK time is ignored: sitting in the
 * AFK channel is not activity, and counting it would let one member dominate
 * the voice leaderboard by idling.
 */
export function handleVoiceStates(oldState, newState, now = Date.now()) {
  const guild = newState.guild ?? oldState.guild;
  const member = newState.member ?? oldState.member;
  const userId = member?.id ?? newState.id ?? oldState.id;

  if (!guild || !userId) return;
  if (member?.user?.bot) return;

  const oldId = oldState.channelId ?? null;
  const newId = newState.channelId ?? null;

  if (oldId === newId) return;

  if (oldId) {
    finishVoiceSession(guild.id, userId, now);
  }

  if (newId && newId !== guild.afkChannelId) {
    startVoiceSession({ guildId: guild.id, userId, channelId: newId, at: now });
  }
}

/**
 * After a restart, close sessions at their last heartbeat and reopen the ones
 * whose members are still in voice. Without the second pass, a graceful
 * shutdown (which closes every session) would stop tracking everyone who never
 * leaves voice.
 */
export async function reconcileVoiceSessions(client, now = Date.now()) {
  const rows = listVoiceSessions();
  const seen = new Set();

  for (const row of rows) {
    const key = `${row.guildId}:${row.userId}`;
    const guild =
      client.guilds.cache.get(row.guildId) ??
      (await client.guilds.fetch(row.guildId).catch(() => null));

    // lastSeenAt is the last heartbeat, so downtime is not charged as voice time.
    finishVoiceSession(row.guildId, row.userId, row.lastSeenAt);

    const state = guild?.voiceStates?.cache?.get(row.userId);
    const channelId = state?.channelId ?? null;

    if (
      guild &&
      channelId &&
      channelId !== guild.afkChannelId &&
      !state.member?.user?.bot
    ) {
      startVoiceSession({ guildId: row.guildId, userId: row.userId, channelId, at: now });
      seen.add(key);
    }
  }

  // Members who were already in voice while the bot was offline (or who joined
  // during a restart) have no open row yet.
  for (const guild of client.guilds.cache.values()) {
    const states = guild.voiceStates?.cache;
    if (!states?.values) continue;

    for (const state of states.values()) {
      const channelId = state.channelId ?? null;

      if (!channelId || channelId === guild.afkChannelId) continue;
      if (state.member?.user?.bot) continue;

      const key = `${guild.id}:${state.id}`;
      if (seen.has(key)) continue;

      startVoiceSession({
        guildId: guild.id,
        userId: state.id,
        channelId,
        at: now,
      });
      seen.add(key);
    }
  }

  logger.info(`Voice tracking reconciled (${seen.size} member(s) in voice)`);
}

/** Keeps last_seen_at fresh so a crash cannot overcount hours of downtime. */
export function startActivityHeartbeat(intervalMs = HEARTBEAT_MS) {
  if (heartbeat) return heartbeat;

  heartbeat = setInterval(() => {
    try {
      touchVoiceSessions(Date.now());
    } catch (error) {
      logger.error('Voice heartbeat failed', error);
    }
  }, intervalMs);

  heartbeat.unref();
  logger.info(`Activity heartbeat running (every ${Math.round(intervalMs / 1000)}s)`);
  return heartbeat;
}

/** Called on shutdown before the database closes. */
export function stopActivityTracking(at = Date.now()) {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }

  try {
    finishAllVoiceSessions(at);
  } catch (error) {
    logger.error('Could not close voice sessions on shutdown', error);
  }
}
