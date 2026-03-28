/**
 * @fileoverview IndexedDB key-value store for persisting the tag index between sessions.
 */

import { MODULE_ID } from '../constants/index.mjs';
import { logger } from './logger.mjs';

const DB_NAME = `${MODULE_ID}-cache`;
const DB_VERSION = 1;
const STORE_NAME = 'index';

/** Thin IndexedDB wrapper for tag-index persistence. */
class IndexedDBCache {
  #db = null;
  #available = false;

  /** @returns {Promise<boolean>} */
  async open() {
    if (this.#db) return true;

    try {
      if (typeof indexedDB === 'undefined') return false;

      this.#db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME);
          }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      this.#available = true;
      return true;
    } catch (error) {
      logger.debug('IndexedDB not available:', error);
      this.#available = false;
      return false;
    }
  }

  /** @param {string} key */
  async get(key) {
    if (!this.#available) return null;

    try {
      return await this.#transaction('readonly', (store) => store.get(key));
    } catch {
      return null;
    }
  }

  /** @param {string} key */
  async set(key, value) {
    if (!this.#available) return;

    try {
      await this.#transaction('readwrite', (store) => store.put(value, key));
    } catch (error) {
      logger.debug('Cache write failed:', error);
    }
  }

  // remove a single key
  async delete(key) {
    if (!this.#available) return;

    try {
      await this.#transaction('readwrite', (store) => store.delete(key));
    } catch {
    }
  }

  // nuke everything in the store
  async clear() {
    if (!this.#available) return;

    try {
      await this.#transaction('readwrite', (store) => store.clear());
    } catch {
    }
  }

  /**
   * @param {'readonly'|'readwrite'} mode
   * @param {(store: IDBObjectStore) => IDBRequest} callback
   */
  #transaction(mode, callback) {
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      const request = callback(store);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

/** Singleton IndexedDB cache for the tag index service. */
export const indexCache = new IndexedDBCache();