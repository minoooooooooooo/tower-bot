const MS_PER_DAY = 86_400_000;

export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Wall-clock date in a given IANA time zone.
 */
export function zonedDate(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const values = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

const pad = (value) => String(value).padStart(2, '0');

/**
 * Stable YYYY-MM-DD key for a time zone, used to detect "a new day started".
 */
export function dateKey(date, timeZone) {
  const { year, month, day } = zonedDate(date, timeZone);
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Feb 29 birthdays are celebrated on Feb 28 in non-leap years.
 */
export function effectiveDay(year, month, day) {
  if (month === 2 && day === 29 && !isLeapYear(year)) return 28;
  return day;
}

export function isBirthdayToday(month, day, timeZone, now = new Date()) {
  const today = zonedDate(now, timeZone);
  if (today.month !== month) return false;
  return today.day === effectiveDay(today.year, month, day);
}

/**
 * Days from today until the next occurrence. 0 means today.
 */
export function daysUntil(month, day, timeZone, now = new Date()) {
  const today = zonedDate(now, timeZone);
  const todayMs = Date.UTC(today.year, today.month - 1, today.day);

  let targetMs = Date.UTC(today.year, month - 1, effectiveDay(today.year, month, day));

  if (targetMs < todayMs) {
    const nextYear = today.year + 1;
    targetMs = Date.UTC(nextYear, month - 1, effectiveDay(nextYear, month, day));
  }

  return Math.round((targetMs - todayMs) / MS_PER_DAY);
}

/**
 * Concrete next date, including weekday, for a recurring month/day.
 */
export function nextOccurrence(month, day, timeZone, now = new Date()) {
  const today = zonedDate(now, timeZone);
  const todayMs = Date.UTC(today.year, today.month - 1, today.day);

  let year = today.year;
  let targetDay = effectiveDay(year, month, day);
  let targetMs = Date.UTC(year, month - 1, targetDay);

  if (targetMs < todayMs) {
    year += 1;
    targetDay = effectiveDay(year, month, day);
    targetMs = Date.UTC(year, month - 1, targetDay);
  }

  return {
    year,
    month,
    day: targetDay,
    days: Math.round((targetMs - todayMs) / MS_PER_DAY),
    weekday: new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(
      new Date(targetMs),
    ),
    formatted: new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(targetMs)),
  };
}

/**
 * "May 14" style label. Uses a leap reference year so Feb 29 is formattable.
 */
export function formatMonthDay(month, day) {
  const date = new Date(Date.UTC(2000, month - 1, day));
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Age the member turns on their birthday. Returns null when the birth year was
 * not saved, so greeting templates can leave the number out.
 */
export function ageTurning(year, timeZone, now = new Date()) {
  if (!Number.isInteger(year)) return null;
  return zonedDate(now, timeZone).year - year;
}

/**
 * Human readable "now" in a zone, for confirmation messages.
 */
export function describeNow(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(now);
}
