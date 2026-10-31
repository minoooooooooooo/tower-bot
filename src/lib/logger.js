const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const COLORS = {
  error: '\u001b[31m',
  warn: '\u001b[33m',
  info: '\u001b[36m',
  debug: '\u001b[90m',
};

const RESET = '\u001b[0m';

const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function describe(meta) {
  if (meta === undefined) return '';
  if (meta instanceof Error) return `\n${meta.stack ?? meta.message}`;
  if (typeof meta === 'string') return ` ${meta}`;
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ` ${String(meta)}`;
  }
}

function emit(level, scope, message, meta) {
  if ((LEVELS[level] ?? LEVELS.info) > threshold) return;

  const line = `${timestamp()} ${COLORS[level]}${level.toUpperCase().padEnd(5)}${RESET} [${scope}] ${message}${describe(meta)}`;

  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export function createLogger(scope = 'bot') {
  return {
    error: (message, meta) => emit('error', scope, message, meta),
    warn: (message, meta) => emit('warn', scope, message, meta),
    info: (message, meta) => emit('info', scope, message, meta),
    debug: (message, meta) => emit('debug', scope, message, meta),
  };
}

export const logger = createLogger('bot');
