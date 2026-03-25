import { logger } from './logger.mjs';

const WORKER_THRESHOLD = 2000;

// offloads heavy filtering to a web worker when the dataset is big enough
class FilterWorkerBridge {
  #worker = null;
  #pendingResolve = null;
  #pendingReject = null;
  #requestId = 0;
  #available = false;

  get shouldUseWorker() {
    return this.#available;
  }

  // spin up the worker if we have enough items, otherwise skip it
  async initialize(itemCount) {
    if (itemCount < WORKER_THRESHOLD) {
      this.#available = false;
      return;
    }

    if (this.#worker) {
      this.#available = true;
      return;
    }

    try {
      const workerCode = `
        self.onmessage = function(e) {
          const { id, type, items, tagGroups, searchQuery } = e.data;

          let result = items;

          if (type === 'filter' || type === 'both') {
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
          }

          if (type === 'search' || type === 'both') {
            if (searchQuery) {
              result = result.filter(item => item.searchString.includes(searchQuery));
            }
          }

          self.postMessage({ id, result });
        };
      `;

      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      this.#worker = new Worker(url);
      URL.revokeObjectURL(url);

      this.#worker.onmessage = (e) => {
        if (this.#pendingResolve && e.data.id === this.#requestId) {
          this.#pendingResolve(e.data.result);
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
      };

      this.#available = true;
      logger.debug('Filter worker initialized');
    } catch (error) {
      logger.debug('Worker not available, falling back to main thread:', error);
      this.#available = false;
    }
  }

  // send items to the worker for filtering, returns null if worker is down
  async filter(items, tagGroups, searchQuery) {
    if (!this.#available || !this.#worker) {
      return null;
    }

    const transferItems = items.map(item => ({
      uuid: item.uuid,
      tags: item.tags,
      searchString: item.searchString,
    }));

    let type = 'both';
    if (!tagGroups && searchQuery) type = 'search';
    else if (tagGroups && !searchQuery) type = 'filter';

    this.#requestId++;
    const id = this.#requestId;

    return new Promise((resolve, reject) => {
      if (this.#pendingReject) {
        this.#pendingReject(new Error('Superseded'));
      }

      this.#pendingResolve = (resultItems) => {
        const uuidSet = new Set(resultItems.map(r => r.uuid));
        resolve(items.filter(item => uuidSet.has(item.uuid)));
      };
      this.#pendingReject = reject;

      this.#worker.postMessage({ id, type, items: transferItems, tagGroups, searchQuery });
    });
  }

  // kill the worker and clean up
  destroy() {
    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
    }
    this.#available = false;
    this.#pendingResolve = null;
    this.#pendingReject = null;
  }
}

export const filterWorker = new FilterWorkerBridge();