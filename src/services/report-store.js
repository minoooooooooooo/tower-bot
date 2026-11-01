import { getDb } from '../lib/db.js';

/** The channel that receives reports. Falls back to the invoking channel. */
export function getSummaryChannel(guildId) {
  const row = getDb()
    .prepare('SELECT channel_id FROM summary_settings WHERE guild_id = ?')
    .get(guildId);

  return row?.channel_id ?? null;
}

export function setSummaryChannel(guildId, channelId) {
  if (!channelId) {
    getDb()
      .prepare(
        `INSERT INTO summary_settings (guild_id, channel_id, updated_at) VALUES (?, NULL, ?)
         ON CONFLICT (guild_id) DO UPDATE SET channel_id = NULL, updated_at = excluded.updated_at`,
      )
      .run(guildId, Date.now());
    return null;
  }

  getDb()
    .prepare(
      `INSERT INTO summary_settings (guild_id, channel_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (guild_id) DO UPDATE SET
         channel_id = excluded.channel_id,
         updated_at = excluded.updated_at`,
    )
    .run(guildId, channelId, Date.now());

  return channelId;
}

/**
 * Persists a finished report. `body` is the structured payload so an export
 * never has to call the model again.
 */
export function saveSummary({
  guildId,
  channelId,
  kind,
  prompt = null,
  rangeStart,
  rangeEnd,
  messageCount,
  body,
  createdBy,
}) {
  const result = getDb()
    .prepare(
      `INSERT INTO summaries
         (guild_id, channel_id, kind, prompt, range_start, range_end,
          message_count, body, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      guildId,
      channelId,
      kind,
      prompt,
      rangeStart,
      rangeEnd,
      messageCount,
      JSON.stringify(body),
      createdBy,
      Date.now(),
    );

  return Number(result.lastInsertRowid);
}

function mapSummary(row) {
  if (!row) return null;

  let body = null;

  try {
    body = JSON.parse(row.body);
  } catch {
    body = null;
  }

  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    kind: row.kind,
    prompt: row.prompt,
    rangeStart: row.range_start,
    rangeEnd: row.range_end,
    messageCount: row.message_count,
    body,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function getSummary(guildId, id) {
  return mapSummary(
    getDb().prepare('SELECT * FROM summaries WHERE guild_id = ? AND id = ?').get(guildId, id),
  );
}

export function listSummaries(guildId, limit = 10) {
  return getDb()
    .prepare('SELECT * FROM summaries WHERE guild_id = ? ORDER BY id DESC LIMIT ?')
    .all(guildId, limit)
    .map(mapSummary);
}

// --- scheduled reports ------------------------------------------------------

export const MIN_INTERVAL_MS = 15 * 60 * 1000;
export const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

function mapSchedule(row) {
  if (!row) return null;

  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    kind: row.kind,
    prompt: row.prompt,
    mode: row.mode,
    intervalMs: row.interval_ms,
    minuteOfDay: row.minute_of_day,
    enabled: Boolean(row.enabled),
    lastRunAt: row.last_run_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function listSchedules(guildId = null) {
  const db = getDb();

  return (guildId
    ? db.prepare('SELECT * FROM summary_schedules WHERE guild_id = ? ORDER BY channel_id').all(guildId)
    : db.prepare('SELECT * FROM summary_schedules ORDER BY guild_id, channel_id').all()
  ).map(mapSchedule);
}

export function getSchedule(guildId, channelId) {
  return mapSchedule(
    getDb()
      .prepare('SELECT * FROM summary_schedules WHERE guild_id = ? AND channel_id = ?')
      .get(guildId, channelId),
  );
}

/**
 * One schedule per channel: saving again replaces the cadence and restarts the
 * countdown, so "every 6h" begins now instead of firing on the old clock.
 */
export function upsertSchedule({
  guildId,
  channelId,
  kind,
  prompt = null,
  mode,
  intervalMs = null,
  minuteOfDay = null,
  createdBy,
  now = Date.now(),
}) {
  getDb()
    .prepare(
      `INSERT INTO summary_schedules
         (guild_id, channel_id, kind, prompt, mode, interval_ms, minute_of_day,
          enabled, last_run_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT (guild_id, channel_id) DO UPDATE SET
         kind = excluded.kind,
         prompt = excluded.prompt,
         mode = excluded.mode,
         interval_ms = excluded.interval_ms,
         minute_of_day = excluded.minute_of_day,
         enabled = 1,
         last_run_at = excluded.last_run_at,
         created_by = excluded.created_by`,
    )
    .run(
      guildId,
      channelId,
      kind,
      prompt,
      mode,
      intervalMs,
      minuteOfDay,
      now,
      createdBy,
      now,
    );

  return getSchedule(guildId, channelId);
}

export function removeSchedule(guildId, channelId) {
  return getDb()
    .prepare('DELETE FROM summary_schedules WHERE guild_id = ? AND channel_id = ?')
    .run(guildId, channelId).changes;
}

export function setScheduleEnabled(guildId, channelId, enabled) {
  return getDb()
    .prepare('UPDATE summary_schedules SET enabled = ? WHERE guild_id = ? AND channel_id = ?')
    .run(enabled ? 1 : 0, guildId, channelId).changes;
}

export function touchSchedule(id, at = Date.now()) {
  getDb().prepare('UPDATE summary_schedules SET last_run_at = ? WHERE id = ?').run(at, id);
}

// --- glossary ---------------------------------------------------------------

export const MAX_GLOSSARY_TERMS = 200;
export const MAX_TERM_LENGTH = 60;
export const MAX_MEANING_LENGTH = 200;

export function listGlossary(guildId) {
  return getDb()
    .prepare('SELECT term, meaning FROM glossary WHERE guild_id = ? ORDER BY term COLLATE NOCASE')
    .all(guildId);
}

export function setGlossaryTerm(guildId, term, meaning) {
  getDb()
    .prepare(
      `INSERT INTO glossary (guild_id, term, meaning, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (guild_id, term) DO UPDATE SET
         meaning = excluded.meaning,
         updated_at = excluded.updated_at`,
    )
    .run(guildId, term, meaning, Date.now());
}

export function removeGlossaryTerm(guildId, term) {
  return getDb()
    .prepare('DELETE FROM glossary WHERE guild_id = ? AND term = ?')
    .run(guildId, term).changes;
}

export function clearGlossary(guildId) {
  return getDb().prepare('DELETE FROM glossary WHERE guild_id = ?').run(guildId).changes;
}

/**
 * The glossary as prompt lines. Capped so a runaway list cannot crowd out the
 * transcript itself.
 */
export function glossaryPrompt(guildId, maxChars = 1800) {
  const lines = [];
  let size = 0;

  for (const entry of listGlossary(guildId)) {
    const line = `- ${entry.term}: ${entry.meaning}`;

    if (size + line.length > maxChars) break;

    lines.push(line);
    size += line.length + 1;
  }

  return lines.join('\n');
}
