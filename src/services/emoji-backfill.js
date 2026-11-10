import { createLogger } from '../lib/logger.js';
import { backfillableChannels, snowflakeFor } from './activity-backfill.js';
import {
  emojiBackfillChannel,
  emojiTrackingSince,
  ensureEmojiTracking,
  markEmojiBackfillDone,
  markEmojiBackfillError,
  recordEmojiBackfillPage,
} from './emoji-store.js';

const logger = createLogger('emoji-backfill');

const PAGE_SIZE = 100;

/** One job per guild; the cursor rows survive a restart, the job object does not. */
const jobs = new Map();

function makeJob(guildId) {
  return {
    guildId,
    startedAt: Date.now(),
    finishedAt: null,
    cancelled: false,
    pages: 0,
    fetched: 0,
    emojiUses: 0,
    errors: 0,
    channelId: null,
    channelName: null,
    error: null,
  };
}

export function currentEmojiBackfillJob(guildId) {
  return jobs.get(guildId) ?? null;
}

export function cancelEmojiBackfill(guildId) {
  const job = jobs.get(guildId);

  if (!job || job.finishedAt) return null;

  job.cancelled = true;
  return job;
}

/** Shutdown: stop after the page in flight so SQLite can close cleanly. */
export function stopEmojiBackfill() {
  for (const job of jobs.values()) {
    if (!job.finishedAt) job.cancelled = true;
  }
}

/**
 * Starts the history import in the background and returns immediately so the
 * command can answer. `/emojibackfill status` reads the persisted rows.
 */
export function startEmojiBackfill(client, guildId) {
  const running = jobs.get(guildId);

  if (running && !running.finishedAt) {
    return { started: false, job: running, reason: 'running' };
  }

  const job = makeJob(guildId);
  jobs.set(guildId, job);

  runEmojiBackfill(client, guildId, job)
    .catch((error) => {
      job.error = error;
      logger.error(`Emoji backfill failed for ${guildId}`, error);
    })
    .finally(() => {
      job.finishedAt = Date.now();
    });

  return { started: true, job };
}

/**
 * Walks each channel backwards from the live emoji boundary. Pages and cursors
 * commit together, so a restart resumes after the last complete page instead of
 * counting anything twice. Only custom emoji tokens are read; message content
 * is not stored.
 */
export async function runEmojiBackfill(client, guildId, job = makeJob(guildId)) {
  const guild =
    client.guilds?.cache?.get(guildId) ??
    (await client.guilds?.fetch?.(guildId).catch(() => null));

  if (!guild) throw new Error(`Guild ${guildId} is not available`);

  const boundary = emojiTrackingSince(guildId) ?? ensureEmojiTracking(guildId, Date.now());
  const pending = backfillableChannels(guild).filter(
    (channel) => !emojiBackfillChannel(guildId, channel.id)?.done,
  );

  logger.info(
    `Emoji backfill started for ${guildId}: ${pending.length} channel(s), messages older than ` +
      `${new Date(boundary).toISOString()}`,
  );

  outer: for (const channel of pending) {
    if (job.cancelled) break;

    const state = emojiBackfillChannel(guildId, channel.id);
    let cursor = state?.cursorId ?? snowflakeFor(boundary);
    job.channelId = channel.id;
    job.channelName = channel.name ?? channel.id;

    try {
      for (;;) {
        if (job.cancelled) break outer;

        const batch = await channel.messages.fetch({
          limit: PAGE_SIZE,
          before: cursor,
          cache: false,
        });

        if (!batch || batch.size === 0) {
          markEmojiBackfillDone(guildId, channel.id);
          break;
        }

        const fetched = [...batch.values()];
        const oldest = fetched.reduce(
          (min, message) => (message.createdTimestamp < min.createdTimestamp ? message : min),
          fetched[0],
        );
        const older = fetched
          .filter(
            (message) =>
              !message.system &&
              !message.author?.bot &&
              message.createdTimestamp < boundary,
          )
          .map((message) => ({
            content: message.content,
            at: message.createdTimestamp,
          }));

        const result = recordEmojiBackfillPage({
          guildId,
          channelId: channel.id,
          cursorId: oldest.id,
          done: batch.size < PAGE_SIZE,
          messages: older,
        });

        cursor = oldest.id;
        job.pages += 1;
        job.fetched += result.messages;
        job.emojiUses += result.emojiUses;

        if (job.pages % 25 === 0) {
          logger.info(
            `Emoji backfill ${guildId}: ${job.pages} page(s), ` +
              `${job.fetched} message(s), ${job.emojiUses} emoji use(s), ` +
              `now in #${job.channelName}`,
          );
        }

        if (batch.size < PAGE_SIZE) break;
      }
    } catch (error) {
      const message = error?.message ?? String(error);
      job.errors += 1;
      markEmojiBackfillError(guildId, channel.id, message);
      logger.warn(`Emoji backfill skipped #${job.channelName}: ${message}`);
    }
  }

  logger.info(
    `Emoji backfill ${job.cancelled ? 'stopped' : 'finished'} for ${guildId}: ` +
      `${job.pages} page(s), ${job.fetched} message(s), ${job.emojiUses} emoji use(s), ` +
      `${job.errors} skipped channel(s)`,
  );

  return job;
}
