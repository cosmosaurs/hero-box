/**
 * @fileoverview `game.settings` registration, getters/setters, and Data Manager menu stub.
 */

import { MODULE_ID, SETTINGS } from './constants/index.mjs';
import { setLogLevel, logger } from './utils/index.mjs';

let compendiumModule = null;
let tagIndexModule = null;

/** Lazy-load `./services/compendium.mjs` (circular import avoidance). */
async function getCompendiumModule() {
  if (!compendiumModule) {
    compendiumModule = await import('./services/compendium.mjs');
  }
  return compendiumModule;
}

/** Lazy-load tag index service module. */
async function getTagIndexModule() {
  if (!tagIndexModule) {
    tagIndexModule = await import('./services/tag-index.mjs');
  }
  return tagIndexModule.tagIndex;
}

export function registerSettings() {
  // toggle verbose console logging and show hidden compendiums
  game.settings.register(MODULE_ID, SETTINGS.DEVELOPER_MODE, {
    name: 'cs-hero-box.settings.developerMode.name',
    hint: 'cs-hero-box.settings.developerMode.hint',
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
    onChange: async (value) => {
      setLogLevel(value ? 'debug' : 'info');
      const mod = await getCompendiumModule();
      mod.updateCompendiumVisibility();
    },
    requiresReload: false,
  });

  // list of source journals/compendiums to load data from
  game.settings.register(MODULE_ID, SETTINGS.DATA_SOURCES, {
    name: 'cs-hero-box.settings.dataSources.name',
    hint: 'cs-hero-box.settings.dataSources.hint',
    scope: 'world',
    config: false,
    type: Array,
    default: [],
    onChange: async () => {
      const { source } = await import('./services/source.mjs');
      source.invalidateCache();
      const index = await getTagIndexModule();
      index.reindex();
    },
  });

  // remember which journal was last selected in the data manager
  game.settings.register(MODULE_ID, SETTINGS.LAST_SELECTED_JOURNAL, {
    name: 'Last Selected Journal',
    scope: 'client',
    config: false,
    type: String,
    default: '',
  });

  game.settings.register(MODULE_ID, SETTINGS.NICKNAME_CHANCE, {
    name: 'Nickname Chance',
    scope: 'client',
    config: false,
    type: Number,
    default: 50,
  });

  game.settings.register(MODULE_ID, SETTINGS.NICKNAME_ONLY_CHANCE, {
    name: 'Nickname Only Chance',
    scope: 'client',
    config: false,
    type: Number,
    default: 0,
  });
  
  game.settings.register(MODULE_ID, SETTINGS.NO_LAST_NAME_CHANCE, {
    name: 'No Last Name Chance',
    scope: 'client',
    config: false,
    type: Number,
    default: 0,
  });

  game.settings.register(MODULE_ID, SETTINGS.COLLAPSED_ACTOR_CONFIG, {
    name: 'Collapsed Actor Config Sections',
    scope: 'client',
    config: false,
    type: Array,
    default: [],
  });

  game.settings.register(MODULE_ID, SETTINGS.COLLAPSED_DATA_MANAGER, {
    name: 'Collapsed Data Manager Groups',
    scope: 'client',
    config: false,
    type: Object,
    default: {},
  });
  
  // add the button in module settings to open the data manager
  game.settings.registerMenu(MODULE_ID, 'dataManagerMenu', {
    name: 'cs-hero-box.settings.dataManager.name',
    label: 'cs-hero-box.settings.dataManager.button',
    hint: 'cs-hero-box.settings.dataManager.hint',
    icon: 'fas fa-folder-open',
    type: DataManagerMenuButton,
    restricted: true,
  });

  logger.debug('Settings registered');
}

/** @param {string} key */
export function getSetting(key) {
  return game.settings.get(MODULE_ID, key);
}

/** @param {string} key @param {unknown} value */
export function setSetting(key, value) {
  return game.settings.set(MODULE_ID, key, value);
}

/** @returns {boolean} */
export function isDeveloperMode() {
  try {
    return getSetting(SETTINGS.DEVELOPER_MODE);
  } catch {
    return false;
  }
}

/** Settings menu entry that opens the Data Manager application. */
class DataManagerMenuButton extends FormApplication {
  async render() {
    const { DataManager } = await import('./applications/data-manager/data-manager.mjs');
    new DataManager().render(true);
  }
}