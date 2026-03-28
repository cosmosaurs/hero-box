/**
 * @fileoverview `ready` hook: compendium visibility, then source/tag/index/name services in order.
 */

import { logger } from '../utils/index.mjs';
import { tagIndex } from '../services/tag-index.mjs';
import { nameGenerator } from '../services/name-generator.mjs';
import { tag } from '../services/tag.mjs';
import { source } from '../services/source.mjs';
import { updateCompendiumVisibility } from '../services/compendium.mjs';

export function registerReadyHooks() {
  Hooks.once('ready', async () => {
    logger.info('World ready, starting services...');

    await updateCompendiumVisibility();
    await initializeServices();

    logger.info('All services started');
  });
}

/** Start `source`, `tag`, `tagIndex`, and `nameGenerator` after world ready. */
async function initializeServices() {
  const timer = logger.time('Services initialization');

  try {
    // sources first — everything else depends on knowing where to load from
    await source.initialize();

    // tags before index — we need tag definitions to build search strings
    await tag.initialize();

    // index and names can load in parallel
    await Promise.all([
      tagIndex.initialize(),
      nameGenerator.initialize(),
    ]);

    const stats = tagIndex.getStats();
    logger.debug('Index stats:', {
      images: stats.totalImages,
      tags: stats.totalTags,
    });
  } catch (error) {
    logger.error('Failed to initialize services:', error);
  }

  timer.end();
}