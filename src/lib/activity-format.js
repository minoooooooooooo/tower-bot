import { config } from '../config.js';
import { formatListDate, zonedDate } from './dates.js';

export const PERIOD_CHOICES = [
  { name: 'All time', value: 'all' },
  { name: 'Last 7 days', value: '7d' },
  { name: 'Last 30 days', value: '30d' },
];

export const PERIOD_LABELS = {
  all: 'All time',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};

export function formatNumber(value) {
  return Math.max(0, Number(value) || 0).toLocaleString('en-US');
}

/** "45s", "12m", "3h 07m" — compact enough for an embed field. */
export function formatVoiceTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));

  if (total < 60) return `${total}s`;

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

export function formatPeriod(period) {
  return PERIOD_LABELS[period] ?? PERIOD_LABELS.all;
}

/** "05 Nov 2026" in the bot's time zone. Safe inside a footer, unlike `<t:…>`. */
export function formatDate(ms) {
  if (!ms) return 'unknown';

  const { year, month, day } = zonedDate(new Date(ms), config.timezone);
  return formatListDate(year, month, day);
}

/** A fixed-width rank column: `01`, `02`, … `10`. */
export function rankBadge(index) {
  return `\`${String(index + 1).padStart(2, '0')}\``;
}

/** Discord relative timestamp, or "Never" when there is no recorded time. */
export function relativeTime(ms) {
  return ms ? `<t:${Math.floor(ms / 1000)}:R>` : 'Never';
}
