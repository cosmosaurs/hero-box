/**
 * @fileoverview Core module constants: re-exports and token placement mode.
 */

export * from './module.mjs';
export * from './settings.mjs';
export * from './tags.mjs';
export * from './ui.mjs';

/** Actor token behavior: reroll on each placement vs fixed linked token. */
export const TOKEN_MODE = Object.freeze({
  RANDOM: 'random',
  FIXED: 'fixed',
});