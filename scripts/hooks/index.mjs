/**
 * @fileoverview Registers all Foundry hooks for the module.
 */

import { registerReadyHooks } from './ready.mjs';
import { registerTokenHooks } from './token.mjs';
import { registerUIHooks } from './ui.mjs';
import { registerKeybindings } from './keybindings.mjs';

/** Wire ready, token, UI, and keybinding hooks. */
export function registerAllHooks() {
  registerReadyHooks();
  registerTokenHooks();
  registerUIHooks();
  registerKeybindings();
}