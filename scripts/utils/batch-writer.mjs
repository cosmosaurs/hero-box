import { MODULE_ID, FLAGS } from '../constants/index.mjs';
import { logger } from './logger.mjs';

// batches multiple page flag writes into a single updateEmbeddedDocuments call
// so we don't hammer the server when editing 200 images at once
class BatchWriter {
  #queue = new Map();
  #flushTimer = null;
  #flushDelay = 500;
  #flushing = false;

  // add a write to the queue — will be flushed after a short delay
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

  // sets a timer to flush if one isn't already running
  #scheduleFlush() {
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.flush();
    }, this.#flushDelay);
  }

  // actually push all queued writes to the server, grouped by journal
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

  // cancel the timer and flush immediately — useful before closing a dialog
  async waitForFlush() {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    await this.flush();
  }
}

export const batchWriter = new BatchWriter();