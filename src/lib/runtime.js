// Runtime capability checks for hosts we cannot inspect in advance.
//
// The bot stores everything in SQLite through Node's built-in `node:sqlite`.
// That module only exists from Node 22.5, and it needs the
// `--experimental-sqlite` flag until Node 23.4. Free hosting panels often ship
// an older image, so we detect it cheaply and explain the fix instead of
// letting the import blow up with "Cannot find module 'node:sqlite'".

export const SQLITE_FIRST_NODE = '22.5';
export const SQLITE_FLAG_FREE_NODE = '23.4';
export const RECOMMENDED_NODE = '24';

/**
 * True when this Node minor still needs `--experimental-sqlite` to load
 * `node:sqlite`. Kept separate from the message so it can be unit tested.
 */
export function needsSqliteFlag(version = process.versions.node) {
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10));

  if (!Number.isFinite(major)) return false;
  if (major === 22) return minor >= 5;
  if (major === 23) return minor < 4;

  return false;
}

/**
 * True when `node:sqlite` exists at all in this version.
 */
export function hasSqliteModule(version = process.versions.node) {
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10));

  if (!Number.isFinite(major)) return false;

  return major > 22 || (major === 22 && minor >= 5);
}

/**
 * Human-readable explanation printed when `node:sqlite` cannot be imported.
 */
export function sqliteUnavailableMessage(version = process.versions.node) {
  const lines = ['', `[boot] Node ${version} cannot load "node:sqlite".`];

  if (!hasSqliteModule(version)) {
    lines.push(
      `  This bot needs Node ${SQLITE_FIRST_NODE} or newer (Node ${RECOMMENDED_NODE} recommended).`,
      '',
      '  On a hosting panel:',
      '    1. Ask support to switch this server to the Node 24 image.',
      '    2. Or recreate the server and pick the newest Node.js image offered.',
      '    3. If the panel will not change it, this host cannot run the bot.',
    );
  } else if (needsSqliteFlag(version)) {
    lines.push(
      '  This version still hides SQLite behind a flag.',
      '',
      '  Fix the startup command to:',
      '    node --experimental-sqlite src/boot.js',
      '',
      `  Or upgrade to Node ${SQLITE_FLAG_FREE_NODE}+ (Node ${RECOMMENDED_NODE} recommended),`,
      '  where the flag is no longer needed.',
    );
  } else {
    lines.push('  Unexpected: the version looks supported. Check the full error above.');
  }

  lines.push('');
  return lines.join('\n');
}
