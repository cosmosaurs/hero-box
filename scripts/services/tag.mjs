/**
 * @fileoverview Tag registry: built-ins plus race/subrace/role loaded from `TAG_DATA` journal flags.
 */

import { MODULE_ID, FLAGS } from '../constants/index.mjs';
import { TAG_CATEGORY, GENDER_TAGS, AGE_TAGS } from '../constants/tags.mjs';
import { logger, getFlag } from '../utils/index.mjs';
import { getSourcePages, parseSourceId, SOURCE_TYPE } from '../utils/source.mjs';
import { source } from './source.mjs';

const BUILTIN_TAGS = [
  { id: GENDER_TAGS.MALE, category: 'builtin' },
  { id: GENDER_TAGS.FEMALE, category: 'builtin' },
  { id: AGE_TAGS.CHILD, category: 'builtin' },
  { id: AGE_TAGS.TEEN, category: 'builtin' },
  { id: AGE_TAGS.YOUNG, category: 'builtin' },
  { id: AGE_TAGS.ADULT, category: 'builtin' },
  { id: AGE_TAGS.OLD, category: 'builtin' },
];

/** Central tag metadata for filters, forms, and sidebar UI. */
class TagService {
  #tags = new Map();
  #subracesByParent = new Map();
  #tagsByCategory = new Map();
  #labelCache = new Map();
  #sourceLocalizationIdCache = new Map();
  #initialized = false;

  /** Register built-ins and load `TAG_DATA` from all configured sources. */
  async initialize() {
    if (this.#initialized) return;

    const timer = logger.time('Tag service initialization');

    try {
      this.#registerBuiltinTags();
      await this.#loadFromSources();
      this.#buildLabelCache();
      this.#initialized = true;
      logger.info(`Loaded ${this.#tags.size} tags, ${this.#countSubraces()} subraces`);
    } catch (error) {
      logger.error('Failed to initialize tag service:', error);
    } finally {
      timer.end();
    }
  }

  /** Reset registry and reload from sources. */
  async reload() {
    this.#tags.clear();
    this.#subracesByParent.clear();
    this.#tagsByCategory.clear();
    this.#labelCache.clear();
    this.#sourceLocalizationIdCache.clear();
    this.#initialized = false;
    await this.initialize();
  }

  /**
   * @param {string} id
   * @param {string|null} [parentRaceId] When resolving a subrace by id under a race.
   */
  get(id, parentRaceId = null) {
    if (parentRaceId) {
      const subraces = this.#subracesByParent.get(parentRaceId);
      return subraces?.find(s => s.id === id) ?? null;
    }
    return this.#tags.get(id) ?? null;
  }

  /** @returns {object[]} All primary tags plus subraces not duplicated in `#tags`. */
  getAll() {
    const allTags = Array.from(this.#tags.values());

    for (const subraces of this.#subracesByParent.values()) {
      for (const subrace of subraces) {
        if (!this.#tags.has(subrace.id)) {
          allTags.push(subrace);
        }
      }
    }

    return allTags;
  }

  /** @param {string} category */
  getByCategory(category) {
    return this.#tagsByCategory.get(category) ?? [];
  }

  /** @returns {object[]} */
  getRaces() {
    return this.getByCategory(TAG_CATEGORY.RACE);
  }

  /**
   * @param {string|null} [raceId] If set, subraces for that race only.
   * @returns {object[]}
   */
  getSubraces(raceId = null) {
    if (raceId) {
      return this.#subracesByParent.get(raceId) ?? [];
    }

    const allSubraces = [];
    for (const subraces of this.#subracesByParent.values()) {
      allSubraces.push(...subraces);
    }
    return allSubraces;
  }

  /** @returns {object[]} */
  getRoles() {
    return this.getByCategory(TAG_CATEGORY.ROLE);
  }

  /** @returns {object[]} */
  getOther() {
    return this.getByCategory(TAG_CATEGORY.OTHER);
  }

  /** @returns {object[]} Built-in gender tag records. */
  getGenders() {
    return [GENDER_TAGS.MALE, GENDER_TAGS.FEMALE]
      .map(id => this.#tags.get(id))
      .filter(Boolean);
  }

  /** @returns {object[]} Built-in age tag records. */
  getAges() {
    return [
      AGE_TAGS.CHILD,
      AGE_TAGS.TEEN,
      AGE_TAGS.YOUNG,
      AGE_TAGS.ADULT,
      AGE_TAGS.OLD,
    ]
      .map(id => this.#tags.get(id))
      .filter(Boolean);
  }

  /**
   * @param {string} tagId
   * @returns {string}
   */
  getLabel(tagId) {
    const cached = this.#labelCache.get(tagId);
    if (cached !== undefined) return cached;

    const label = this.#resolveLabel(tagId);
    this.#labelCache.set(tagId, label);
    return label;
  }

  /** @param {string} raceId */
  hasSubraces(raceId) {
    return (this.#subracesByParent.get(raceId)?.length ?? 0) > 0;
  }

  /**
   * @param {string} tagId
   * @returns {string}
   */
  #resolveLabel(tagId) {
    const tagData = this.#tags.get(tagId);
    const sourceLocalizationId = this.#resolveSourceLocalizationId(tagData);

    if (sourceLocalizationId) {
      const sourceLocaleKey = `${sourceLocalizationId}.tags.${tagId}`;
      const sourceLocalized = game.i18n.localize(sourceLocaleKey);
      if (sourceLocalized !== sourceLocaleKey) {
        return sourceLocalized;
      }
    }

    const moduleLocaleKey = `${MODULE_ID}.tags.${tagId}`;
    const moduleLocalized = game.i18n.localize(moduleLocaleKey);
    if (moduleLocalized !== moduleLocaleKey) {
      return moduleLocalized;
    }

    if (tagData?.label && tagData.label !== tagId) {
      return tagData.label;
    }

    return tagId;
  }

  /**
   * Compendium package name used as i18n namespace for pack tags.
   * @param {object|null|undefined} tagData
   * @returns {string|null}
   */
  #resolveSourceLocalizationId(tagData) {
    if (!tagData) return null;

    const sourceId = tagData.sourceId;
    if (!sourceId) return null;

    if (this.#sourceLocalizationIdCache.has(sourceId)) {
      return this.#sourceLocalizationIdCache.get(sourceId);
    }

    let resolved = null;
    try {
      const parsed = parseSourceId(sourceId);

      if (parsed.type === SOURCE_TYPE.COMPENDIUM && parsed.packId) {
        resolved = game.packs.get(parsed.packId).metadata.packageName;
      }
    } catch {
      resolved = null;
    }

    this.#sourceLocalizationIdCache.set(sourceId, resolved);
    return resolved;
  }

  /** Fill `#labelCache` from all registered tags and subraces. */
  #buildLabelCache() {
    this.#labelCache.clear();

    for (const [id] of this.#tags) {
      this.#labelCache.set(id, this.#resolveLabel(id));
    }

    for (const subraces of this.#subracesByParent.values()) {
      for (const subrace of subraces) {
        if (!this.#labelCache.has(subrace.id)) {
          this.#labelCache.set(subrace.id, this.#resolveLabel(subrace.id));
        }
      }
    }
  }

  /** Register built-in gender/age tags into `#tags` and category map. */
  #registerBuiltinTags() {
    for (const tagData of BUILTIN_TAGS) {
      this.#tags.set(tagData.id, tagData);
      this.#addToCategory('builtin', tagData);
    }
  }

  /** Scan journal pages for `TAG_DATA` and populate registry. */
  async #loadFromSources() {
    const sources = source.getDataSources();

    if (!sources || sources.length === 0) {
      logger.debug('No data sources configured');
      return;
    }

    for (const sourceId of sources) {
      try {
        const pages = await getSourcePages(sourceId);

        for (const page of pages) {
          const tagData = getFlag(page, FLAGS.TAG_DATA);
          if (!tagData?.id) continue;

          const entry = {
            uuid: page.uuid,
            id: tagData.id,
            category: tagData.category,
            parentRaceId: tagData.parentRaceId ?? null,
            label: tagData.label ?? tagData.labels?.en ?? tagData.id,
            sourceId,
          };

          if (entry.category === TAG_CATEGORY.SUBRACE && entry.parentRaceId) {
            this.#addSubrace(entry);
          } else {
            this.#addTag(entry);
          }
        }
      } catch (error) {
        logger.warn(`Failed to load tags from source: ${sourceId}`, error);
      }
    }
  }

