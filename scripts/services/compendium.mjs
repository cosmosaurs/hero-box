/**
 * @fileoverview Toggles visibility of the module's internal data compendium from developer mode.
 */

import { PACKS, SETTINGS } from '../constants/index.mjs';
import { logger } from '../utils/index.mjs';
import { getSetting } from '../settings.mjs';

/** Show or hide the internal data compendium based on the developer mode world setting. */
export async function updateCompendiumVisibility() {
  const developerMode = getSetting(SETTINGS.DEVELOPER_MODE);
  const pack = game.packs.get(PACKS.DATA);

  if (!pack) return;

  const shouldBeHidden = !developerMode;

  if (pack.private !== shouldBeHidden) {
    await pack.configure({ private: shouldBeHidden });
    logger.debug(`Pack ${PACKS.DATA} visibility:`, shouldBeHidden ? 'hidden' : 'visible');
  }
}