import { config } from '../config.js';
import { zonedDate, zonedMidnightUnix } from '../lib/dates.js';
import { createLogger } from '../lib/logger.js';
import { getGuildSettings } from './birthday-store.js';
import {
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  getSummaryChannel,
  listSchedules,
  saveSummary,
  touchSchedule,
} from './report-store.js';
import { produceSummary, reportPayloads } from './report-runner.js';

const logger = createLogger('summary-scheduler');

export const TICK_MS = 60_000;
const MAX_WINDOW_MS = 168 * 60 * 60 * 1000;

/** `90m`, `6h`, `2d`, or a bare number of hours. Returns ms or null. */
export function parseInterval(text) {
  const match = /^(\d{1,3})\s*(m|min|h|hr|d)?$/i.exec(String(text ?? '').trim());

  if (!match) return null;

  const value = Number.parseInt(match[1], 10);
  const unit = (match[2] ?? 'h').toLowerCase();
  const ms = unit.startsWith('m') ? value * 60_000 : unit === 'd' ? value * 86_400_000 : value * 3_600_000;

  if (ms < MIN_INTERVAL_MS || ms > MAX_INTERVAL_MS) return null;

  return ms;
}

/** `09:00` / `9:00` → minute of day (0–1439), or null. */
export function parseClock(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());

  if (!match) return null;

  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);

  if (hour > 23 || minute > 59) return null;

  return hour * 60 + minute;
}

export function formatClock(minuteOfDay) {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function formatInterval(ms) {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;

  return `${Math.round(ms / 60_000)}m`;
}

/** The instant `minuteOfDay` occurs on the local day that contains `date`. */
function dailyInstant(date, timeZone, minuteOfDay) {
  const { year, month, day } = zonedDate(date, timeZone);

  return zonedMidnightUnix(year, month, day, timeZone) * 1000 + minuteOfDay * 60_000;
}

export function isScheduleDue(schedule, timeZone, now = Date.now()) {
  if (!schedule.enabled) return false;

  if (schedule.mode === 'daily') {
    const instant = dailyInstant(new Date(now), timeZone, schedule.minuteOfDay);
    return now >= instant && (schedule.lastRunAt ?? 0) < instant;
  }

  const base = schedule.lastRunAt ?? schedule.createdAt ?? now;

  return now - base >= (schedule.intervalMs ?? MAX_INTERVAL_MS);
}

/** When this schedule fires next, for the `/autoreport list` footer. */
export function nextRunAt(schedule, timeZone, now = Date.now()) {
  if (!schedule.enabled) return null;

  if (schedule.mode === 'daily') {
    const today = dailyInstant(new Date(now), timeZone, schedule.minuteOfDay);

    if (isScheduleDue(schedule, timeZone, now)) return now;

    return now < today ? today : today + 86_400_000;
  }

  const base = schedule.lastRunAt ?? schedule.createdAt ?? now;

  return Math.max(now, base + (schedule.intervalMs ?? MAX_INTERVAL_MS));
}

const running = new Set();

function localTimeZone(guildId) {
  return getGuildSettings(guildId).timezone ?? config.timezone;
}

/**
 * One scheduled report. Never throws: the tick loop must survive a channel
 * that was deleted, a rate limit, or a provider outage.
 */
export async function runScheduledReport(client, schedule, { now = Date.now() } = {}) {
  if (running.has(schedule.id)) return { skipped: 'already-running' };

  running.add(schedule.id);

  try {
    const destinationId = getSummaryChannel(schedule.guildId);

    if (!destinationId) {
      logger.warn(`Schedule for ${schedule.channelId} skipped: no summary channel is configured`);
      return { skipped: 'no-destination' };
    }

    const guild =
      client.guilds.cache.get(schedule.guildId) ??
      (await client.guilds.fetch(schedule.guildId).catch(() => null));

    if (!guild) {
      logger.warn(`Schedule for ${schedule.channelId} skipped: guild ${schedule.guildId} is unavailable`);
      return { skipped: 'no-guild' };
    }

    const source =
      guild.channels.cache.get(schedule.channelId) ??
      (await guild.channels.fetch(schedule.channelId).catch(() => null));
    const destination =
      guild.channels.cache.get(destinationId) ??
      (await guild.channels.fetch(destinationId).catch(() => null));

    if (!source || !destination) {
      logger.warn(`Schedule for ${schedule.channelId} skipped: channel or destination no longer exists`);
      touchSchedule(schedule.id, now);
      return { skipped: 'missing-channel' };
    }

    const timeZone = localTimeZone(schedule.guildId);
    const windowStart = Math.max(
      schedule.lastRunAt ?? schedule.createdAt ?? now,
      now - MAX_WINDOW_MS,
    );

    const { data, collected, meta, reason } = await produceSummary({
      guildId: schedule.guildId,
      channel: source,
      kind: schedule.kind,
      prompt: schedule.prompt,
      since: windowStart,
      until: now,
      timeZone,
      scheduleText:
        schedule.mode === 'daily'
          ? `Scheduled - Daily ${formatClock(schedule.minuteOfDay)} ${timeZone}`
          : `Scheduled - Every ${formatInterval(schedule.intervalMs ?? MAX_INTERVAL_MS)}`,
      requestedBy: 'an automatic schedule',
    });

    // Mark first: a failed post must not make the next tick re-read the same
    // window and double-charge the model.
    touchSchedule(schedule.id, now);

    if (!data) {
      logger.info(
        `Scheduled ${schedule.kind} report for #${source.name} skipped: ${
          reason === 'empty-summary' ? 'the model found nothing to report' : 'no messages'
        }`,
      );
      return { skipped: 'empty', reason };
    }

    const id = saveSummary({
      guildId: schedule.guildId,
      channelId: source.id,
      kind: schedule.kind,
      prompt: schedule.prompt,
      rangeStart: meta.rangeStart,
      rangeEnd: meta.rangeEnd,
      messageCount: meta.messageCount,
      body: data,
      createdBy: schedule.createdBy || 'scheduler',
    });

    // A detailed report is several messages, one embed each: Discord limits
    // the combined characters of all embeds in a single message to 6,000.
    const payloads = reportPayloads({ data, meta, id, collected });

    for (const payload of payloads) await destination.send(payload);

    logger.info(
      `Scheduled ${schedule.kind} report #${id} for #${source.name} delivered to #${destination.name}`,
    );

    return { delivered: true, id, messageCount: meta.messageCount };
  } catch (error) {
    logger.warn(`Scheduled report for ${schedule.channelId} failed: ${error.message}`);

    // Advance the clock even on failure. Otherwise a 429 (free Gemini quota,
    // provider outage) is retried every minute, burning quota and money on the
    // same window instead of waiting for the next real run.
    try {
      touchSchedule(schedule.id, now);
    } catch {
      // A failed bookkeeping write must not turn into a thrown tick.
    }

    return { skipped: 'error', error };
  } finally {
    running.delete(schedule.id);
  }
}

/**
 * Minute-level tick. Runs once immediately so a report that came due while the
 * bot was offline is not lost (the window is capped at seven days).
 */
export function startSummaryScheduler(client) {
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;

    try {
      const now = Date.now();

      for (const schedule of listSchedules()) {
        if (!schedule.enabled) continue;

        const timeZone = localTimeZone(schedule.guildId);

        if (!isScheduleDue(schedule, timeZone, now)) continue;

        await runScheduledReport(client, schedule, { now });
      }
    } catch (error) {
      logger.error('Summary scheduler tick failed', error);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(tick, TICK_MS);
  setImmediate(tick);

  return () => clearInterval(timer);
}
