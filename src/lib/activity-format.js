import { config } from '../config.js';
import { formatListDate, zonedDate } from './dates.js';

export const PERIOD_CHOICES = [
  { name: 'كل الوقت', value: 'all' },
  { name: 'آخر 7 أيام', value: '7d' },
  { name: 'آخر 30 يوم', value: '30d' },
];

export const PERIOD_LABELS = {
  all: 'كل الوقت',
  '7d': 'آخر 7 أيام',
  '30d': 'آخر 30 يوم',
};

export function formatNumber(value) {
  return Math.max(0, Number(value) || 0).toLocaleString('en-US');
}

/** "45ث", "12د", "3س 07د" — compact enough for an embed field. */
export function formatVoiceTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));

  if (total < 60) return `${total}ث`;

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (hours > 0) return minutes > 0 ? `${hours}س ${minutes}د` : `${hours}س`;
  return `${minutes}د`;
}

export function formatPeriod(period) {
  return PERIOD_LABELS[period] ?? PERIOD_LABELS.all;
}

/** "05 Nov 2026" in the bot's time zone. Safe inside a footer, unlike `<t:…>`. */
export function formatDate(ms) {
  if (!ms) return 'غير معروف';

  const { year, month, day } = zonedDate(new Date(ms), config.timezone);
  return formatListDate(year, month, day);
}

/** A fixed-width rank column: `01`, `02`, … `10`. */
export function rankBadge(index) {
  return `\`${String(index + 1).padStart(2, '0')}\``;
}

/** Discord relative timestamp, or "ما فيه" when there is no recorded time. */
export function relativeTime(ms) {
  return ms ? `<t:${Math.floor(ms / 1000)}:R>` : 'ما فيه';
}
