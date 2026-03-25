import { logger } from '../utils/index.mjs';
import { actor } from '../services/actor.mjs';

// intercept token creation to apply random images for random-mode actors
export function registerTokenHooks() {
  Hooks.on('preCreateToken', handlePreCreateToken);
  logger.debug('Token hooks registered');
}

// this fires before every token is created — we check if it's one of ours
function handlePreCreateToken(token, data, options, userId) {
  actor.applyRandomTokenImage(token);
}