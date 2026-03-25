import { MODULE_ID, FLAGS, SETTINGS, PACKS } from '../constants/index.mjs';
import { logger } from '../utils/index.mjs';
import { parseSourceId, SOURCE_TYPE, journalHasModuleData } from '../utils/source.mjs';

// manages the list of data sources (compendiums and journals) the module pulls from
class SourceService {
  #sourcesCache = null;
  #writableJournalsCache = null;
  #sourceNameCache = new Map();
  #initialized = false;

  // run one-time setup — migrate old settings format and scan for new journals
  async initialize() {
    if (this.#initialized) return;

    await this.#migrateOldFormat();
    await this.#autoDiscoverJournals();

    this.#initialized = true;
  }

  // alias for getEnabledSources
  getDataSources() {
    return this.getEnabledSources();
  }

  // get just the source ids that are currently enabled
  getEnabledSources() {
    const sources = this.#getSources();
    return sources.filter(s => s.enabled).map(s => s.id);
  }

  // get all sources including disabled ones
  getAllSources() {
    return this.#getSources();
  }

  // look up the display name for a source id
  getSourceName(sourceId) {
    if (!sourceId) return '';

    const cached = this.#sourceNameCache.get(sourceId);
    if (cached !== undefined) return cached;

    const parsed = parseSourceId(sourceId);
    let name;

    if (parsed.type === SOURCE_TYPE.COMPENDIUM) {
      const pack = game.packs.get(parsed.packId);
      name = pack?.title ?? parsed.packId;
    } else {
      const journal = fromUuidSync(sourceId);
      name = journal?.name ?? sourceId;
    }

    this.#sourceNameCache.set(sourceId, name);
    return name;
  }

  // get list of journals we can write to (for the journal dropdown in data manager)
  getWritableJournals() {
    if (this.#writableJournalsCache) return this.#writableJournalsCache;

    const sources = this.getEnabledSources();
    const journals = [];

    for (const sourceId of sources) {
      const parsed = parseSourceId(sourceId);

      if (parsed.type === SOURCE_TYPE.COMPENDIUM) {
        const pack = game.packs.get(parsed.packId);
        if (pack) {
          journals.push({
            id: sourceId,
            name: `[Compendium] ${pack.title}`,
            isCompendium: true,
          });
        }
      } else {
        const journal = fromUuidSync(sourceId);
        if (journal) {
          journals.push({
            id: sourceId,
            name: journal.name,
            isCompendium: false,
          });
        }
      }
    }

    this.#writableJournalsCache = journals;
    return journals;
  }

  // add extra display info to a source for rendering in the settings ui
  enrichSourceData(sourceData, index, total) {
    const parsed = parseSourceId(sourceData.id);

    const data = {
      id: sourceData.id,
      name: sourceData.id,
      type: 'unknown',
      typeLabel: 'unknown',
      icon: 'fa-question',
      enabled: sourceData.enabled,
      index,
      canMoveUp: index > 0,
      canMoveDown: index < total - 1,
    };

    if (parsed.type === SOURCE_TYPE.COMPENDIUM) {
      const pack = game.packs.get(parsed.packId);
      if (pack) {
        data.name = pack.title;

        const isModulePack = pack.metadata?.packageType === 'module' ||
                             pack.collection.startsWith('cs-hero-box') ||
                             game.modules.has(pack.metadata?.packageName);

        if (isModulePack) {
          data.icon = 'fa-plug';
          data.typeLabel = pack.metadata?.packageName || pack.collection.split('.')[0];
        } else {
          data.icon = 'fa-globe-asia';
          data.typeLabel = game.world.id;
        }
        data.type = 'compendium';
      }
    } else {
      const journal = fromUuidSync(sourceData.id);
      if (journal) {
        data.name = journal.name;
        data.type = 'world';
        data.icon = 'fa-book';
        data.typeLabel = game.world.id;
      }
    }

    return data;
  }

  // add a new source to the list
  async addSource(sourceId, enabled = true) {
    const sources = this.#getSources();

    if (sources.some(s => s.id === sourceId)) {
      return false;
    }

    sources.push({ id: sourceId, enabled });
    await this.#saveSources(sources);

    await this.#unlockSourceIfNeeded(sourceId);

    return true;
  }

  // unlock a compendium if it's locked so we can write to it
  async #unlockSourceIfNeeded(sourceId) {
    const parsed = parseSourceId(sourceId);

    if (parsed.type === SOURCE_TYPE.COMPENDIUM) {
      const pack = game.packs.get(parsed.packId);
      if (pack && pack.locked) {
        try {
          await pack.configure({ locked: false });
          logger.info(`Unlocked compendium: ${parsed.packId}`);
        } catch (error) {
          logger.warn(`Failed to unlock compendium ${parsed.packId}:`, error);
        }
      }
    }
  }

  // remove a source from the list
  async removeSource(sourceId) {
    const sources = this.#getSources();
    const filtered = sources.filter(s => s.id !== sourceId);

    if (filtered.length !== sources.length) {
      await this.#saveSources(filtered);
      return true;
    }
    return false;
  }

  // toggle a source on or off
  async setSourceEnabled(sourceId, enabled) {
    const sources = this.#getSources();
    const sourceItem = sources.find(s => s.id === sourceId);

    if (sourceItem) {
      sourceItem.enabled = enabled;
      await this.#saveSources(sources);
      return true;
    }
    return false;
  }

  // change the priority order of a source
  async moveSource(sourceId, direction) {
    const sources = this.#getSources();
    const index = sources.findIndex(s => s.id === sourceId);

    if (index === -1) return false;

    const newIndex = direction === 'up' ? index - 1 : index + 1;

    if (newIndex < 0 || newIndex >= sources.length) return false;

    const [removed] = sources.splice(index, 1);
    sources.splice(newIndex, 0, removed);

    await this.#saveSources(sources);
    return true;
  }

  // force refresh of cached data
  invalidateCache() {
    this.#sourcesCache = null;
    this.#writableJournalsCache = null;
    this.#sourceNameCache.clear();
  }

  // convert old string[] format to new {id, enabled}[] format
  async #migrateOldFormat() {
    try {
      const raw = game.settings.get(MODULE_ID, SETTINGS.DATA_SOURCES);

      if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') {
        logger.info('Migrating old DATA_SOURCES format');
        const migrated = raw.map(id => ({ id, enabled: true }));
        await this.#saveSources(migrated);
      }
    } catch (error) {
      logger.warn('Migration check failed:', error);
    }
  }

  // scan world journals and compendiums for any that have our flags
  async #autoDiscoverJournals() {
    if (!game.user.isGM) return;

    const sources = this.#getSources();
    const existingIds = new Set(sources.map(s => s.id));
    let added = 0;

    for (const journal of game.journal) {
      const journalId = journal.uuid;

      if (existingIds.has(journalId)) continue;

      const hasModuleData = journalHasModuleData(journal);

      if (hasModuleData) {
        sources.push({ id: journalId, enabled: true });
        existingIds.add(journalId);
        added++;
        logger.info(`Auto-discovered world journal: ${journal.name}`);
      }
    }

    for (const pack of game.packs) {
      if (pack.documentName !== 'JournalEntry') continue;

      const packId = `Compendium.${pack.collection}`;
      if (existingIds.has(packId)) continue;

      try {
        const hasModuleData = await this.#compendiumHasModuleData(pack);

        if (hasModuleData) {
          sources.push({ id: packId, enabled: true });
          existingIds.add(packId);
          added++;
          logger.info(`Auto-discovered compendium: ${pack.title}`);
        }
      } catch (error) {
        logger.warn(`Failed to scan compendium ${pack.collection}:`, error);
      }
    }

    if (added > 0) {
      await this.#saveSources(sources);
      ui.notifications.info(game.i18n.format('cs-hero-box.dataSources.autoDiscovered', { count: added }));
    }
  }

  // check if any journal in a compendium has our flags
  async #compendiumHasModuleData(pack) {
    try {
      const journals = await pack.getDocuments();

      for (const journal of journals) {
        if (journalHasModuleData(journal)) {
          return true;
        }
      }
    } catch (error) {
      logger.debug(`Cannot read compendium ${pack.collection}:`, error);
    }

    return false;
  }

  // get the raw source list from settings, with caching
  #getSources() {
    if (this.#sourcesCache !== null) {
      return this.#sourcesCache;
    }

    try {
      const raw = game.settings.get(MODULE_ID, SETTINGS.DATA_SOURCES);

      if (!Array.isArray(raw) || raw.length === 0) {
        this.#sourcesCache = [];
      } else if (typeof raw[0] === 'string') {
        this.#sourcesCache = raw
          .filter(id => !id.includes('cs-hero-box-data'))
          .map(id => ({ id, enabled: true }));
      } else {
        this.#sourcesCache = raw.filter(s => !s.id.includes('cs-hero-box-data'));
      }
    } catch {
      this.#sourcesCache = [];
    }

    return this.#sourcesCache;
  }

  // persist the source list to settings and clear caches
  async #saveSources(sources) {
    this.#sourcesCache = sources;
    this.#writableJournalsCache = null;
    this.#sourceNameCache.clear();
    await game.settings.set(MODULE_ID, SETTINGS.DATA_SOURCES, sources);
  }
}

export const source = new SourceService();