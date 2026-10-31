/**
 * Shared text helpers for the greeting-style templates (`birthday message`,
 * `welcome edit`). Kept in lib so both services can use them without importing
 * each other.
 */

/**
 * Replace `{placeholders}` and tidy the result, so a blank value does not leave
 * a double space or "  today" behind. Unknown placeholders are left literal.
 */
export function renderMessage(template, values) {
  return String(template ?? '')
    .replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.!?;:])/g, '$1')
    .trim();
}

/**
 * Placeholders used by a template that the renderer cannot fill. Reported back
 * to whoever edited the text instead of silently printing braces.
 */
export function unknownPlaceholders(template, allowedKeys) {
  const allowed = new Set(allowedKeys);
  const found = new Set();

  for (const match of String(template ?? '').matchAll(/\{(\w+)\}/g)) {
    if (!allowed.has(match[1])) found.add(match[1]);
  }

  return [...found];
}

/** 1 -> "1st", 22 -> "22nd", 113 -> "113th". */
export function ordinal(value) {
  const number = Number(value);
  const remainder = Math.abs(number) % 100;

  if (remainder >= 11 && remainder <= 13) return `${number}th`;

  switch (Math.abs(number) % 10) {
    case 1:
      return `${number}st`;
    case 2:
      return `${number}nd`;
    case 3:
      return `${number}rd`;
    default:
      return `${number}th`;
  }
}
