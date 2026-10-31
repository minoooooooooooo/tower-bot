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

  if (!value) return `Paste a direct image/${label} URL, or use \`none\` to remove it.`;
  if (value.length > MAX_IMAGE_URL_LENGTH) {
    return `The ${label} link must be ${MAX_IMAGE_URL_LENGTH} characters or fewer.`;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return 'That is not a valid URL.';
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `The ${label} link must start with http:// or https://.`;
  }

  return null;
}
