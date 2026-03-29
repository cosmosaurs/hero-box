/**
 * @fileoverview Loads name lists from configured sources at world ready; exposes synchronous `generate()`.
 */

import { FLAGS } from '../constants/index.mjs';
import { GENDER_TAGS, AGE_TAGS } from '../constants/tags.mjs';
import { UI } from '../constants/ui.mjs';
import { logger, getFlag } from '../utils/index.mjs';
import { getSourcePages } from '../utils/source.mjs';
import { source } from './source.mjs';
import { tag } from './tag.mjs';

/** Picks random composed names from journal `NAME_DATA` keyed by tags and locale. */
class NameGeneratorService {
  #nameMeta = [];
  #namesBySetId = new Map();
  #tagCounts = new Map();
  #initialized = false;
  #raceTagIds = null;

  /** Load all name sets from enabled data sources (world ready). */
  async initialize() {
    if (this.#initialized) return;

    const timer = logger.time('Name generator initialization');

    try {
      await this.#loadFromSources();
      this.#buildTagCounts();
      this.#initialized = true;
      logger.info(`Loaded ${this.#nameMeta.length} name sets`);
    } catch (error) {
      logger.error('Failed to initialize name generator:', error);
    } finally {
      timer.end();
    }
  }

  /**
   * @param {string[]} tags Image / criteria tags used to match name sets.
   * @returns {string} Full generated name (or fallback).
   */
  generate(tags) {
    if (!this.#initialized) {
      logger.warn('Name generator not initialized');
      return this.#fallbackName();
    }

    const context = this.#parseContext(tags);
    const parts = {
      firstName: this.#pickName('firstName', context),
      lastName: this.#pickName('lastName', context),
      clan: this.#pickName('clan', context),
      nickname: this.#pickName('nickname', context),
    };

    return this.#assembleWithHook(context, parts, tags);
  }

  /** Clear caches and reload from sources (e.g. after data source changes). */
  async reload() {
    this.#nameMeta = [];
    this.#namesBySetId.clear();
    this.#tagCounts.clear();
    this.#initialized = false;
    this.#raceTagIds = null;
    await this.initialize();
  }

  getAllSets() {
    return this.#nameMeta;
  }

  getTagCounts() {
    return this.#tagCounts;
  }

  get isInitialized() {
    return this.#initialized;
  }

  /**
   * @param {{ race: string|null, subrace: string|null, gender: string|null, age: string|null }} context
   * @param {Record<string, string|null>} parts
   * @param {string[]} tags
   * @returns {string}
   */
  #assembleWithHook(context, parts, tags) {
    const nameData = {
      context: { ...context },
      parts: { ...parts },
      tags: [...tags],
      useNickname: parts.nickname && Math.random() < UI.NICKNAME_CHANCE,
      result: null,
    };

    Hooks.callAll('cs-hero-box.preGenerateName', nameData);

    if (typeof nameData.result === 'string' && nameData.result.length) {
      return nameData.result;
    }

    return this.#assemble(nameData);
  }

  /**
   * @param {{ parts: Record<string, string|null>, useNickname: boolean }} nameData
   * @returns {string}
   */
  #assemble(nameData) {
    const { parts, useNickname } = nameData;
    const { firstName, lastName, clan, nickname } = parts;

    const segments = [];

    if (firstName) segments.push(firstName);

    if (useNickname && nickname) {
      if (segments.length || lastName || clan) {
        segments.push(`«${nickname}»`);
      } else {
        segments.push(nickname);
      }
    }

    if (lastName) {
      segments.push(lastName);
    } else if (clan) {
      segments.push(clan);
    }

