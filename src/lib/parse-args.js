/**
 * Splits prefix arguments. Double and single quotes group words, so
 * `:-echo "hello world"` arrives as one argument instead of two.
 */
export function parseArgs(content) {
  const args = [];
  let current = '';
  let quote = null;

  for (const char of content) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) args.push(current);

  return args;
}
