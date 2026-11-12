**
 * @fileoverview Optional Web Worker bridge for large image-list filter/search in the data manager.
 */

import { logger } from './logger.mjs';

const WORKER_THRESHOLD = 2000;

/** Spawns an inline worker with cached dataset when item count exceeds threshold. */
class FilterWorkerBridge {
  #worker = null;
  #blobUrl = null;
  #pendingResolve = null;
  #pendingReject = null;
  #requestId = 0;
  #available = false;
  #cachedItemsRef = null;
  #cachedItemsLength = -1;

  /** True when worker was successfully created for large lists. */
  get shouldUseWorker() {
    return this.#available;
  }

  /**
   * @param {number} itemCount
   */
  async initialize(itemCount) {
    if (itemCount < WORKER_THRESHOLD) {
      this.destroy();
      this.#available = false;
      return;
    }

    if (this.#worker) {
      this.#available = true;
      return;
    }

    try {
      const workerCode = `
        let dataset = [];

        self.onmessage = function(e) {
          const { id, type, items, tagGroups, searchQuery } = e.data;

          if (type === 'setItems') {
            dataset = Array.isArray(items) ? items : [];
            return;
          }

          let result = dataset;

          if (tagGroups) {
            const activeGroups = Object.entries(tagGroups).filter(([_, tags]) => tags && tags.length > 0);
            if (activeGroups.length > 0) {
              result = result.filter(item => {
                const itemTags = new Set(item.tags);
                return activeGroups.every(([_, groupTags]) =>
                  groupTags.some(t => itemTags.has(t))
                );
              });
            }
          }

          if (searchQuery) {
            result = result.filter(item => item.searchString.includes(searchQuery));
          }

          const uuids = result.map(item => item.uuid);
          self.postMessage({ id, uuids });
        };

        self.postMessage({ type: 'ready' });
      `;

      const blob = new Blob([workerCode], { type: 'application/javascript' });
      this.#blobUrl = URL.createObjectURL(blob);
      this.#worker = new Worker(this.#blobUrl);

      this.#worker.onmessage = (e) => {
        if (e.data?.type === 'ready') {
          this.#revokeBlobUrl();
          return;
        }
        if (this.#pendingResolve && e.data.id === this.#requestId) {
          this.#pendingResolve(e.data.uuids);
          this.#pendingResolve = null;
          this.#pendingReject = null;
        }
      };

      this.#worker.onerror = (error) => {
        logger.warn('Filter worker error:', error);
        if (this.#pendingReject) {
          this.#pendingReject(error);
          this.#pendingResolve = null;
          this.#pendingReject = null;
        }
        this.destroy();
      };

      this.#available = true;
      logger.debug('Filter worker initialized');
    } catch (error) {
      logger.debug('Worker not available, falling back to main thread:', error);
      this.destroy();
    }
  }

  /**
   * @param {object[]} items
   * @param {Record<string, string[]>|null} tagGroups
   * @param {string} searchQuery
   * @returns {Promise<object[]|null>} Full items matching worker result, or null to use main-thread path.
   */
  async filter(items, tagGroups, searchQuery) {
    if (!this.#available || !this.#worker) {
      return null;
    }

    if (items !== this.#cachedItemsRef || items.length !== this.#cachedItemsLength) {
      const transferItems = items.map(item => ({
        uuid: item.uuid,
        tags: item.tags,
        searchString: item.searchString,
      }));
      this.#worker.postMessage({ type: 'setItems', items: transferItems });
      this.#cachedItemsRef = items;
      this.#cachedItemsLength = items.length;
    }

    this.#requestId++;
    const id = this.#requestId;

    return new Promise((resolve, reject) => {
      if (this.#pendingReject) {
        this.#pendingReject(new Error('Superseded'));
      }

      this.#pendingResolve = (uuids) => {
        const uuidSet = new Set(uuids);
        resolve(items.filter(item => uuidSet.has(item.uuid)));
      };
      this.#pendingReject = reject;

      this.#worker.postMessage({ id, type: 'query', tagGroups, searchQuery });
    });
  }

  #revokeBlobUrl() {
    if (this.#blobUrl) {
      try {
        URL.revokeObjectURL(this.#blobUrl);
      } catch {}
      this.#blobUrl = null;
    }
  }

  destroy() {
    this.#revokeBlobUrl();
    if (this.#worker) {
      try {
        this.#worker.terminate();
      } catch {}
      this.#worker = null;
    }
    this.#available = false;
    this.#cachedItemsRef = null;
    this.#cachedItemsLength = -1;
    if (this.#pendingReject) {
      try {
        this.#pendingReject(new Error('Worker destroyed'));
      } catch {}
    }
    this.#pendingResolve = null;
    this.#pendingReject = null;
  }
}

/** Shared filter worker instance for images tab. */
export const filterWorker = new FilterWorkerBridge();
