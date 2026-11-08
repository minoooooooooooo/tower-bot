import { execFileSync } from 'node:child_process';
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
 * The commit the process is actually running, so a deployment can be checked
 * from chat instead of guessing from the panel. Reading it is best-effort: a
 * copy without `.git` or without git installed simply reports `unknown`.
 */
export function buildInfo() {
  if (cached) return cached;

  try {
    cached = {
      commit: git(['rev-parse', '--short', 'HEAD']),
      date: git(['log', '-1', '--format=%cs']),
    };
  } catch (error) {
    logger.debug(`Could not read the git build: ${error.message}`);
    cached = { commit: null, date: null };
  }

  return cached;
}

/** One line for the boot log, e.g. `Build 1262a84 (2026-11-08)`. */
export function buildLabel() {
  const { commit, date } = buildInfo();

  if (!commit) return 'Build unknown (no git checkout)';

  return date ? `Build ${commit} (${date})` : `Build ${commit}`;
}
