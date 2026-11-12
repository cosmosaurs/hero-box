**
 * @fileoverview Client keybinding to toggle the Data Manager.
 */

import { MODULE_ID } from '../constants/index.mjs';
import { logger } from '../utils/index.mjs';

export function registerKeybindings() {
  const altModifier = foundry.helpers?.interaction?.KeyboardManager?.MODIFIER_KEYS?.ALT
    ?? globalThis.KeyboardManager?.MODIFIER_KEYS?.ALT
    ?? 'Alt';

  game.keybindings.register(MODULE_ID, 'openDataManager', {
    name: 'cs-hero-box.keybindings.openDataManager.name',
    hint: 'cs-hero-box.keybindings.openDataManager.hint',
    editable: [{ key: 'KeyP', modifiers: [altModifier] }],
    onDown: toggleDataManager,
    restricted: true,
    precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL,
  });

  logger.debug('Keybindings registered');
}

/** Toggle (open or close) the Data Manager window. */
async function toggleDataManager() {
  const { DataManager } = await import('../applications/data-manager/data-manager.mjs');
  const targetId = `${MODULE_ID}-data-manager`;
  const existingApp = foundry.applications?.instances?.get(targetId) ?? null;

  if (existingApp) {
    await existingApp.close();
  } else {
    new DataManager().render({ force: true });
  }

  return true;
}
