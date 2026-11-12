**
 * @fileoverview Token lifecycle hooks: roll random art/name on placement, preserve appearance on copy/paste (`Ctrl+C`/`Ctrl+V`).
 */

import { MODULE_ID, FLAGS } from '../constants/index.mjs';
import { logger } from '../utils/index.mjs';
import { actor } from '../services/actor.mjs';

export function registerTokenHooks() {
  Hooks.on('preCreateActor', handlePreCreateActor);
  Hooks.on('pasteToken', handlePasteToken);
  Hooks.on('preCreateToken', handlePreCreateToken);
  logger.debug('Token hooks registered');
}

/**
 * When importing/creating a World Actor from a Compendium (`_stats.compendiumSource`),
 * clear any inherited `localOverride` flag so `CompendiumSource` settings take priority
 * until the GM explicitly opens and saves Hero in a Box settings on this actor.
 * @param {Actor} actorDoc
 */
function handlePreCreateActor(actorDoc) {
  if (actorDoc?.pack) return;
  const sourceUuid = actorDoc?._stats?.compendiumSource || actorDoc?.flags?.core?.sourceId;
  if (!sourceUuid || typeof sourceUuid !== 'string' || !sourceUuid.startsWith('Compendium.')) return;

  if (actorDoc.flags?.[MODULE_ID]?.[FLAGS.LOCAL_OVERRIDE] !== undefined) {
    actorDoc.updateSource({
      [`flags.${MODULE_ID}.-=${FLAGS.LOCAL_OVERRIDE}`]: null,
    });
  }
}

/**
 * Mark pasted token payloads as already rolled so pasting onto the same or another scene
 * preserves the copied token's appearance and name (including tokens created before v1.1).
 * @param {Token[]} copied
 * @param {object[]} createData
 */
function handlePasteToken(copied, createData) {
  if (!Array.isArray(createData)) return;
  for (const data of createData) {
    if (data && typeof data === 'object') {
      foundry.utils.setProperty(data, `flags.${MODULE_ID}.${FLAGS.TOKEN_ROLLED}`, true);
    }
  }
}

/**
 * @param {TokenDocument} token
 * @param {object} data
 * @param {object} options
 * @param {string} userId
 */
function handlePreCreateToken(token, data, options, userId) {
  actor.applyRandomTokenImage(token, options);
}