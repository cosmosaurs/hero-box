const SYSTEM_ACTOR_TYPES = Object.freeze({
  'dnd5e': 'npc',
  'pf2e': 'npc',
  'mta': 'character',
  'wfrp4e': 'npc',
  'swade': 'npc',
  'coc7': 'npc',
});

// pick the right actor type for the current game system
export function getDefaultActorType() {
  return SYSTEM_ACTOR_TYPES[game.system.id] ?? 'npc';
}

// what quirks does the current system have
export function getSystemCapabilities() {
  const systemId = game.system.id;

  return {
    hasCustomCreateDialog: systemId === 'dnd5e',
    id: systemId,
  };
}

// dnd5e uses a different dialog hook than everyone else
export function getCreateDialogHookName() {
  return game.system.id === 'dnd5e'
    ? 'renderCreateDocumentDialog'
    : 'renderDialogV2';
}