    return segments.length ? segments.join(' ') : this.#fallbackName();
  }

  /**
   * @param {string[]} tags
   * @returns {{ race: string|null, subrace: string|null, gender: string|null, age: string|null }}
   */
  #parseContext(tags) {
    const raceTagIds = this.#getRaceTagIds();

    const race = tags.find(t => raceTagIds.has(t)) ?? null;

    let subrace = null;
    if (race) {
      const subraceIds = new Set(tag.getSubraces(race).map(t => t.id));
      subrace = tags.find(t => subraceIds.has(t)) ?? null;
    }

    const genderValues = new Set(Object.values(GENDER_TAGS));
    const ageValues = new Set(Object.values(AGE_TAGS));

    return {
      race,
      subrace,
      gender: tags.find(t => genderValues.has(t)) ?? null,
      age: tags.find(t => ageValues.has(t)) ?? null,
    };
  }

  /** @returns {Set<string>} */
  #getRaceTagIds() {
    if (!this.#raceTagIds) {
      this.#raceTagIds = new Set(tag.getRaces().map(t => t.id));
    }
    return this.#raceTagIds;
  }

  /**
   * @param {'firstName'|'lastName'|'clan'|'nickname'} type
   * @param {{ race: string|null, subrace: string|null, gender: string|null, age: string|null }} context
   * @returns {string|null}
   */
  #pickName(type, context) {
    const matchingSets = this.#findMatchingSets(type, context);
    if (!matchingSets.length) return null;

    const setsToUse = this.#preferSpecificSets(matchingSets, context);

    const allNames = [];
    for (const set of setsToUse) {
      const names = this.#namesBySetId.get(set.id) ?? [];
      allNames.push(...names);
    }

    return allNames.length ? allNames[Math.floor(Math.random() * allNames.length)] : null;
  }

  /**
   * @param {string} type Name component type.
   * @param {object} context Parsed tag context.
   * @returns {object[]}
   */
  #findMatchingSets(type, context) {
    const raceTagIds = this.#getRaceTagIds();

    return this.#nameMeta.filter(set => {
      if (set.type !== type) return false;

      const setRaces = set.tags.filter(t => raceTagIds.has(t));
      const setSubraces = set.tags.filter(t => {
        const tagData = tag.get(t);
        return tagData?.category === 'subrace';
      });
      const setGenders = set.tags.filter(t =>
        t === GENDER_TAGS.MALE || t === GENDER_TAGS.FEMALE
      );
      const setAges = set.tags.filter(t =>
        t === AGE_TAGS.CHILD || t === AGE_TAGS.ADULT || t === AGE_TAGS.OLD
      );

      if (setRaces.length > 0 && !setRaces.includes(context.race)) return false;
      if (setSubraces.length > 0 && (!context.subrace || !setSubraces.includes(context.subrace))) return false;
      if (setGenders.length > 0 && context.gender && !setGenders.includes(context.gender)) return false;
      if (setAges.length > 0 && context.age && !setAges.includes(context.age)) return false;

      return true;
    });
  }

  /**
   * @param {object[]} matchingSets
   * @param {{ subrace: string|null }} context
   * @returns {object[]}
   */
  #preferSpecificSets(matchingSets, context) {
    const specificSets = matchingSets.filter(set => {
      const setSubraces = set.tags.filter(t => {
        const tagData = tag.get(t);
        return tagData?.category === 'subrace';
      });
      return setSubraces.length > 0 && context.subrace;
    });

    return specificSets.length > 0 ? specificSets : matchingSets;
  }

  /** Populate `#nameMeta` and `#namesBySetId` from enabled sources. */
  async #loadFromSources() {
    const sources = source.getEnabledSources();
    if (!sources?.length) return;

    for (const sourceId of sources) {
      try {
        const pages = await getSourcePages(sourceId);
        const sourceName = source.getSourceName(sourceId);

        for (const page of pages) {
          const nameData = getFlag(page, FLAGS.NAME_DATA);
          if (!nameData?.names) continue;

          const tags = this.#extractTags(nameData);
          const id = page.uuid;
          const locale = game.i18n.lang;
          const nameMap = nameData.names;
          const names = nameMap[locale] ?? nameMap['en'] ?? nameMap[Object.keys(nameMap)[0]] ?? [];

          const locales = Object.keys(nameData.names ?? {});
          const tagsDisplay = tags.map(t => tag.getLabel(t)).join(', ');
          const localesDisplay = locales.join(', ');

          this.#nameMeta.push({
            id,
            uuid: page.uuid,
            name: page.name,
            tags,
            type: nameData.type ?? 'firstName',
            tagsDisplay,
            localesDisplay,
            sourceName,
            searchString: [page.name, ...tags, tagsDisplay].join(' ').toLowerCase(),
          });

          this.#namesBySetId.set(id, names);
        }
      } catch (error) {
        logger.warn(`Failed to load names from source: ${sourceId}`, error);
      }
    }
  }

  /**
   * @param {object} nameData Journal `NAME_DATA` flag body.
   * @returns {string[]}
   */
  #extractTags(nameData) {
    if (nameData.tags) return nameData.tags;
    const tags = [];
    if (nameData.genders?.length) tags.push(...nameData.genders);
    if (nameData.races?.length) tags.push(...nameData.races);
    if (nameData.subraces?.length) tags.push(...nameData.subraces);
    return tags;
  }

  // last resort when nothing matches
  #buildTagCounts() {
    this.#tagCounts.clear();

    for (const set of this.#nameMeta) {
      const type = set.type ?? 'firstName';
      this.#tagCounts.set(type, (this.#tagCounts.get(type) ?? 0) + 1);

      for (const t of set.tags) {
        this.#tagCounts.set(t, (this.#tagCounts.get(t) ?? 0) + 1);
      }
    }
  }

  /** @returns {string} */
  #fallbackName() {
    return `${game.i18n.localize('cs-hero-box.actor.fallbackName')} #${foundry.utils.randomID(8)}`;
  }
}

/** Singleton name generator. */
export const nameGenerator = new NameGeneratorService();
