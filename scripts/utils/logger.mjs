/**
 * @fileoverview Namespaced console logging with configurable minimum level and simple timers.
 */

import { MODULE_ID } from '../constants/index.mjs';

const PREFIX = `[${MODULE_ID.toUpperCase()}]`;

const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

let currentLevel = LogLevel.WARN;

/**
 * @param {'debug'|'info'|'warn'|'error'} level
 */
export function setLogLevel(level) {
  currentLevel = LogLevel[level.toUpperCase()] ?? LogLevel.WARN;
}

/** Module logger: debug/info/warn/error plus {@link logger.time}. */
export const logger = {
  /** @param {...unknown} args */
  debug(...args) {
    if (currentLevel <= LogLevel.DEBUG) {
      console.debug(PREFIX, ...args);
    }
  },

  /** @param {...unknown} args */
  info(...args) {
    if (currentLevel <= LogLevel.INFO) {
      console.log(PREFIX, ...args);
    }
  },

  /** @param {...unknown} args */
  warn(...args) {
    if (currentLevel <= LogLevel.WARN) {
      console.warn(PREFIX, ...args);
    }
  },

  /** @param {...unknown} args */
  error(...args) {
    console.error(PREFIX, ...args);
  },

  /**
   * @param {string} label
   * @returns {{ end: () => void }}
   */
  time(label) {
    const start = performance.now();
    return {
      end: () => {
        const duration = performance.now() - start;
        if (currentLevel <= LogLevel.DEBUG) {
          console.debug(PREFIX, `${label}: ${duration.toFixed(2)}ms`);
        }
      }
    };
  }
};
