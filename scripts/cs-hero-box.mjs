**
 * @fileoverview Module bootstrap: init hooks, settings, Handlebars helpers; exposes `game.modules` API on ready.
 */

import { MODULE_ID } from './constants/index.mjs';
import { logger, setLogLevel } from './utils/index.mjs';
import { registerAllHooks } from './hooks/index.mjs';
import { openActorConfig, freezeTokenAsActor } from './hooks/ui.mjs';
import { registerSettings, isDeveloperMode } from './settings.mjs';
import {
  tag,
  tagIndex,
  source,
  imagePicker,
  nameGenerator,
  actor,
  reloadDataServices,
} from './services/index.mjs';

Hooks.once('init', () => {
  logger.info('Initializing...');

  if (Array.isArray(CONFIG?.Actor?.compendiumIndexFields)) {
    const flagField = `flags.${MODULE_ID}`;
    if (!CONFIG.Actor.compendiumIndexFields.includes(flagField)) {
      CONFIG.Actor.compendiumIndexFields.push(flagField);
    }
  }

  registerSettings();

  if (isDeveloperMode()) {
    setLogLevel('debug');
  }

  registerAllHooks();
  registerHandlebarsHelpers();

  logger.info('Initialization complete');
});

/** Register fallback `eq` helper only if not already provided by Foundry VTT. */
function registerHandlebarsHelpers() {
  if (!Handlebars.helpers.eq) {
    Handlebars.registerHelper('eq', (a, b) => a === b);
  }
}

/**
 * Normalize subrace filter input (`Record<string, string[]>` or flat `string[]`) into `Record<string, string[]>`.
 * @param {Record<string, string[]>|string[]|null|undefined} raw
 * @param {'parentRaceId'} parentField
 * @returns {Record<string, string[]>}
 */
function normalizeChildTagMap(raw, parentField) {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const grouped = {};
    for (const subId of raw) {
      const parentId = tag.get(subId)?.[parentField];
      if (!parentId) continue;
      if (!grouped[parentId]) grouped[parentId] = [];
      grouped[parentId].push(subId);
    }
    return grouped;
  }
  if (typeof raw === 'object') {
    const cloned = {};
    for (const [parentId, subs] of Object.entries(raw)) {
      cloned[parentId] = Array.isArray(subs) ? [...subs] : [subs].filter(Boolean);
    }
    return cloned;
  }
  return {};
}

/**
 * Coerce string, array, or grouped object tag input into a flat `string[]`.
 * @param {string|string[]|Record<string, string[]>|null|undefined} val
 * @returns {string[]}
 */
function toTagArray(val) {
  if (!val) return [];
  if (Array.isArray(val)) return [...val];
  if (typeof val === 'object') {
    const flat = [];
    for (const v of Object.values(val)) {
      if (Array.isArray(v)) flat.push(...v);
      else if (v) flat.push(v);
    }
    return flat;
  }
  return [val];
}

/**
 * Resolve an `Actor` instance from an `Actor`, world actor ID, or UUID.
 * @param {Actor|string|null|undefined} actorOrId
 * @returns {Promise<Actor|null>}
 */
async function resolveActorDocument(actorOrId) {
  if (!actorOrId) return null;
  if (actorOrId?.documentName === 'Actor') return actorOrId;
  if (typeof actorOrId === 'string') {
    return game.actors?.get(actorOrId) ?? await fromUuid(actorOrId).catch(() => null);
  }
  return null;
}

