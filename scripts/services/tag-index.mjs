import { MODULE_ID, FLAGS, DEFAULT_IMAGE_DATA } from '../constants/index.mjs';
import { logger, getFlag } from '../utils/index.mjs';
import { getSourcePages } from '../utils/source.mjs';
import { derivePortraitUrl } from '../utils/filepicker.mjs';
import { indexCache } from '../utils/cache.mjs';
import { source } from './source.mjs';
import { tag } from './tag.mjs';

const CACHE_KEY = 'tag-index';
const CACHE_META_KEY = 'tag-index-meta';

// main index of all images and their tags — the heart of the filtering system
class TagIndexService {
  #tagToImages = new Map();
  #imageCache = new Map();
  #urlIndex = new Map();
  #initialized = false;
  #initializing = false;
  #cacheDirty = false;
  #saveCacheTimer = null;

  // load the index from cache or rebuild from sources
  async initialize() {
    if (this.#initialized || this.#initializing) return;
    this.#initializing = true;

    const timer = logger.time('Tag index initialization');

    try {
      const sources = source.getDataSources();

      if (!sources || sources.length === 0) {
        logger.debug('No data sources for tag index');
        this.#initialized = true;
        return;
      }

      const loaded = await this.#tryLoadFromCache(sources);

      if (!loaded) {
        for (const sourceId of sources) {
          await this.#indexSource(sourceId);
        }
        this.#saveToCache(sources);
      }

      this.#initialized = true;
      logger.info(`Indexed ${this.#imageCache.size} images with ${this.#tagToImages.size} unique tags`);
    } catch (error) {
      logger.error('Failed to initialize tag index:', error);
      throw error;
    } finally {
      this.#initializing = false;
      timer.end();
    }
  }

  // nuke everything and rebuild from scratch
  async reindex() {
    logger.info('Reindexing all sources...');
    this.#tagToImages.clear();
    this.#imageCache.clear();
    this.#urlIndex.clear();
    this.#initialized = false;
    this.#initializing = false;
    this.#cacheDirty = false;
    await indexCache.delete(CACHE_KEY);
    await indexCache.delete(CACHE_META_KEY);
    await this.initialize();
  }

  // try to restore the index from indexeddb
  async #tryLoadFromCache(sources) {
    const opened = await indexCache.open();
    if (!opened) return false;

    try {
      const meta = await indexCache.get(CACHE_META_KEY);
      if (!meta) return false;

      const currentFingerprint = this.#buildFingerprint(sources);
      if (meta.fingerprint !== currentFingerprint) {
        logger.debug('Cache fingerprint mismatch, reindexing');
        return false;
      }

      const cached = await indexCache.get(CACHE_KEY);
      if (!cached || !Array.isArray(cached)) return false;

      const timer = logger.time('Loading from IndexedDB cache');

      for (const entry of cached) {
        this.#addImageToIndex(entry.uuid, entry, entry.sourceId);
      }

      timer.end();
      logger.info(`Loaded ${cached.length} images from cache`);
      return true;
    } catch (error) {
      logger.debug('Cache load failed:', error);
      return false;
    }
  }

