// core/logger.js — Structured Logger for Aeldorado
// Aeldorado by Solanacy Technologies

const IS_PROD = process.env.NODE_ENV === "production";

/**
 * Standardized logging levels.
 */
const LEVELS = {
  INFO:  "INFO",
  WARN:  "WARN",
  ERROR: "ERROR",
  DEBUG: "DEBUG",
};

/**
 * Format and print logs.
 *
 * @param {string} level
 * @param {string} message
 * @param {object} [meta]
 */
function log(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const payload = {
    timestamp,
    level,
    message,
    ...meta,
    service: "aeldorado-api",
  };

  if (IS_PROD) {
    // In production, log as a single line of JSON for log aggregators
    console.log(JSON.stringify(payload));
  } else {
    // In development, log in a more readable format
    const color = level === LEVELS.ERROR ? "\x1b[31m" : level === LEVELS.WARN ? "\x1b[33m" : "\x1b[32m";
    const reset = "\x1b[0m";
    console.log(`[${timestamp}] ${color}${level}${reset}: ${message}`, Object.keys(meta).length ? meta : "");
  }
}

export const logger = {
  info:  (msg, meta) => log(LEVELS.INFO, msg, meta),
  warn:  (msg, meta) => log(LEVELS.WARN, msg, meta),
  error: (msg, meta) => log(LEVELS.ERROR, msg, meta),
  debug: (msg, meta) => !IS_PROD && log(LEVELS.DEBUG, msg, meta),
};

