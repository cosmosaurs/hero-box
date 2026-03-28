import { MODULE_ID } from '../constants/index.mjs';

const PREFIX = `[${MODULE_ID.toUpperCase()}]`;

const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

let currentLevel = LogLevel.WARN;

// switch the minimum log level (debug/info/warn/error)
export function setLogLevel(level) {
  currentLevel = LogLevel[level.toUpperCase()] ?? LogLevel.WARN;
}

export const logger = {
  // verbose stuff, only visible in dev mode
  debug(...args) {
    if (currentLevel <= LogLevel.DEBUG) {
      console.debug(PREFIX, ...args);
    }
  },

  // general "hey this happened" messages
  info(...args) {
    if (currentLevel <= LogLevel.INFO) {
      console.log(PREFIX, ...args);
    }
  },

  // something smells but we can keep going
  warn(...args) {
    if (currentLevel <= LogLevel.WARN) {
      console.warn(PREFIX, ...args);
    }
  },

  // something broke, always shown
  error(...args) {
    console.error(PREFIX, ...args);
  },

  // start a timer, call .end() to log how long it took
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
