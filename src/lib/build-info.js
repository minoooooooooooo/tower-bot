import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { rootDir } from '../config.js';
import { createLogger } from './logger.js';

const logger = createLogger('build');

let cached = null;

function git(args) {
  return execFileSync('git', args, {
    cwd: rootDir,
    timeout: 3000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * A zip built by `package.ps1` carries `build.json` with the commit it was
 * built from. That is the only honest answer on a panel where the zip is
 * extracted over an old checkout: the `.git` folder there still points at the
 * last commit that was pulled, not at the uploaded files.
 */
function marker() {
  try {
    // Strip a UTF-8 BOM: PowerShell's default writers may add one, and
    // JSON.parse refuses it.
    const raw = readFileSync(path.join(rootDir, 'build.json'), 'utf8').replace(/^\uFEFF/, '');
    const data = JSON.parse(raw);

    if (!data?.commit) return null;

    return { commit: String(data.commit), date: data.date ? String(data.date) : null };
  } catch {
    return null;
  }
}

/**
 * The commit the process is actually running, so a deployment can be checked
 * from chat instead of guessing from the panel. A packaged upload is read from
 * `build.json`; a git checkout is asked directly; a copy with neither reports
 * `unknown` and never fails boot.
 */
export function buildInfo() {
  if (cached) return cached;

  cached = marker();

  if (!cached) {
    try {
      cached = {
        commit: git(['rev-parse', '--short', 'HEAD']),
        date: git(['log', '-1', '--format=%cs']),
      };
    } catch (error) {
      logger.debug(`Could not read the git build: ${error.message}`);
      cached = { commit: null, date: null };
    }
  }

  return cached;
}

/** One line for the boot log, e.g. `Build 1262a84 (2026-11-08)`. */
export function buildLabel() {
  const { commit, date } = buildInfo();

  if (!commit) return 'Build unknown (no build marker or git checkout)';

  return date ? `Build ${commit} (${date})` : `Build ${commit}`;
}
