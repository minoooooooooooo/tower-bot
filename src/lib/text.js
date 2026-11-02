// Arabic diacritics, tatweel, and the alef/ya/ta-marbuta variants that people
// type inconsistently. Normalizing both sides makes "مُحَمّد" match "محمد".
const DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

/**
 * Case- and diacritic-insensitive form used for matching user-typed words
 * against stored ones (keyword alerts, command aliases).
 */
export function normalizeForMatch(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(DIACRITICS, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ئ/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim();
}
