**
 * @fileoverview Small Foundry document helpers.
 */

import { MODULE_ID } from '../constants/index.mjs';

/**
 * @param {foundry.abstract.Document|object|null|undefined} document
 * @param {string} flagKey
 * @returns {unknown}
 */
export function getFlag(document, flagKey) {
  if (!document) return undefined;
  if (typeof document.getFlag === 'function') {
    return document.getFlag(MODULE_ID, flagKey);
  }
  return document.flags?.[MODULE_ID]?.[flagKey];
}

/**
 * @param {string} uuid
 * @returns {Promise<foundry.abstract.Document|null>}
 */
export async function safeFromUuid(uuid) {
  try {
    return await fromUuid(uuid);
  } catch {
    return null;
  }
}