import { MODULE_ID, FLAGS } from '../constants/index.mjs';
import { TAG_CATEGORY, GENDER_TAGS, AGE_TAGS } from '../constants/tags.mjs';
import { logger, getFlag } from '../utils/index.mjs';
import { getSourcePages } from '../utils/source.mjs';
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

// manages the tag registry — races, subraces, roles, etc.
class TagService {
  #tags = new Map();
  #subracesByParent = new Map();
  #tagsByCategory = new Map();
  #labelCache = new Map();
  #initialized = false;

  // load all tags from configured sources
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

  // clear everything and reload from sources
  async reload() {
    this.#tags.clear();
    this.#subracesByParent.clear();
    this.#tagsByCategory.clear();
    this.#labelCache.clear();
    this.#initialized = false;
    await this.initialize();
  }

  // look up a tag by id, optionally scoped to a parent race
  get(id, parentRaceId = null) {
    if (parentRaceId) {
      const subraces = this.#subracesByParent.get(parentRaceId);
      return subraces?.find(s => s.id === id) ?? null;
    }
    return this.#tags.get(id) ?? null;
  }

  // get all tags including subraces
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

  // get tags filtered by category
  getByCategory(category) {
    return this.#tagsByCategory.get(category) ?? [];
  }

  // convenience getters for common categories
  getRaces() {
    return this.getByCategory(TAG_CATEGORY.RACE);
  }

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

  getRoles() {
    return this.getByCategory(TAG_CATEGORY.ROLE);
  }

  getOther() {
    return this.getByCategory(TAG_CATEGORY.OTHER);
  }

  getGenders() {
    return [GENDER_TAGS.MALE, GENDER_TAGS.FEMALE]
      .map(id => this.#tags.get(id))
      .filter(Boolean);
  }

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

  // get the localized label for a tag
  getLabel(tagId) {
    const cached = this.#labelCache.get(tagId);
    if (cached !== undefined) return cached;

    const label = this.#resolveLabel(tagId);
    this.#labelCache.set(tagId, label);
    return label;
  }

  // check if a race has any subraces defined
  hasSubraces(raceId) {
    return (this.#subracesByParent.get(raceId)?.length ?? 0) > 0;
  }

  // try locale key first, fall back to stored label, then raw id
  #resolveLabel(tagId) {
    const localeKey = `cs-hero-box.tags.${tagId}`;
    const localized = game.i18n.localize(localeKey);

    if (localized !== localeKey) {
      return localized;
    }

    const tagData = this.#tags.get(tagId);
    if (tagData) {
      return tagData.label ?? tagId;
    }

    return tagId;
  }

  // pre-cache all labels for faster lookups
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

  // add the hardcoded gender/age tags
  #registerBuiltinTags() {
    for (const tagData of BUILTIN_TAGS) {
      this.#tags.set(tagData.id, tagData);
      this.#addToCategory('builtin', tagData);
    }
  }

  // load custom tags from data sources
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

  // register a normal tag (race, role, other)
  #addTag(entry) {
    if (this.#tags.has(entry.id)) {
      logger.debug(`Tag "${entry.id}" already exists, skipping (priority: earlier source)`);
      return;
    }

    this.#tags.set(entry.id, entry);
    this.#addToCategory(entry.category, entry);
  }

  // register a subrace, linked to its parent race
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

  // helper to add a tag to its category bucket
  #addToCategory(category, tagData) {
    if (!this.#tagsByCategory.has(category)) {
      this.#tagsByCategory.set(category, []);
    }
    this.#tagsByCategory.get(category).push(tagData);
  }

  // count total subraces across all races
  #countSubraces() {
    let count = 0;
    for (const subraces of this.#subracesByParent.values()) {
      count += subraces.length;
    }
    return count;
  }
}

export const tag = new TagService();