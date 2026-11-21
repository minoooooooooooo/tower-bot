/**
 * Shared URL handling for the embed images the bot accepts (birthday GIF,
 * welcome GIF). Kept in lib so both features validate the same way.
 */

export const MAX_IMAGE_URL_LENGTH = 1000;

export function isClearValue(value) {
  return ['none', 'off', 'clear', 'remove', '-'].includes(String(value ?? '').trim().toLowerCase());
}

/**
 * Validates a direct image URL. Returns a human-readable problem, or null.
 * Tenor/Giphy *pages* pass this check but do not render — the preview is what
 * catches those.
 */
export function validateImageUrl(raw, label = 'GIF') {
  const value = String(raw ?? '').trim();

  if (!value) return `الصق رابط صورة أو ${label} مباشر، أو استخدم \`none\` عشان تشيله.`;
  if (value.length > MAX_IMAGE_URL_LENGTH) {
    return `رابط ${label} لازم يكون ${MAX_IMAGE_URL_LENGTH} حرف أو أقل.`;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return 'هذا مو رابط صحيح.';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `رابط ${label} لازم يبدأ بـ http:// أو https://.`;
  }

  return null;
}
