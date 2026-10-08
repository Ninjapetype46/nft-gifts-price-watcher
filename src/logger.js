// Minimal leveled logger on top of console. Configured once in index.js.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;

export function setLogLevel(level) {
  threshold = LEVELS[level] ?? LEVELS.info;
}

function emit(level, scope, args) {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line, ...args);
}

/** @param {string} scope */
export function createLogger(scope) {
  return {
    debug: (...a) => emit('debug', scope, a),
    info: (...a) => emit('info', scope, a),
    warn: (...a) => emit('warn', scope, a),
    error: (...a) => emit('error', scope, a),
  };
}
