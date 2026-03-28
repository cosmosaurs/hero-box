import { FLAGS } from '../constants/index.mjs';
import { GENDER_TAGS, AGE_TAGS } from '../constants/tags.mjs';
import { UI } from '../constants/ui.mjs';
import { logger, getFlag } from '../utils/index.mjs';
import { getSourcePages } from '../utils/source.mjs';
import { source } from './source.mjs';
import { tag } from './tag.mjs';
import { DEFAULT_NAMES } from '../data/default-names.mjs';

// generates random names based on race/gender/age tags
class NameGeneratorService {
  #nameMeta = [];
  #nameDataMap = new Map();
  #initialized = false;
  #raceTagIds = null;

  // load name sets from all configured sources
  async initialize() {
    if (this.#initialized) return;

    const timer = logger.time('Name generator initialization');

    try {
      await this.#loadMetaFromSources();
      this.#addDefaultNames();
      this.#initialized = true;
      logger.info(`Loaded ${this.#nameMeta.length} name sets (${this.#nameDataMap.size} with full data)`);
    } catch (error) {
      logger.error('Failed to initialize name generator:', error);
    } finally {
      timer.end();
    }
  }

  // generate a full name based on the provided tags
  async generate(tags) {
    if (!this.#initialized) {
      logger.warn('Name generator not initialized');
      return this.#fallbackName();
    }

    const context = this.#parseContext(tags);
    const parts = {
      firstName: await this.#pickName('firstName', context),
      lastName: await this.#pickName('lastName', context),
      clan: await this.#pickName('clan', context),
      nickname: await this.#pickName('nickname', context),
    };

    return this.#assembleWithHook(context, parts, tags);
  }

  generateSync(tags) {
    if (!this.#initialized) {
      logger.warn('Name generator not initialized');
      return this.#fallbackName();
    }

    const context = this.#parseContext(tags);
    const parts = {
      firstName: this.#pickNameSync('firstName', context),
      lastName: this.#pickNameSync('lastName', context),
      clan: this.#pickNameSync('clan', context),
      nickname: this.#pickNameSync('nickname', context),
    };

    return this.#assembleWithHook(context, parts, tags);
  }

  #assembleWithHook(context, parts, tags) {
    const nameData = {
      context: { ...context },
      parts: { ...parts },
      tags: [...tags],
      useNickname: parts.nickname && Math.random() < UI.NICKNAME_CHANCE,
      result: null,
    };

    Hooks.callAll('cs-hero-box.preGenerateName', nameData);

    if (typeof nameData.result === 'string' && nameData.result.length > 0) {
      return nameData.result;
    }

    return this.#assemble(nameData);
  }

  #assemble(nameData) {
    const { context, parts, useNickname } = nameData;
    const { firstName, lastName, clan, nickname } = parts;

    const segments = [];

    if (firstName) segments.push(firstName);

    if (useNickname && nickname) {
      if (segments.length > 0 || lastName || clan) {
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

  // lazy-load the set of race tag ids
  #getRaceTagIds() {
    if (!this.#raceTagIds) {
      this.#raceTagIds = new Set(tag.getRaces().map(t => t.id));
    }
    return this.#raceTagIds;
  }

  // pick a random name of the given type that matches the context
  async #pickName(type, context) {
    const matchingSets = this.#findMatchingSets(type, context);
    if (!matchingSets.length) return null;

    const setsToUse = this.#preferSpecificSets(matchingSets, context);
    const selectedSet = setsToUse[Math.floor(Math.random() * setsToUse.length)];

    const names = await this.#getNames(selectedSet);
    return names.length ? names[Math.floor(Math.random() * names.length)] : null;
  }

  #pickNameSync(type, context) {
    const matchingSets = this.#findMatchingSets(type, context);
    if (!matchingSets.length) return null;

    const setsToUse = this.#preferSpecificSets(matchingSets, context);
    const selectedSet = setsToUse[Math.floor(Math.random() * setsToUse.length)];

