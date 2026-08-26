// backend/logger.js

const MAX_BUFFER = 200;

let logBuffer = [];

/**
 * Push a log entry (keeps only the last MAX_BUFFER entries).
 * Each entry has a timestamp (epoch ms) and a message string.
 */
function pushLog(level, message) {
  const entry = {
    time: Date.now(),
    message: `[${level.toUpperCase()}] ${message}`
  };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER) {
    logBuffer = logBuffer.slice(-MAX_BUFFER);
  }
}

/**
 * Return all buffered logs and clear the buffer.
 * Used by the store/SSE to ship new logs to the client.
 */
function drainLogs() {
  const drained = [...logBuffer];
  logBuffer = [];
  return drained;
}

// Public logging methods
const logger = {
  info(msg) {
    console.log(`[INFO] ${msg}`);
    pushLog('info', msg);
  },
  warn(msg) {
    console.warn(`[WARN] ${msg}`);
    pushLog('warn', msg);
  },
  error(msg) {
    console.error(`[ERROR] ${msg}`);
    pushLog('error', msg);
  },
  debug(msg) {
    // only console, not buffered (keeps logs clean)
    console.debug(`[DEBUG] ${msg}`);
  },
  // For the store / SSE to get recent logs
  drainLogs
};

module.exports = logger;