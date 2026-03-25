import { MODULE_ID, SETTINGS, PACKS } from './constants/index.mjs';
import { setLogLevel, logger } from './utils/index.mjs';

let compendiumModule = null;
let tagIndexModule = null;

// lazy load compendium module to avoid circular deps
async function getCompendiumModule() {
  if (!compendiumModule) {
    compendiumModule = await import('./services/compendium.mjs');
  }
  return compendiumModule;
}

// lazy load tag index module
async function getTagIndexModule() {
  if (!tagIndexModule) {
    tagIndexModule = await import('./services/tag-index.mjs');
  }
  return tagIndexModule.tagIndex;
}

// register all module settings with foundry
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

// read a setting value
export function getSetting(key) {
  return game.settings.get(MODULE_ID, key);
}

// write a setting value
export function setSetting(key, value) {
  return game.settings.set(MODULE_ID, key, value);
}

// check if we're in dev mode (with fallback for early calls before settings exist)
export function isDeveloperMode() {
  try {
    return getSetting(SETTINGS.DEVELOPER_MODE);
  } catch {
    return false;
  }
}

// fake form application that just opens the data manager when clicked
class DataManagerMenuButton extends FormApplication {
  async render() {
    const { DataManager } = await import('./applications/data-manager/data-manager.mjs');
    new DataManager().render(true);
  }
}