/**
 * @fileoverview Game system–specific defaults (actor type, create-dialog hook name).
 */

const SYSTEM_ACTOR_TYPES = Object.freeze({
  'dnd5e': 'npc',
  'pf2e': 'npc',
  'mta': 'character',
  'wfrp4e': 'npc',
  'swade': 'npc',
  'coc7': 'npc',
});

/** @returns {string} */
export function getDefaultActorType() {
  return SYSTEM_ACTOR_TYPES[game.system.id] ?? 'npc';
}

/**
 * @returns {{ hasCustomCreateDialog: boolean, id: string }}
 */
export function getSystemCapabilities() {
  const systemId = game.system.id;

  return {
    hasCustomCreateDialog: systemId === 'dnd5e',
    id: systemId,
  };
}

/** @returns {string} Foundry hook name for the native create-actor dialog. */
export function getCreateDialogHookName() {
  return game.system.id === 'dnd5e'
    ? 'renderCreateDocumentDialog'
    : 'renderDialogV2';
}