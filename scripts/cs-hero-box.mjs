/**
 * @fileoverview Module bootstrap: init hooks, settings, Handlebars helpers; exposes `game.modules` API on ready.
 */

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

/** Register `csSwitch`, `csCase`, `concat`, and `eq` Handlebars helpers. */
function registerHandlebarsHelpers() {
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

/** Public API attached to `game.modules.get(MODULE_ID).api`. */
export const API = {
  id: MODULE_ID,
  logger,

  services: {
    tagIndex,
    imagePicker,
    nameGenerator,
    actor,
  },

  /** @returns {Promise<void>} */
  async reindex() {
    return tagIndex.reindex();
  },

  /** @param {string[]} tags @returns {object[]} */
  findImages(tags) {
    return tagIndex.findByTags(tags);
  },

  // pick a random image from the given tag groups
  pickRandomImage(tagGroups) {
    return imagePicker.pickRandomByGroups(tagGroups);
  },

  /** @param {string[]} tags @returns {string} */
  generateName(tags) {
    return nameGenerator.generate(tags);
  }
};

Hooks.once('ready', () => {
  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = API;
  }

  logger.debug(`API exposed at game.modules.get(${MODULE_ID}).api`);
});