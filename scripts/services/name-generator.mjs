**
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
  #initPromise = null;

  /** Load all name sets from enabled data sources (world ready). */
  async initialize() {
    if (this.#initialized) return;
    if (this.#initPromise) return this.#initPromise;

    this.#initPromise = (async () => {
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
        this.#initPromise = null;
      }
    })();

    return this.#initPromise;
  }

  /**
   * @param {string[]} tags Image / criteria tags used to match name sets.
   * @returns {string} Full generated name (or fallback).
   */
  generate(tags, nicknameChance, nicknameOnlyChance, noLastNameChance) {
    if (!this.#initialized) {
      logger.warn('Name generator not initialized');
      return this.#fallbackName();
    }

    const baseContext = this.#parseContext(tags ?? []);
    const context = this.#resolveRollContext(baseContext);
    if (nicknameChance !== undefined) context.nicknameChance = nicknameChance;
    if (nicknameOnlyChance !== undefined) context.nicknameOnlyChance = nicknameOnlyChance;
    if (noLastNameChance !== undefined) context.noLastNameChance = noLastNameChance;

    const parts = {
      firstName: this.#pickName('firstName', context),
      lastName: this.#pickName('lastName', context),
      nickname: this.#pickName('nickname', context),
    };

    return this.#assembleWithHook(context, parts, tags ?? []);
  }

  /** Clear caches and reload from sources (e.g. after data source changes). */
  async reload() {
    if (this.#initPromise) {
      await this.#initPromise;
    }
    this.#nameMeta = [];
    this.#namesBySetId.clear();
    this.#tagCounts.clear();
    this.#initialized = false;
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
    const nicknameChance = context.nicknameChance ?? UI.NICKNAME_CHANCE;
    const nicknameOnlyChance = context.nicknameOnlyChance ?? UI.NICKNAME_ONLY_CHANCE;
    const noLastNameChance = context.noLastNameChance ?? 0;

    const nameData = {
      context: { ...context },
      parts: { ...parts },
      tags: [...tags],
      useNickname: parts.nickname && Math.random() < nicknameChance,
      nicknameOnly: false,
      skipLastName: noLastNameChance > 0 && Math.random() < noLastNameChance,
      result: null,
    };

    if (nameData.useNickname && nicknameOnlyChance > 0 && Math.random() < nicknameOnlyChance) {
      nameData.nicknameOnly = true;
    }

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
    const { parts, useNickname, nicknameOnly, skipLastName } = nameData;
    const { firstName, lastName, nickname } = parts;

    if (nicknameOnly && nickname) {
      return nickname;
    }

    const segments = [];

    if (firstName) segments.push(firstName);

    if (useNickname && nickname) {
      if (segments.length || (!skipLastName && lastName)) {
        const quoted = game.i18n?.has('cs-hero-box.nameFormat.quotedNickname')
          ? game.i18n.format('cs-hero-box.nameFormat.quotedNickname', { nickname })
          : `"${nickname}"`;
        segments.push(quoted);
      } else {
        segments.push(nickname);
      }
    }

    if (!skipLastName && lastName) {
      segments.push(lastName);
    }

    return segments.length ? segments.join(' ') : this.#fallbackName();
  }

  /**
   * @param {string[]} tags
   * @returns {{ race: string|null, subrace: string|null, roleGroups: string[], roles: string[], gender: string|null, age: string|null }}
   */
  #parseContext(tags) {
    const raceTagIds = this.#getRaceTagIds();
    const roleGroupTagIds = this.#getRoleGroupTagIds();
    const roleTagIds = this.#getRoleTagIds();

    const races = tags.filter(t => raceTagIds.has(t));
    let race = races.length > 0 ? races[Math.floor(Math.random() * races.length)] : null;

    let subrace = null;
    if (race) {
      const subraceIds = new Set(tag.getSubraces(race).map(t => t.id));
      subrace = tags.find(t => subraceIds.has(t)) ?? null;
    } else {
      const orphanSubrace = tags.find(t => tag.get(t)?.category === 'subrace');
      if (orphanSubrace) {
        subrace = orphanSubrace;
        race = tag.get(orphanSubrace)?.parentRaceId ?? null;
      }
    }

    const roles = tags.filter(t => roleTagIds.has(t));
    const roleGroupSet = new Set(tags.filter(t => roleGroupTagIds.has(t)));
    for (const r of roles) {
      const roleGroupId = tag.get(r)?.roleGroupId;
      if (roleGroupId) roleGroupSet.add(roleGroupId);
    }

    const genderValues = new Set(Object.values(GENDER_TAGS));
    const ageValues = new Set(Object.values(AGE_TAGS));

    return {
      race,
      subrace,
      roleGroups: [...roleGroupSet],
      roles,
      gender: tags.find(t => genderValues.has(t)) ?? null,
      age: tags.find(t => ageValues.has(t)) ?? null,
    };
  }

  /** @returns {Set<string>} */
  #getRaceTagIds() {
    return new Set(tag.getRaces().map(t => t.id));
  }

  /** @returns {Set<string>} */
  #getRoleGroupTagIds() {
    return new Set(tag.getRoleGroups().map(t => t.id));
  }

  /** @returns {Set<string>} */
  #getRoleTagIds() {
    return new Set(tag.getRoles().map(t => t.id));
  }

  /**
   * Resolve consistent fallback race/gender across all name parts when input tags omit them
   * and no neutral sets exist, preventing mixed-gender or mixed-race full names.
   * @param {{ race: string|null, subrace: string|null, gender: string|null, age: string|null }} context
   */
  #resolveRollContext(context) {
    const resolved = { ...context };

    if (!resolved.race && !this.#findMatchingSets('firstName', resolved, { strictMissing: true }).length) {
      const raceTagIds = this.#getRaceTagIds();
      const candidateRaces = new Set();
      for (const set of this.#nameMeta) {
        if (set.type !== 'firstName') continue;
        if (resolved.gender) {
          const setGenders = set.tags.filter(t => t === GENDER_TAGS.MALE || t === GENDER_TAGS.FEMALE);
          if (setGenders.length > 0 && !setGenders.includes(resolved.gender)) continue;
        }
        for (const t of set.tags) {
          if (raceTagIds.has(t)) candidateRaces.add(t);
        }
      }
      if (candidateRaces.size > 0) {
        const races = [...candidateRaces];
        resolved.race = races[Math.floor(Math.random() * races.length)];
      }
    }

    if (!resolved.gender && !this.#findMatchingSets('firstName', resolved, { strictMissing: true }).length) {
      const candidateGenders = Object.values(GENDER_TAGS).filter(g =>
        this.#findMatchingSets('firstName', { ...resolved, gender: g }, { strictMissing: false }).length > 0
      );
      if (candidateGenders.length > 0) {
        resolved.gender = candidateGenders[Math.floor(Math.random() * candidateGenders.length)];
      }
    }

    return resolved;
  }

  /**
   * @param {'firstName'|'lastName'|'nickname'} type
   * @param {{ race: string|null, subrace: string|null, gender: string|null, age: string|null }} context
   * @returns {string|null}
   */
  #pickName(type, context) {
    let matchingSets = this.#findMatchingSets(type, context, { strictMissing: true });
    if (!matchingSets.length) {
      matchingSets = this.#findMatchingSets(type, context, { strictMissing: false });
    }
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
   * @param {{ strictMissing?: boolean }} [options]
   * @returns {object[]}
   */
  #findMatchingSets(type, context, { strictMissing = false } = {}) {
    const raceTagIds = this.#getRaceTagIds();
    const roleGroupTagIds = this.#getRoleGroupTagIds();
    const roleTagIds = this.#getRoleTagIds();
    const genderValues = new Set(Object.values(GENDER_TAGS));
    const ageValues = new Set(Object.values(AGE_TAGS));

    return this.#nameMeta.filter(set => {
      if (set.type !== type) return false;

      const setRaces = set.tags.filter(t => raceTagIds.has(t));
      const setSubraces = set.tags.filter(t => tag.get(t)?.category === 'subrace');
      const setRoleGroups = set.tags.filter(t => roleGroupTagIds.has(t));
      const setRoles = set.tags.filter(t => roleTagIds.has(t));
      const setGenders = set.tags.filter(t => genderValues.has(t));
      const setAges = set.tags.filter(t => ageValues.has(t));

      if (setRaces.length > 0) {
        if (context.race ? !setRaces.includes(context.race) : strictMissing) return false;
      }
      if (setSubraces.length > 0 && (!context.subrace || !setSubraces.includes(context.subrace))) return false;
      if (setRoleGroups.length > 0 && (!context.roleGroups?.length || !context.roleGroups.some(g => setRoleGroups.includes(g)))) return false;
      if (setRoles.length > 0 && (!context.roles?.length || !context.roles.some(r => setRoles.includes(r)))) return false;
      if (setGenders.length > 0) {
        if (context.gender ? !setGenders.includes(context.gender) : strictMissing) return false;
      }
      if (setAges.length > 0) {
        if (context.age ? !setAges.includes(context.age) : strictMissing) return false;
      }

      return true;
    });
  }

  /**
   * Prefer sets matching more specific tags (subrace/race + role/roleGroup > role > roleGroup > subrace > race > generic).
   * @param {object[]} matchingSets
   * @param {{ race: string|null, subrace: string|null, roleGroups?: string[], roles?: string[] }} context
   * @returns {object[]}
   */
  #preferSpecificSets(matchingSets, context) {
    const hasSubrace = set => Boolean(context.subrace && set.tags.includes(context.subrace));
    const hasRace = set => Boolean(context.race && set.tags.includes(context.race));
    const hasRole = set => Boolean(context.roles?.length && context.roles.some(r => set.tags.includes(r)));
    const hasRoleGroup = set => Boolean(context.roleGroups?.length && context.roleGroups.some(g => set.tags.includes(g)));

    const tiers = [
      set => hasSubrace(set) && hasRole(set),
      set => hasRace(set) && hasRole(set),
      set => hasSubrace(set) && hasRoleGroup(set),
      set => hasRole(set),
      set => hasRace(set) && hasRoleGroup(set),
      set => hasRoleGroup(set),
      set => hasSubrace(set),
      set => hasRace(set),
    ];

    for (const predicate of tiers) {
      const subset = matchingSets.filter(predicate);
      if (subset.length > 0) return subset;
    }

    return matchingSets;
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
    if (nameData.roleGroups?.length) tags.push(...nameData.roleGroups);
    if (nameData.roles?.length) tags.push(...nameData.roles);
    return tags;
  }

  // last resort when nothing matches
  #buildTagCounts() {
    this.#tagCounts.clear();

    for (const set of this.#nameMeta) {
      const type = set.type ?? 'firstName';
      this.#tagCounts.set(type, (this.#tagCounts.get(type) ?? 0) + 1);

      const countedIds = new Set(set.tags);
      for (const t of set.tags) {
        const tagData = tag.get(t);
        if (tagData?.category === 'role' && tagData.roleGroupId) {
          countedIds.add(tagData.roleGroupId);
        }
      }

      for (const t of countedIds) {
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
