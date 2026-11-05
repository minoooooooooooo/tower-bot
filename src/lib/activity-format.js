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

export function medalFor(index) {
  return ['🥇', '🥈', '🥉'][index] ?? `**${index + 1}.**`;
}

/** Discord relative timestamp, or "Never" when there is no recorded time. */
export function relativeTime(ms) {
  return ms ? `<t:${Math.floor(ms / 1000)}:R>` : 'Never';
}

export function shortDate(ms) {
  return ms ? `<t:${Math.floor(ms / 1000)}:D>` : 'Unknown';
}
