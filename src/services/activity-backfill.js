import { createLogger } from '../lib/logger.js';
import {
  auditChannel,
  backfillChannel,
  markAuditDone,
  markAuditError,
  markBackfillDone,
  markBackfillError,
  recordAuditPage,
  recordBackfillPage,
  trackingSince,
} from './activity-store.js';

const logger = createLogger('backfill');

const DISCORD_EPOCH = 1420070400000n;
const PAGE_SIZE = 100;

/** One job per guild; the row survives restarts, the job object does not. */
const jobs = new Map();
const auditJobs = new Map();

/**
 * Discord message ids are snowflakes. `before` accepts an id, not a timestamp,
 * so the live start has to be converted before the first page.
 */
export function snowflakeFor(ms) {
  const value = BigInt(Math.max(0, Math.floor(Number(ms) || 0)));
  return ((value - DISCORD_EPOCH) << 22n).toString();
}

/**
 * Text history only. Threads are skipped because the live tracker folds them
 * into their parent, and replaying only some threads would make the totals
 * depend on which ones happened to be cached.
 */
export function backfillableChannels(guild) {
  const channels = guild.channels?.cache?.values
    ? [...guild.channels.cache.values()]
    : [];

  return channels
    .filter(
      (channel) =>
        channel?.messages?.fetch &&
        channel.isTextBased?.() &&
        !channel.isThread?.(),
    )
    .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0) || a.id.localeCompare(b.id));
}

export function countBackfillableChannels(guild) {
  return backfillableChannels(guild).length;
}

export function currentBackfillJob(guildId) {
  return jobs.get(guildId) ?? null;
}

export function cancelBackfill(guildId) {
  const job = jobs.get(guildId);

  if (!job || job.finishedAt) return null;

  job.cancelled = true;
  return job;
}

export function currentAuditJob(guildId) {
  return auditJobs.get(guildId) ?? null;
}

export function cancelAudit(guildId) {
  const job = auditJobs.get(guildId);

  if (!job || job.finishedAt) return null;

  job.cancelled = true;
  return job;
}

/** Shutdown: stop both jobs after the page in flight so SQLite can close cleanly. */
export function stopBackfill() {
  for (const job of [...jobs.values(), ...auditJobs.values()]) {
    if (!job.finishedAt) job.cancelled = true;
  }
}

function makeJob(guildId) {
  return {
    guildId,
    startedAt: Date.now(),
    finishedAt: null,
    cancelled: false,
    pages: 0,
    fetched: 0,
    seen: 0,
    errors: 0,
    channelId: null,
    channelName: null,
    error: null,
  };
}

/**
 * Starts a background import. Returns immediately so the command can answer;
 * `/backfill status` reads the persisted rows while this runs.
 */
export function startBackfill(client, guildId) {
  const running = jobs.get(guildId);

  if (running && !running.finishedAt) {
    return { started: false, job: running, reason: 'import' };
  }

  const audit = auditJobs.get(guildId);

  if (audit && !audit.finishedAt) {
    return { started: false, job: audit, reason: 'audit' };
  }

  const job = makeJob(guildId);
  jobs.set(guildId, job);

  runBackfill(client, guildId, job)
    .catch((error) => {
      job.error = error;
      logger.error(`Backfill failed for ${guildId}`, error);
    })
    .finally(() => {
      job.finishedAt = Date.now();
    });

  return { started: true, job };
}

/**
 * Walks each channel backwards from the live tracking start. Every page and its
 * cursor are committed together, so restarting mid-import continues at the last
 * complete page instead of double-counting.
 */
export async function runBackfill(client, guildId, job = makeJob(guildId)) {
  const guild =
    client.guilds?.cache?.get(guildId) ??
    (await client.guilds?.fetch?.(guildId).catch(() => null));

  if (!guild) throw new Error(`Guild ${guildId} is not available`);

  const liveSince = trackingSince(guildId) ?? Date.now();
  const pending = backfillableChannels(guild).filter(
    (channel) => !backfillChannel(guildId, channel.id)?.done,
  );

  logger.info(
    `Backfill started for ${guildId}: ${pending.length} channel(s), messages older than ` +
      `${new Date(liveSince).toISOString()}`,
  );

  outer: for (const channel of pending) {
    if (job.cancelled) break;

    const state = backfillChannel(guildId, channel.id);
    let cursor = state?.cursorId ?? snowflakeFor(liveSince);
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
          markBackfillDone(guildId, channel.id);
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
              message.createdTimestamp < liveSince,
          )
          .map((message) => ({ userId: message.author?.id, at: message.createdTimestamp }));

        recordBackfillPage({
          guildId,
          channelId: channel.id,
          cursorId: oldest.id,
          done: batch.size < PAGE_SIZE,
          messages: older,
        });

        cursor = oldest.id;
        job.pages += 1;
        job.fetched += older.length;

        if (job.pages % 25 === 0) {
          logger.info(
            `Backfill ${guildId}: ${job.pages} page(s), ${job.fetched} message(s), ` +
              `now in #${job.channelName}`,
          );
        }

        if (batch.size < PAGE_SIZE) break;
      }
    } catch (error) {
      const message = error?.message ?? String(error);
      job.errors += 1;
      markBackfillError(guildId, channel.id, message);
      logger.warn(`Backfill skipped #${job.channelName}: ${message}`);
    }
  }

  logger.info(
    `Backfill ${job.cancelled ? 'stopped' : 'finished'} for ${guildId}: ` +
      `${job.pages} page(s), ${job.fetched} message(s), ${job.errors} skipped channel(s)`,
  );

  return job;
}