  /** @param {object} entry */
  #addTag(entry) {
    if (this.#tags.has(entry.id)) {
      logger.debug(`Tag "${entry.id}" already exists, skipping (priority: earlier source)`);
      return;
    }

    this.#tags.set(entry.id, entry);
    this.#addToCategory(entry.category, entry);
  }

  /** @param {object} entry */
  #addSubrace(entry) {
    const parentId = entry.parentRaceId;

    if (!this.#subracesByParent.has(parentId)) {
      this.#subracesByParent.set(parentId, []);
    }

    const subraces = this.#subracesByParent.get(parentId);
    const existing = subraces.find(s => s.id === entry.id);

    if (existing) {
      logger.debug(`Subrace "${entry.id}" for race "${parentId}" already exists, skipping`);
      return;
    }

    subraces.push(entry);
    this.#addToCategory(entry.category, entry);

    if (!this.#tags.has(entry.id)) {
      this.#tags.set(entry.id, entry);
    }
  }

  /** @param {string} category */
  #addToCategory(category, tagData) {
    if (!this.#tagsByCategory.has(category)) {
      this.#tagsByCategory.set(category, []);
    }
    this.#tagsByCategory.get(category).push(tagData);
  }

  /** @returns {number} */
  #countSubraces() {
    let count = 0;
    for (const subraces of this.#subracesByParent.values()) {
      count += subraces.length;
    }
    return count;
  }
}

/** Singleton tag service. */
export const tag = new TagService();