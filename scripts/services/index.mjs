**
 * @fileoverview Service singletons barrel (tags, index, sources, picker, names, actors, compendium) and coordinated reload.
 */

import { MODULE_ID } from '../constants/index.mjs';
import { tag } from './tag.mjs';
import { tagIndex } from './tag-index.mjs';
import { source } from './source.mjs';
import { imagePicker } from './image-picker.mjs';
import { nameGenerator } from './name-generator.mjs';
import { actor } from './actor.mjs';
import { updateCompendiumVisibility } from './compendium.mjs';

export {
  tag,
  tagIndex,
  source,
  imagePicker,
  nameGenerator,
  actor,
  updateCompendiumVisibility,
};

let reloadTimer = null;
let activeReloadPromise = null;
let reloadQueued = false;

/**
 * Reload all data-dependent services in dependency order (`source` -> `tag` -> `tagIndex` + `nameGenerator`)
 * and refresh any open Data Manager window. Serializes concurrent calls.
 * @returns {Promise<void>}
 */
export async function reloadDataServices() {
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }

  if (activeReloadPromise) {
    reloadQueued = true;
    return activeReloadPromise;
  }

  activeReloadPromise = (async () => {
    do {
      reloadQueued = false;
      source.invalidateCache();
      await tag.reload();
      await Promise.all([
        tagIndex.reindex(),
        nameGenerator.reload(),
      ]);

      const openManager = foundry.applications?.instances?.get(`${MODULE_ID}-data-manager`);
      if (openManager && typeof openManager.refreshAllTabs === 'function') {
        openManager.refreshAllTabs();
      }
    } while (reloadQueued);
  })();

  try {
    await activeReloadPromise;
  } finally {
    activeReloadPromise = null;
  }
}

/**
 * Debounce a full data-services reload (e.g. during rapid `DATA_SOURCES` mutations).
 * @param {number} [delayMs=250]
 */
export function scheduleDataServicesReload(delayMs = 250) {
  source.invalidateCache();
  if (!tagIndex.isInitialized && !nameGenerator.isInitialized) {
    return;
  }
  if (reloadTimer) {
    clearTimeout(reloadTimer);
  }
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    reloadDataServices();
  }, delayMs);
}
