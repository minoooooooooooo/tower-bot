// Minutes and hours are what people type for a mute; days matter for bans.
// "1w" is accepted because a week is a common ban length.
const UNIT_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

// A year is long enough for any ban this bot should schedule, and stops a typo
// like "999999d" from parking a row in the database forever.
export const MAX_DURATION_MS = 365 * 24 * 60 * 60 * 1000;
export const MIN_DURATION_MS = 10 * 1000;

/**
 * Parses "40s", "10m", "2h", "7d", "1w", or a combination such as "1d12h".
 * Returns milliseconds, or null when the input is not a whole duration.
 */
export function parseDuration(input) {
  if (typeof input !== 'string') return null;

  const raw = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!raw) return null;

  const parts = raw.matchAll(/(\d+)(s|m|h|d|w)/g);
  let total = 0;
  let matched = false;
  let consumed = 0;

  for (const part of parts) {
    const [whole, amount, unit] = part;

    if (part.index !== consumed) return null;

    total += Number(amount) * UNIT_MS[unit];
    matched = true;
    consumed += whole.length;
  }

  if (!matched || consumed !== raw.length) return null;
  if (total < MIN_DURATION_MS || total > MAX_DURATION_MS) return null;

  return total;
}

/** Short human form used in replies: 40s, 10m, 2h, 7d. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';

  const seconds = Math.ceil(ms / 1000);

  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.ceil(seconds / 60);

  if (minutes < 60) return `${minutes}m`;

  const hours = Math.ceil(minutes / 60);

  if (hours < 48) return `${hours}h`;

  return `${Math.ceil(hours / 24)}d`;
}