  // persist the index to indexeddb for faster startup
  async #saveToCache(sources) {
    try {
      const opened = await indexCache.open();
      if (!opened) return;

      const entries = [];
      for (const img of this.#imageCache.values()) {
        entries.push({
          uuid: img.uuid,
          tokenUrl: img.tokenUrl,
          portraitUrl: img.portraitUrl,
          scale: img.scale,
          tags: img.tags,
          dynamicRing: img.dynamicRing,
          sourceId: img.sourceId,
        });
      }

      await indexCache.set(CACHE_KEY, entries);
      await indexCache.set(CACHE_META_KEY, {
        fingerprint: this.#buildFingerprint(sources),
        timestamp: Date.now(),
        count: entries.length,
      });

      logger.debug(`Saved ${entries.length} images to cache`);
    } catch (error) {
      logger.debug('Cache save failed:', error);
    }
  }

  // unique id based on enabled sources — if it changes, we need to reindex
  #buildFingerprint(sources) {
    return sources.sort().join('|') + '|' + game.world.id;
  }

  // update a single image in the index
  #markCacheDirty() {
    this.#cacheDirty = true;
    if (this.#saveCacheTimer) {
      clearTimeout(this.#saveCacheTimer);
    }
    this.#saveCacheTimer = setTimeout(() => {
      this.#saveCacheTimer = null;
      if (this.#cacheDirty) {
        this.#cacheDirty = false;
        const sources = source.getDataSources();
        this.#saveToCache(sources);
      }
    }, 2000);
  }

  updateImage(uuid, newImageData) {
    if (!this.#initialized) return;
    this.#removeImageInternal(uuid);
    if (newImageData) {
      this.#addImageToIndex(uuid, newImageData);
    }
    this.#markCacheDirty();
  }

  // batch update multiple images
  updateImages(updates) {
    if (!this.#initialized) return;
    for (const { uuid, imageData } of updates) {
      this.#removeImageInternal(uuid);
      if (imageData) {
        this.#addImageToIndex(uuid, imageData);
      }
    }
    this.#markCacheDirty();
  }

  // update just the tags for an image (faster than full update)
  updateImageTags(uuid, newTags) {
    if (!this.#initialized) return;
    const existing = this.#imageCache.get(uuid);
    if (!existing) return;

    for (const tagId of existing.tags) {
      const imageSet = this.#tagToImages.get(tagId);
      if (imageSet) {
        imageSet.delete(uuid);
        if (imageSet.size === 0) this.#tagToImages.delete(tagId);
      }
    }

    existing.tags = newTags;
    existing.searchString = this.#buildSearchString(existing.tokenUrl, existing.portraitUrl, newTags);

    for (const tagId of newTags) {
      if (!this.#tagToImages.has(tagId)) this.#tagToImages.set(tagId, new Set());
      this.#tagToImages.get(tagId).add(uuid);
    }
    this.#markCacheDirty();
  }

  // add many images at once (used during import)
  bulkAddImages(images, sourceId = null) {
    if (!this.#initialized) return;
    for (const { uuid, imageData } of images) {
      if (this.#imageCache.has(uuid)) this.#removeImageInternal(uuid);
      this.#addImageToIndex(uuid, imageData, sourceId);
    }
    this.#markCacheDirty();
  }

  // remove an image from all indexes
  removeImage(uuid) {
    if (!this.#initialized) return;
    this.#removeImageInternal(uuid);
    this.#markCacheDirty();
  }

  removeImages(uuids) {
    if (!this.#initialized) return;
    for (const uuid of uuids) this.#removeImageInternal(uuid);
    this.#markCacheDirty();
  }

  addImage(uuid, imageData, sourceId = null) {
    if (!this.#initialized) return;
    if (this.#imageCache.has(uuid)) this.#removeImageInternal(uuid);
    this.#addImageToIndex(uuid, imageData, sourceId);
    this.#markCacheDirty();
  }

  #removeImageInternal(uuid) {
    const existing = this.#imageCache.get(uuid);
    if (!existing) return;

    for (const tagId of existing.tags) {
      const imageSet = this.#tagToImages.get(tagId);
      if (imageSet) {
        imageSet.delete(uuid);
        if (imageSet.size === 0) this.#tagToImages.delete(tagId);
      }
    }

    if (existing.tokenUrl) this.#urlIndex.delete(existing.tokenUrl);
    if (existing.portraitUrl && existing.portraitUrl !== existing.tokenUrl) this.#urlIndex.delete(existing.portraitUrl);

    this.#imageCache.delete(uuid);
  }

  // extract the journal uuid from a page uuid
  getJournalUuid(pageUuid) {
    const existing = this.#imageCache.get(pageUuid);
    if (existing?.journalUuid) return existing.journalUuid;
    const parts = pageUuid.split('.');
    return parts.slice(0, -1).join('.');
  }

  // extract just the page id from a full uuid
  getPageId(pageUuid) {
    const parts = pageUuid.split('.');
    return parts[parts.length - 1];
  }

  // get the raw image cache map
  getAllImages() {
    return this.#imageCache;
  }

  // get all images as an array
  getAllImagesArray() {
    return Array.from(this.#imageCache.values());
  }

  // build the search string we use for text filtering
  #buildSearchString(tokenUrl, portraitUrl, tags) {
    const tagLabels = tags.map(t => tag.getLabel(t));
    return [tokenUrl, portraitUrl, ...tags, ...tagLabels].join(' ').toLowerCase();
  }

  // add an image to all the internal indexes
  #addImageToIndex(uuid, imageData, sourceId = null) {
    const tokenUrl = imageData.tokenUrl || imageData.url || '';
    const portraitUrl = imageData.portraitUrl || derivePortraitUrl(tokenUrl);
    const tags = Array.isArray(imageData.tags) ? imageData.tags : [];

    const parts = uuid.split('.');
    const journalUuid = parts.slice(0, -1).join('.');

    const indexedImage = {
      uuid,
      journalUuid,
      tokenUrl,
      portraitUrl,
      scale: imageData.scale ?? DEFAULT_IMAGE_DATA.scale,
      tags,
      dynamicRing: imageData.dynamicRing ?? DEFAULT_IMAGE_DATA.dynamicRing,
      sourceId,
      searchString: this.#buildSearchString(tokenUrl, portraitUrl, tags),
      fileName: (portraitUrl || tokenUrl).split('/').pop(),
    };

    this.#imageCache.set(uuid, indexedImage);

    if (tokenUrl) this.#urlIndex.set(tokenUrl, indexedImage);
    if (portraitUrl && portraitUrl !== tokenUrl) this.#urlIndex.set(portraitUrl, indexedImage);

    for (const tagId of tags) {
      if (!this.#tagToImages.has(tagId)) this.#tagToImages.set(tagId, new Set());
      this.#tagToImages.get(tagId).add(uuid);
    }
  }

  // find all images that have ALL the specified tags
  findByTags(requiredTags) {
    if (!this.#initialized) {
      logger.warn('Tag index not initialized');
      return [];
    }

    if (!requiredTags?.length) return this.getAllImagesArray();

    let resultUuids = null;

    for (const tagId of requiredTags) {
      const imagesWithTag = this.#tagToImages.get(tagId);
      if (!imagesWithTag?.size) return [];

      resultUuids = resultUuids
        ? this.#intersect(resultUuids, imagesWithTag)
        : new Set(imagesWithTag);

      if (!resultUuids.size) return [];
    }

    return Array.from(resultUuids).map(uuid => this.#imageCache.get(uuid)).filter(Boolean);
  }

  // find images matching tag groups (OR within groups, AND between groups)
  findByTagGroups(tagGroups) {
    if (!this.#initialized) {
      logger.warn('Tag index not initialized');
      return [];
    }

    const activeGroups = Object.entries(tagGroups).filter(([_, tags]) => tags?.length > 0);
    if (activeGroups.length === 0) return this.getAllImagesArray();

    let resultUuids = null;

    for (const [_, tags] of activeGroups) {
      const categoryUuids = new Set();
      for (const tagId of tags) {
        const imagesWithTag = this.#tagToImages.get(tagId);
        if (imagesWithTag) {
          for (const uuid of imagesWithTag) categoryUuids.add(uuid);
        }
      }
      if (categoryUuids.size === 0) return [];

      resultUuids = resultUuids ? this.#intersect(resultUuids, categoryUuids) : categoryUuids;
      if (!resultUuids.size) return [];
    }

    return Array.from(resultUuids).map(uuid => this.#imageCache.get(uuid)).filter(Boolean);
  }

  // find an image by its token or portrait url
  findByUrl(url) {
    if (!this.#initialized || !url) return null;
    return this.#urlIndex.get(url) ?? null;
  }

  // get a single image by its uuid
  getByUuid(uuid) {
    if (!this.#initialized) return null;
    return this.#imageCache.get(uuid) ?? null;
  }

  // get a sorted list of all tags in the index
  getAllTags() {
    return Array.from(this.#tagToImages.keys()).sort();
  }

  // get count stats for the ui
  getStats() {
    const tagCounts = new Map();
    for (const [tagId, uuids] of this.#tagToImages) {
      tagCounts.set(tagId, uuids.size);
    }
    return {
      totalImages: this.#imageCache.size,
      totalTags: this.#tagToImages.size,
      tagCounts,
    };
  }

  get isInitialized() {
    return this.#initialized;
  }

  // index all pages from a single source
  async #indexSource(sourceId) {
    const timer = logger.time(`Indexing source: ${sourceId}`);
    try {
      const pages = await getSourcePages(sourceId);
      for (const page of pages) this.#indexPage(page, sourceId);
    } catch (error) {
      logger.warn(`Failed to index source: ${sourceId}`, error);
    } finally {
      timer.end();
    }
  }

  // index a single page if it has image data
  #indexPage(page, sourceId) {
    const imageData = getFlag(page, FLAGS.IMAGE_DATA);
    if (!imageData?.tokenUrl && !imageData?.url) return;
    this.#addImageToIndex(page.uuid, imageData, sourceId);
  }

  // fast set intersection helper
  #intersect(setA, setB) {
    const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
    const result = new Set();
    for (const item of smaller) {
      if (larger.has(item)) result.add(item);
    }
    return result;
  }
}

export const tagIndex = new TagIndexService();
