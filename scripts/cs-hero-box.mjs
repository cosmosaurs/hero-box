import { MODULE_ID } from './constants/index.mjs';
import { logger, setLogLevel } from './utils/index.mjs';
import { registerAllHooks } from './hooks/index.mjs';
import { registerSettings, isDeveloperMode } from './settings.mjs';
import {
  tagIndex,
  imagePicker,
  nameGenerator,
  actor,
} from './services/index.mjs';

// main entry point — runs once when foundry loads the module
Hooks.once('init', () => {
  logger.info('Initializing...');

  registerSettings();

  if (isDeveloperMode()) {
    setLogLevel('debug');
  }

  registerAllHooks();
  registerHandlebarsHelpers();

  logger.info('Initialization complete');
});

// register custom handlebars helpers for our templates
function registerHandlebarsHelpers() {
  // switch/case helper for cleaner conditionals in templates
  Handlebars.registerHelper('csSwitch', function(value, options) {
    this.switch_value = value;
    return options.fn(this);
  });

  Handlebars.registerHelper('csCase', function(value, options) {
    if (value === this.switch_value) {
      return options.fn(this);
    }
  });

  // join strings together
  Handlebars.registerHelper('concat', function(...args) {
    args.pop();
    return args.join('');
  });

  // simple equality check
  Handlebars.registerHelper('eq', function(a, b) {
    return a === b;
  });
}

// public api for other modules or macros to use
export const API = {
  id: MODULE_ID,
  logger,

  services: {
    tagIndex,
    imagePicker,
    nameGenerator,
    actor,
  },

  // force rebuild the image index from all sources
  async reindex() {
    return tagIndex.reindex();
  },

  // find all images matching a list of tags
  findImages(tags) {
    return tagIndex.findByTags(tags);
  },

  // pick a random image from the given tag groups
  pickRandomImage(tagGroups) {
    return imagePicker.pickRandomByGroups(tagGroups);
  },

  // generate a random name based on tags
  generateName(tags) {
    return nameGenerator.generate(tags);
  }
};

// expose the api on the module object so others can access it
Hooks.once('ready', () => {
  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = API;
  }

  logger.debug(`API exposed at game.modules.get(${MODULE_ID}).api`);
});