    const names = this.#getNamesSync(selectedSet);
    return names.length ? names[Math.floor(Math.random() * names.length)] : null;
  }

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

    // prefer subrace-specific sets if available
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

  // get the actual name list from a set, loading from source if needed
  async #getNames(meta) {
    if (meta.namesResolved) {
      return meta.namesResolved;
    }

    let nameMap = this.#nameDataMap.get(meta.id);
    if (!nameMap) {
      nameMap = await this.#loadNameData(meta);
      if (nameMap) {
        this.#nameDataMap.set(meta.id, nameMap);
      }
    }

    if (!nameMap) return [];

    const locale = game.i18n.lang;
    const names = nameMap[locale] ?? nameMap['en'] ?? nameMap[Object.keys(nameMap)[0]] ?? [];
    meta.namesResolved = names;
    return names;
  }

  #getNamesSync(meta) {
    if (meta.namesResolved) {
      return meta.namesResolved;
    }

    if (meta.inlineNames) {
      const locale = game.i18n.lang;
      const names = meta.inlineNames[locale] ?? meta.inlineNames['en'] ?? meta.inlineNames[Object.keys(meta.inlineNames)[0]] ?? [];
      meta.namesResolved = names;
      return names;
    }

    const nameMap = this.#nameDataMap.get(meta.id);
    if (!nameMap) return [];

    const locale = game.i18n.lang;
    const names = nameMap[locale] ?? nameMap['en'] ?? nameMap[Object.keys(nameMap)[0]] ?? [];
    meta.namesResolved = names;
    return names;
  }

  // load name data from an inline source or a journal page
  async #loadNameData(meta) {
    if (meta.inlineNames) {
      return meta.inlineNames;
    }

    if (meta.uuid) {
      const page = await fromUuid(meta.uuid);
      if (page) {
        const nameData = getFlag(page, FLAGS.NAME_DATA);
        return nameData?.names ?? null;
      }
    }

    return null;
  }

  // load name set metadata from all configured data sources
  async #loadMetaFromSources() {
    const sources = source.getEnabledSources();
    if (!sources || sources.length === 0) return;

    for (const sourceId of sources) {
      try {
        const pages = await getSourcePages(sourceId);

        for (const page of pages) {
          const nameData = getFlag(page, FLAGS.NAME_DATA);
          if (!nameData?.names) continue;

          const tags = this.#extractTags(nameData);
          const id = page.uuid;

          this.#nameMeta.push({
            id,
            uuid: page.uuid,
            tags,
            type: nameData.type ?? 'firstName',
            inlineNames: null,
            namesResolved: null,
          });
        }
      } catch (error) {
        logger.warn(`Failed to load names from source: ${sourceId}`, error);
      }
    }
  }

  // clear everything and reload from sources
  async reload() {
    this.#nameMeta = [];
    this.#nameDataMap.clear();
    this.#initialized = false;
    this.#raceTagIds = null;
    await this.initialize();
  }

  // grab tags from name data in either new or legacy format
  #extractTags(nameData) {
    if (nameData.tags) return nameData.tags;
    const tags = [];
    if (nameData.genders?.length) tags.push(...nameData.genders);
    if (nameData.races?.length) tags.push(...nameData.races);
    if (nameData.subraces?.length) tags.push(...nameData.subraces);
    return tags;
  }

  // register all the built-in default names from data/default-names.mjs
  #addDefaultNames() {
    for (const [race, raceData] of Object.entries(DEFAULT_NAMES)) {
      if (typeof raceData !== 'object') continue;

      const hasSubraces = Object.keys(raceData).some(key =>
        typeof raceData[key] === 'object' && raceData[key]?.name
      );

      if (hasSubraces) {
        for (const [subraceId, subraceData] of Object.entries(raceData)) {
          if (typeof subraceData === 'object' && subraceData.name) {
            this.#processRaceNames(race, subraceId, subraceData);
          }
        }
      } else {
        this.#processRaceNames(race, null, raceData);
      }
    }
  }

  // register names for a single race/subrace combo
  #processRaceNames(race, subrace, data) {
    const baseTags = subrace ? [race, subrace] : [race];

    if (data.name) {
      for (const [key, names] of Object.entries(data.name)) {
        if (!Array.isArray(names)) continue;

        const tags = [...baseTags];

        if (key === GENDER_TAGS.MALE || key === GENDER_TAGS.FEMALE || key === AGE_TAGS.CHILD) {
          tags.push(key);
        } else if (key !== 'virtue') {
          continue;
        }

        const id = `default:${race}:${subrace ?? ''}:name:${key}`;
        this.#nameMeta.push({
          id,
          uuid: null,
          tags,
          type: 'firstName',
          inlineNames: { ru: names },
          namesResolved: null,
        });
      }

      if (Array.isArray(data.name.virtue)) {
        const id = `default:${race}:${subrace ?? ''}:virtue`;
        this.#nameMeta.push({
          id,
          uuid: null,
          tags: baseTags,
          type: 'firstName',
          inlineNames: { ru: data.name.virtue },
          namesResolved: null,
        });
      }
    }

    const additionalTypes = ['lastName', 'clan', 'nickname'];
    for (const type of additionalTypes) {
      if (Array.isArray(data[type])) {
        const id = `default:${race}:${subrace ?? ''}:${type}`;
        this.#nameMeta.push({
          id,
          uuid: null,
          tags: baseTags,
          type,
          inlineNames: { ru: data[type] },
          namesResolved: null,
        });
      }
    }
  }

  // last resort when nothing matches
  #fallbackName() {
    return `${game.i18n.localize('cs-hero-box.actor.fallbackName')} #${foundry.utils.randomID(8)}`;
  }
}

export const nameGenerator = new NameGeneratorService();
