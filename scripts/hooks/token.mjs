/**
 * @fileoverview `preCreateToken` hook to roll random token art/name for random-mode actors.
 */

import { logger } from '../utils/index.mjs';
import { actor } from '../services/actor.mjs';

export function registerTokenHooks() {
  Hooks.on('preCreateToken', handlePreCreateToken);
  logger.debug('Token hooks registered');
}

/**
 * @param {TokenDocument} token
 * @param {object} data
 * @param {object} options
 * @param {string} userId
 */
function handlePreCreateToken(token, data, options, userId) {
  actor.applyRandomTokenImage(token);
}