/** Public API attached to `game.modules.get(MODULE_ID).api`. */
export const API = {
  id: MODULE_ID,
  logger,

  services: {
    tag,
    tagIndex,
    source,
    imagePicker,
    nameGenerator,
    actor,
  },

  /** @returns {Promise<void>} */
  async reindex() {
    return tagIndex.reindex();
  },

  /** Reload all data sources, tags, images, and name sets. @returns {Promise<void>} */
  async reload() {
    return reloadDataServices();
  },

  /** @param {string[]} tags @returns {object[]} */
  findImages(tags) {
    return tagIndex.findByTags(tags);
  },

  /**
   * Pick a random image from the given tag groups.
   * @param {string[][]} tagGroups
   * @param {{ excludeUuids?: Set<string>|string[], excludeUrls?: Set<string>|string[], preferDifferentFromUuid?: string|null }} [options]
   */
  pickRandomImage(tagGroups, options = {}) {
    return imagePicker.pickRandomByGroups(tagGroups, options);
  },

  /**
   * Generate a random name matching the given tags.
   * Supports `(tags, nicknameChance, nicknameOnlyChance, noLastNameChance)` or `(tags, options)`.
   * @param {string[]} tags
   * @param {number|{ nicknameChance?: number, nicknameOnlyChance?: number, noLastNameChance?: number }} [nicknameChanceOrOptions]
   * @param {number} [nicknameOnlyChance]
   * @param {number} [noLastNameChance]
   * @returns {string}
   */
  generateName(tags, nicknameChanceOrOptions, nicknameOnlyChance, noLastNameChance) {
    if (nicknameChanceOrOptions && typeof nicknameChanceOrOptions === 'object') {
      return nameGenerator.generate(
        tags,
        nicknameChanceOrOptions.nicknameChance,
        nicknameChanceOrOptions.nicknameOnlyChance,
        nicknameChanceOrOptions.noLastNameChance
      );
    }
    return nameGenerator.generate(tags, nicknameChanceOrOptions, nicknameOnlyChance, noLastNameChance);
  },

  /**
   * Re-roll image and/or name on a placed token (or currently selected canvas token(s) if omitted).
   * @param {Token|TokenDocument|string|Array<Token|TokenDocument|string>|null} [tokenOrId]
   * @param {{ rerollImage?: boolean, rerollName?: boolean, deduplicateScene?: boolean, criteria?: object|null }} [options]
   */
  async rerollToken(tokenOrId = null, options = {}) {
    if (Array.isArray(tokenOrId)) {
      const results = [];
      for (const entry of tokenOrId) {
        results.push(await actor.rerollToken(entry, options));
      }
      return results;
    }

    if (!tokenOrId) {
      const controlled = canvas?.tokens?.controlled ?? [];
      if (controlled.length === 0) return null;
      if (controlled.length === 1) return actor.rerollToken(controlled[0], options);

      const results = [];
      for (const controlledToken of controlled) {
        results.push(await actor.rerollToken(controlledToken, options));
      }
      return results;
    }

    return actor.rerollToken(tokenOrId, options);
  },

  /**
   * Freeze a placed token (or the currently selected canvas token if omitted) into a standalone linked `Actor`.
   * @param {Token|TokenDocument|string|null} [tokenOrId]
   * @returns {Promise<Actor|null>}
   */
  async freezeToken(tokenOrId = null) {
    const target = tokenOrId ?? canvas?.tokens?.controlled?.[0] ?? null;
    if (!target) return null;
    return freezeTokenAsActor(target);
  },

  /**
   * Programmatically create (or update) an `Actor` using Hero in a Box criteria.
   * @param {object} [criteria]
   * @param {{ actor?: Actor|string|null, folderId?: string|null, mode?: 'fixed'|'random', name?: string }} [options]
   * @returns {Promise<Actor|null>}
   */
  async createRandomActor(criteria = {}, options = {}) {
    const existingActor = await resolveActorDocument(options.actor ?? null);
    const folderId = options.folderId ?? criteria.folderId ?? null;
    const selectedImageUuids = Array.isArray(criteria.selectedImageUuids) ? [...criteria.selectedImageUuids] : [];

    let sourceActor = criteria.sourceActor ?? null;
    if (sourceActor?.uuid) {
      sourceActor = { uuid: sourceActor.uuid };
    } else if (typeof sourceActor === 'string') {
      sourceActor = { uuid: sourceActor };
    } else if (criteria.sourceActorUuid) {
      sourceActor = { uuid: criteria.sourceActorUuid };
    }

    const subrace = normalizeChildTagMap(criteria.subrace, 'parentRaceId');
    const race = toTagArray(criteria.race);
    for (const parentRaceId of Object.keys(subrace)) {
      if (!race.includes(parentRaceId)) race.push(parentRaceId);
    }

    const formData = {
      race,
      raceExclude: toTagArray(criteria.raceExclude),
      subrace,
      subraceExclude: toTagArray(criteria.subraceExclude),
      gender: toTagArray(criteria.gender),
      age: toTagArray(criteria.age),
      ageExclude: toTagArray(criteria.ageExclude),
      roleGroup: toTagArray(criteria.roleGroup),
      roleGroupExclude: toTagArray(criteria.roleGroupExclude),
      role: toTagArray(criteria.role),
      roleExclude: toTagArray(criteria.roleExclude),
      other: toTagArray(criteria.other),
      otherExclude: toTagArray(criteria.otherExclude),
      mode: options.mode ?? criteria.mode ?? 'fixed',
      selectionMode: criteria.selectionMode ?? (selectedImageUuids.length > 0 ? 'manual' : 'tag'),
      selectedImageUuids,
      sourceActor,
      actorName: options.name ?? criteria.actorName ?? criteria.name ?? '',
      nicknameChance: criteria.nicknameChance,
      nicknameOnlyChance: criteria.nicknameOnlyChance,
      noLastNameChance: criteria.noLastNameChance,
    };

    const result = await actor.createOrUpdate(formData, existingActor, folderId);
    return result?.actor ?? null;
  },

  /**
   * Open the Data Manager window (or image picker mode when `options.pickerMode` is true).
   * @param {{ pickerMode?: boolean, initialFilters?: object }} [options]
   * @returns {Promise<DataManager|string[]|null>}
   */
  async openDataManager(options = {}) {
    const { DataManager } = await import('./applications/data-manager/data-manager.mjs');
    if (options.pickerMode) {
      return DataManager.pick(options);
    }
    const existing = foundry.applications?.instances?.get(`${MODULE_ID}-data-manager`);
    if (existing) {
      existing.render({ force: true });
      return existing;
    }
    const app = new DataManager(options);
    app.render({ force: true });
    return app;
  },

  /**
   * Open the Hero in a Box Actor Config dialog for creating a new actor or reconfiguring an existing one.
   * @param {Actor|string|null} [actorOrId]
   * @param {{ folderId?: string|null, apply?: boolean }} [options]
   * @returns {Promise<{ actor: Actor, isNew: boolean }|null>}
   */
  async openActorConfig(actorOrId = null, options = {}) {
    const resolvedActor = await resolveActorDocument(actorOrId);
    return openActorConfig(resolvedActor, options.folderId ?? null, options);
  },
};

Hooks.once('ready', () => {
  const module = game.modules.get(MODULE_ID);
  if (module) {
    module.api = API;
  }

  logger.debug(`API exposed at game.modules.get(${MODULE_ID}).api`);
});