/**
 * Dry run for the message totals. It walks the same channels as the importer
 * and classifies every fetched message, but never touches activity_members,
 * activity_channels or the day buckets.
 */
export function startAudit(client, guildId) {
  const running = auditJobs.get(guildId);

  if (running && !running.finishedAt) {
    return { started: false, job: running, reason: 'audit' };
  }

  const importJob = jobs.get(guildId);

  if (importJob && !importJob.finishedAt) {
    return { started: false, job: importJob, reason: 'import' };
  }

  const job = makeJob(guildId);
  auditJobs.set(guildId, job);

  runAudit(client, guildId, job)
    .catch((error) => {
      job.error = error;
      logger.error(`Backfill audit failed for ${guildId}`, error);
    })
    .finally(() => {
      job.finishedAt = Date.now();
    });

  return { started: true, job };
}

export async function runAudit(client, guildId, job = makeJob(guildId)) {
  const guild =
    client.guilds?.cache?.get(guildId) ??
    (await client.guilds?.fetch?.(guildId).catch(() => null));

  if (!guild) throw new Error(`Guild ${guildId} is not available`);

  const liveSince = trackingSince(guildId) ?? Date.now();
  const pending = backfillableChannels(guild).filter(
    (channel) => !auditChannel(guildId, channel.id)?.done,
  );

  logger.info(
    `Backfill audit started for ${guildId}: ${pending.length} channel(s), ` +
      `live boundary ${new Date(liveSince).toISOString()}`,
  );

  outer: for (const channel of pending) {
    if (job.cancelled) break;

    const state = auditChannel(guildId, channel.id);
    let cursor = state?.cursorId ?? null;
    job.channelId = channel.id;
    job.channelName = channel.name ?? channel.id;

    try {
      for (;;) {
        if (job.cancelled) break outer;

        const options = { limit: PAGE_SIZE, cache: false };
        if (cursor) options.before = cursor;

        const batch = await channel.messages.fetch(options);

        if (!batch || batch.size === 0) {
          markAuditDone(guildId, channel.id);
          break;
        }

        const fetched = [...batch.values()];
        const oldest = fetched.reduce(
          (min, message) => (message.createdTimestamp < min.createdTimestamp ? message : min),
          fetched[0],
        );

        let bots = 0;
        let system = 0;
        let newer = 0;
        let human = 0;

        for (const message of fetched) {
          if (message.system) system += 1;
          else if (message.author?.bot) bots += 1;
          else if (message.createdTimestamp >= liveSince) newer += 1;
          else human += 1;
        }

        recordAuditPage({
          guildId,
          channelId: channel.id,
          cursorId: oldest.id,
          oldestAt: oldest.createdTimestamp,
          done: batch.size < PAGE_SIZE,
          seen: fetched.length,
          bots,
          system,
          newer,
          human,
        });

        cursor = oldest.id;
        job.pages += 1;
        job.seen += fetched.length;

        if (job.pages % 25 === 0) {
          logger.info(
            `Backfill audit ${guildId}: ${job.pages} page(s), ${job.seen} message(s), ` +
              `now in #${job.channelName}`,
          );
        }

        if (batch.size < PAGE_SIZE) break;
      }
    } catch (error) {
      const message = error?.message ?? String(error);
      job.errors += 1;
      markAuditError(guildId, channel.id, message);
      logger.warn(`Backfill audit skipped #${job.channelName}: ${message}`);
    }
  }

  logger.info(
    `Backfill audit ${job.cancelled ? 'stopped' : 'finished'} for ${guildId}: ` +
      `${job.pages} page(s), ${job.seen} message(s), ${job.errors} skipped channel(s)`,
  );

  return job;
}
