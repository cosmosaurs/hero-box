/**
 * @fileoverview Coalesces many journal page flag updates into batched `updateEmbeddedDocuments` calls.
 */

import { MODULE_ID, FLAGS } from '../constants/index.mjs';
import { logger } from './logger.mjs';

class BatchWriter {
  #queue = new Map();
  #flushTimer = null;
  #flushDelay = 500;
  #flushing = false;

  /**
   * Queue a flag update for a journal page; flushed after debounce or `waitForFlush`.
   * @param {string} journalUuid
   * @param {string} pageId
   * @param {string} flagKey Module flag key (e.g. `IMAGE_DATA`).
   * @param {unknown} data
   */
  enqueue(journalUuid, pageId, flagKey, data) {
    if (!this.#queue.has(journalUuid)) {
      this.#queue.set(journalUuid, new Map());
    }
    const journalQueue = this.#queue.get(journalUuid);

    if (!journalQueue.has(pageId)) {
      journalQueue.set(pageId, {});
    }
    const pageData = journalQueue.get(pageId);
    pageData[`flags.${MODULE_ID}.${flagKey}`] = data;

    this.#scheduleFlush();
  }

  /** Start debounced flush timer if not already scheduled. */
  #scheduleFlush() {
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.flush();
    }, this.#flushDelay);
  }

  /** Flush queued updates to Foundry (recursive if queue refills while flushing). */
  async flush() {
    if (this.#flushing || this.#queue.size === 0) return;
    this.#flushing = true;

    const batch = new Map(this.#queue);
    this.#queue.clear();

    for (const [journalUuid, pages] of batch) {
      try {
        const journal = await fromUuid(journalUuid);
        if (!journal) {
          logger.warn(`BatchWriter: journal not found ${journalUuid}`);
          continue;
        }

        const updates = [];
        for (const [pageId, flagData] of pages) {
          updates.push({ _id: pageId, ...flagData });
        }

        if (updates.length > 0) {
          await journal.updateEmbeddedDocuments('JournalEntryPage', updates, { render: false });
          logger.debug(`BatchWriter: wrote ${updates.length} pages to ${journalUuid}`);
        }
      } catch (error) {
        logger.error(`BatchWriter: failed to write to ${journalUuid}:`, error);
      }
    }

    this.#flushing = false;

    if (this.#queue.size > 0) {
      await this.flush();
    }
  }

  // how many pages are waiting to be written
  get pending() {
    let count = 0;
    for (const pages of this.#queue.values()) {
      count += pages.size;
    }
    return count;
  }

  /** Clear debounce timer and await a full flush (e.g. before closing editor). */
  async waitForFlush() {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    await this.flush();
  }
}

/** Global queue for data-manager bulk writes. */
export const batchWriter = new BatchWriter();