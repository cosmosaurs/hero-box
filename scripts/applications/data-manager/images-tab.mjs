/**
 * @fileoverview Data Manager "Images" tab: grid, filters, worker offload, selection, previews.
 */

import { TAG_CATEGORY } from '../../constants/tags.mjs';
import { MODULE_ID, FLAGS } from '../../constants/index.mjs';
import { logger } from '../../utils/index.mjs';
import { buildSidebarCategories, handleTagToggle } from '../../utils/sidebar.mjs';
import { tagIndex, tag, source } from '../../services/index.mjs';
import { groupTagsByCategory, filterByTagGroups } from '../../utils/tags.mjs';
import { parseTagsFromFileName } from '../../utils/filepicker.mjs';
import { filterWorker } from '../../utils/filter-worker-bridge.mjs';
import { CollapsedGroupsManager } from '../../utils/collapsed-groups.mjs';
import { MODE } from '../import-image/image-import.mjs';
import { getSetting, setSetting } from '../../settings.mjs';
import { SETTINGS } from '../../constants/settings.mjs';

/** Tab logic for indexed images; `app` is the parent DataManager. */
export class ImagesTab {
  #app = null;
  #filters = { tags: [], search: '' };
  #collapsedGroups = new Set();

  #selectedImages = new Set();
  #lastSelectedUuid = null;
  #selectAllActive = false;
  #pendingScrollTop = null;

  #tagFilteredImages = null;
  #filteredImages = null;
  #tagFilterVersion = 0;
  #searchFilterVersion = 0;
  #lastTagVersion = 0;
  #lastSearchVersion = 0;
  #statsCache = null;

  #popupElement = null;
  #popupHideTimeout = null;
  #currentHoveredCard = null;
  #cardListenerCleanups = [];

  #virtualScroll = null;
  #resizeObserver = null;

  #workerInitialized = false;

  /** @param {import('./data-manager.mjs').DataManager} app */
  constructor(app) {
    this.#app = app;
  }

  /** @returns {string} */
  get searchQuery() { return this.#filters.search; }
  /** @returns {boolean} */
  get hasFilters() { return this.#filters.tags.length > 0 || this.#filters.search.length > 0; }

  /** @param {string} query */
  setSearchQuery(query) {
    const newQuery = query.toLowerCase();
    if (newQuery !== this.#filters.search) {
      this.#filters.search = newQuery;
      this.#searchFilterVersion++;
    }
  }

  /**
   * @param {{ race?: string[], gender?: string[], age?: string[], role?: string[], subrace?: Record<string, string[]> }} filters
   */
  applyInitialFilters(filters) {
    if (filters.race?.length) this.#filters.tags.push(...filters.race);
    if (filters.gender?.length) this.#filters.tags.push(...filters.gender);
    if (filters.age?.length) this.#filters.tags.push(...filters.age);
    if (filters.role?.length) this.#filters.tags.push(...filters.role);
    if (filters.subrace) {
      for (const subraces of Object.values(filters.subrace)) {
        if (Array.isArray(subraces)) this.#filters.tags.push(...subraces);
      }
    }
    this.#tagFilterVersion++;
    this.#searchFilterVersion++;
  }

  /** Clear filters, selection, and image caches. */
  reset() {
    this.#filters = { tags: [], search: '' };
    this.#clearSelection();
    this.#invalidateAll();
  }

  /** Clear selection only; keep filters. */
  resetSelection() {
    this.#clearSelection();
  }

  /** Bump filter versions so tag/search caches rebuild. */
  invalidateCache() {
    this.#invalidateAll();
  }

  /** @returns {Promise<object>} */
  async prepareContext() {
    await this.#ensureWorker();
    this.#ensureTagFiltered();
    await this.#ensureSearchFiltered();

    if (!this.#statsCache) {
      this.#statsCache = tagIndex.getStats();
    }

    const tagsByCategory = buildSidebarCategories({
      tagCounts: this.#statsCache.tagCounts,
      activeTags: this.#filters.tags,
    });

    const totalImages = this.#filteredImages.length;
    const effectiveSelectedCount = this.#selectAllActive
      ? totalImages
      : this.#selectedImages.size;

    return {
      totalImages,
      selectedCount: effectiveSelectedCount,
      hasSelection: effectiveSelectedCount > 0,
      allSelected: this.#selectAllActive,
      tagsByCategory,
    };
  }

  /** @returns {Promise<void>} */
  async #ensureWorker() {
    if (this.#workerInitialized) return;
    const totalImages = tagIndex.getStats().totalImages;
    await filterWorker.initialize(totalImages);
    this.#workerInitialized = true;
  }

  /** Recompute `#tagFilteredImages` when tag filters changed. */
  #ensureTagFiltered() {
    if (this.#lastTagVersion === this.#tagFilterVersion && this.#tagFilteredImages) return;

    if (this.#filters.tags.length > 0) {
      const tagGroups = groupTagsByCategory(this.#filters.tags, tag);
      this.#tagFilteredImages = filterByTagGroups(
        tagIndex.getAllImagesArray(),
        tagGroups,
        (img) => img.tags
      );
    } else {
      this.#tagFilteredImages = tagIndex.getAllImagesArray();
    }

    this.#lastTagVersion = this.#tagFilterVersion;
    this.#lastSearchVersion = -1;
  }

  /** @returns {Promise<void>} */
  async #ensureSearchFiltered() {
    if (this.#lastSearchVersion === this.#searchFilterVersion && this.#filteredImages) return;

    if (this.#filters.search) {
      const query = this.#filters.search;

      if (filterWorker.shouldUseWorker) {
        try {
          const result = await filterWorker.filter(this.#tagFilteredImages, null, query);
          if (result) {
            this.#filteredImages = result;
            this.#lastSearchVersion = this.#searchFilterVersion;
            return;
          }
        } catch {
        }
      }

      this.#filteredImages = this.#tagFilteredImages.filter(
        img => img.searchString.includes(query)
      );
    } else {
      this.#filteredImages = this.#tagFilteredImages;
    }

    this.#lastSearchVersion = this.#searchFilterVersion;
  }

  /** Invalidate tag/search caches and sidebar stats. */
  #invalidateAll() {
    this.#tagFilterVersion++;
    this.#searchFilterVersion++;
    this.#tagFilteredImages = null;
    this.#filteredImages = null;
    this.#statsCache = null;
  }

  /** Mount virtual grid, restore scroll, bind hover UI. */
  onRender() {
    this.#setupVirtualScroll();
    this.#restoreScrollPosition();
    this.#bindCardInteractions();
    this.#restoreCollapsedGroups();
  }

  /** Create `VirtualScrollGrid` and `ResizeObserver` for the image grid. */
  #setupVirtualScroll() {
    const container = this.#app.querySelector('.cs-hero-box-data-manager__grid-container');
    if (!container) return;

    if (this.#virtualScroll) {
      this.#virtualScroll.destroy();
    }

    this.#ensureTagFiltered();

    this.#virtualScroll = new VirtualScrollGrid({
      container,
      items: this.#filteredImages ?? this.#tagFilteredImages ?? [],
      bufferRows: 3,
      renderCard: (img) => this.#createCardElement(img),
      getItemId: (img) => img.uuid,
    });

    this.#virtualScroll.mount();

    if (this.#resizeObserver) {
      this.#resizeObserver.disconnect();
    }

    this.#resizeObserver = new ResizeObserver(() => {
      this.#virtualScroll?.handleResize();
    });

    this.#resizeObserver.observe(container);
  }

  /** @param {object} img @returns {HTMLDivElement} */
  #createCardElement(img) {
    const isSelected = this.#selectAllActive || this.#selectedImages.has(img.uuid);
    const isLastSelected = img.uuid === this.#lastSelectedUuid;
    const previewUrl = img.portraitUrl || img.tokenUrl;

    const card = document.createElement('div');
    card.className = 'cs-hero-box-data-manager__card';
    if (isSelected) card.classList.add('selected');
    if (isLastSelected) card.classList.add('last-selected');
    card.dataset.uuid = img.uuid;
    card.dataset.action = 'selectImage';

    card.innerHTML = `<div class="cs-hero-box-data-manager__image-container"><img src="${previewUrl}" alt="${img.fileName}" loading="lazy" /></div><div class="cs-hero-box-data-manager__card-info"><span class="cs-hero-box-data-manager__card-name" title="${img.fileName}">${img.fileName}</span></div>`;

    return card;
  }

  /** @returns {Promise<void>} */
  async onAddImage() {
    if (!this.#app.selectedJournalId) return;
    const { ImageImport } = await import('../import-image/image-import.mjs');
    const success = await ImageImport.open(this.#app.selectedJournalId, MODE.SINGLE);
    if (success) this.#refreshAfterChange();
  }

  async onImportFromFolder() {
    if (!this.#app.selectedJournalId) return;
    const { ImageImport } = await import('../import-image/image-import.mjs');
    const success = await ImageImport.open(this.#app.selectedJournalId, MODE.FOLDER);
    if (success) this.#refreshAfterChange();
  }

  /** Card click: single, ctrl, or shift range selection. */
  onSelectImage(event, target) {
    const card = target.closest('[data-uuid]');
    if (!card) return;

    const uuid = card.dataset.uuid;
    const isCtrl = event.ctrlKey || event.metaKey;
    const isShift = event.shiftKey;

    if (this.#selectAllActive) {
      this.#materializeSelectAll();
    }

    if (isShift && this.#lastSelectedUuid) {
      const allIds = this.#getFilteredUuids();
      const lastIdx = allIds.indexOf(this.#lastSelectedUuid);
      const currIdx = allIds.indexOf(uuid);

      if (lastIdx !== -1 && currIdx !== -1) {
        const start = Math.min(lastIdx, currIdx);
        const end = Math.max(lastIdx, currIdx);
        for (let i = start; i <= end; i++) {
          this.#selectedImages.add(allIds[i]);
        }
      }
    } else if (isCtrl) {
      if (this.#selectedImages.has(uuid)) {
        this.#selectedImages.delete(uuid);
        this.#lastSelectedUuid = this.#selectedImages.size > 0 ? [...this.#selectedImages].pop() : null;
      } else {
        this.#selectedImages.add(uuid);
        this.#lastSelectedUuid = uuid;
      }
    } else {
      this.#selectedImages.clear();
      this.#selectedImages.add(uuid);
      this.#lastSelectedUuid = uuid;
    }

    this.#updateSelectionUI();
  }

  /** @returns {string[]} */
  #getFilteredUuids() {
    return (this.#filteredImages ?? []).map(img => img.uuid);
  }

  /** Replace logical "select all" with concrete uuid set. */
  #materializeSelectAll() {
    if (!this.#selectAllActive) return;
    this.#selectAllActive = false;
    for (const uuid of this.#getFilteredUuids()) {
      this.#selectedImages.add(uuid);
    }
  }

  async onEditSelected() {
    const uuids = this.#getEffectiveSelection();
    if (uuids.length === 0) return;

    const pages = [];
    for (const uuid of uuids) {
      try {
        const page = await fromUuid(uuid);
        if (page) pages.push(page);
      } catch (error) {
        logger.warn(`Failed to load page ${uuid}:`, error);
      }
    }

    if (pages.length === 0) {
      this.#clearSelection();
      this.#app.render();
      return;
    }

    const { Editor } = await import('../editor/editor.mjs');
    const saved = await Editor.openImage(pages);
    if (saved) {
      this.#saveScrollPosition();
      this.#clearSelection();
      this.#refreshAfterEditInPlace();
    }
  }

  /** Refresh indexed rows and virtual list after inline flag edits. */
  #refreshAfterEditInPlace() {
    this.#statsCache = null;

    if (this.#tagFilteredImages) {
      for (let i = 0; i < this.#tagFilteredImages.length; i++) {
        const uuid = this.#tagFilteredImages[i].uuid;
        const fresh = tagIndex.getByUuid(uuid);
        if (fresh) {
          this.#tagFilteredImages[i] = fresh;
        }
      }
    }

    this.#lastSearchVersion = -1;

    if (this.#virtualScroll) {
      this.#virtualScroll.updateItems(this.#filteredImages ?? this.#tagFilteredImages ?? []);
    }

    this.#restoreScrollPosition();
    this.#updateSidebarCounts();
  }

  /** @returns {Promise<void>} */
  async onRefreshTagsFromNames() {
    const uuids = this.#getEffectiveSelection();
    if (uuids.length === 0) return;

    const knownTagIds = tag.getAll().map(t => t.id);
    const updates = [];
    const pagesByJournal = new Map();
    const total = uuids.length;
    let processed = 0;

    const toolbar = this.#app.querySelector('.cs-hero-box-data-manager__toolbar');
    let progressEl = null;

    if (toolbar) {
      progressEl = document.createElement('div');
      progressEl.className = 'cs-hero-box-data-manager__delete-progress';
      progressEl.innerHTML = `
        <div class="cs-hero-box-data-manager__progress-track">
          <div class="cs-hero-box-data-manager__progress-bar" style="width: 0%"></div>
        </div>
        <span class="cs-hero-box-data-manager__progress-text">0 / ${total}</span>
      `;

      const toolbarInfo = toolbar.querySelector('.cs-hero-box-data-manager__toolbar-info');
      if (toolbarInfo) {
        toolbarInfo.style.display = 'none';
      }
      const toolbarActions = toolbar.querySelector('.cs-hero-box-data-manager__toolbar-actions');
      if (toolbarActions) {
        toolbarActions.style.display = 'none';
      }
      toolbar.prepend(progressEl);
    }

    const updateProgress = () => {
      if (!progressEl) return;
      const pct = Math.round((processed / total) * 100);
      const bar = progressEl.querySelector('.cs-hero-box-data-manager__progress-bar');
      const text = progressEl.querySelector('.cs-hero-box-data-manager__progress-text');
      if (bar) bar.style.width = `${pct}%`;
      if (text) text.textContent = `${processed} / ${total}`;
    };

    const BATCH_SIZE = 50;

    for (let batchStart = 0; batchStart < uuids.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, uuids.length);
      const batch = uuids.slice(batchStart, batchEnd);

      for (const uuid of batch) {
        try {
          const page = await fromUuid(uuid);
          if (!page) {
            processed++;
            continue;
          }

          const imageData = page.getFlag(MODULE_ID, FLAGS.IMAGE_DATA) ?? {};
          const currentTags = new Set(imageData.tags ?? []);

          const fileName = (imageData.portraitUrl || imageData.tokenUrl || page.name || '').split('/').pop();
          const parsedTags = parseTagsFromFileName(fileName, knownTagIds);

          let hasChanges = false;
          for (const tagId of parsedTags) {
            if (!currentTags.has(tagId)) {
              currentTags.add(tagId);
              hasChanges = true;
            }
          }

          if (hasChanges) {
            const newTags = Array.from(currentTags);
            const newImageData = { ...imageData, tags: newTags };

            const journalUuid = page.parent.uuid;
            if (!pagesByJournal.has(journalUuid)) {
              pagesByJournal.set(journalUuid, []);
            }
            pagesByJournal.get(journalUuid).push({ page, newImageData });
            updates.push({ uuid, imageData: newImageData });
          }
        } catch (error) {
          logger.warn(`Failed to process ${uuid}:`, error);
        }

        processed++;
      }

      updateProgress();

      if (batchEnd < uuids.length) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    if (updates.length > 0) {
      for (const [journalUuid, journalPages] of pagesByJournal) {
        try {
          const journal = await fromUuid(journalUuid);
          if (!journal) continue;

          const journalUpdates = journalPages.map(({ page, newImageData }) => ({
            _id: page.id,
            [`flags.${MODULE_ID}.${FLAGS.IMAGE_DATA}`]: newImageData,
          }));

          await journal.updateEmbeddedDocuments('JournalEntryPage', journalUpdates);
        } catch (error) {
          logger.warn(`Failed to update journal ${journalUuid}:`, error);
        }
      }

      tagIndex.updateImages(updates);
    }

    if (progressEl) {
      progressEl.remove();
      const toolbarInfo = toolbar?.querySelector('.cs-hero-box-data-manager__toolbar-info');
      const toolbarActions = toolbar?.querySelector('.cs-hero-box-data-manager__toolbar-actions');
      if (toolbarInfo) toolbarInfo.style.display = '';
      if (toolbarActions) toolbarActions.style.display = '';
    }

    this.#saveScrollPosition();
    this.#refreshAfterEditInPlace();
  }

  /** @returns {string[]} */
  #getEffectiveSelection() {
    if (this.#selectAllActive) {
      return this.#getFilteredUuids();
    }
    return Array.from(this.#selectedImages);
  }

  #clearSelection() {
    this.#selectedImages.clear();
    this.#lastSelectedUuid = null;
    this.#selectAllActive = false;
  }

  /** @returns {Promise<void>} */
  async onDeleteSelected() {
    const uuids = this.#getEffectiveSelection();
    if (uuids.length === 0) return;

    const count = uuids.length;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize('cs-hero-box.dataManager.deleteConfirm.title') },
      content: `<p>${game.i18n.format('cs-hero-box.dataManager.deleteConfirm.content', { name: `${count} images` })}</p>`,
      yes: { default: true },
      no: { default: false },
    });

    if (!confirmed) return;

    this.#saveScrollPosition();
    this.#clearSelection();
    tagIndex.removeImages(uuids);
    this.invalidateCache();
    this.#app.render();

    const pagesByJournal = this.#groupUuidsByJournal(uuids);
    this.#executeBackgroundDeletion(pagesByJournal);
  }

  /** @param {string[]} uuids @returns {Map<string, string[]>} */
  #groupUuidsByJournal(uuids) {
    const pagesByJournal = new Map();
    for (const uuid of uuids) {
      let journalUuid, pageId;
      if (uuid.includes('.JournalEntryPage.')) {
        const parts = uuid.split('.JournalEntryPage.');
        journalUuid = parts[0];
        pageId = parts[1];
      } else {
        const parts = uuid.split('.');
        journalUuid = parts.slice(0, -1).join('.');
        pageId = parts[parts.length - 1];
      }
      if (!pagesByJournal.has(journalUuid)) pagesByJournal.set(journalUuid, []);
      pagesByJournal.get(journalUuid).push(pageId);
    }
    return pagesByJournal;
  }

  /** @param {Map<string, string[]>} pagesByJournal @returns {Promise<void>} */
  async #executeBackgroundDeletion(pagesByJournal) {
    await Promise.allSettled(
      Array.from(pagesByJournal.entries()).map(([journalUuid, pageIds]) =>
        this.#deleteFromJournal(journalUuid, pageIds)
      )
    );
  }

  /**
   * @param {string} journalUuid
   * @param {string[]} pageIds
   * @returns {Promise<void>}
   */
  async #deleteFromJournal(journalUuid, pageIds) {
    try {
      const journal = await fromUuid(journalUuid);
      if (!journal) return;
      const totalPages = journal.pages.size;
      const deleteCount = pageIds.length;
      const deleteRatio = deleteCount / totalPages;

      if (deleteCount === totalPages) {
        await journal.deleteEmbeddedDocuments('JournalEntryPage', journal.pages.map(p => p.id), { render: false, noHook: true });
      } else if (deleteRatio >= 0.7) {
        const deleteSet = new Set(pageIds);
        const remaining = [];
        for (const page of journal.pages) {
          if (!deleteSet.has(page.id)) remaining.push(page.toObject());
        }
        try {
          await journal.update({ pages: remaining }, { recursive: false, diff: false, render: false, noHook: true });
        } catch {
          await journal.deleteEmbeddedDocuments('JournalEntryPage', pageIds, { render: false, noHook: true });
        }
      } else {
        try {
          await journal.deleteEmbeddedDocuments('JournalEntryPage', pageIds, { render: false, noHook: true });
        } catch {
          const CHUNK = 100;
          for (let i = 0; i < pageIds.length; i += CHUNK) {
            try {
              await journal.deleteEmbeddedDocuments('JournalEntryPage', pageIds.slice(i, i + CHUNK), { render: false, noHook: true });
            } catch (err) {
              logger.error('Chunk delete failed:', err);
            }
          }
        }
      }
    } catch (error) {
      logger.error(`Error deleting from ${journalUuid}:`, error);
    }
  }

  onSelectAll() {
    if (this.#selectAllActive) {
      this.#selectAllActive = false;
      this.#selectedImages.clear();
      this.#lastSelectedUuid = null;
    } else {
      this.#selectAllActive = true;
      this.#selectedImages.clear();
      const uuids = this.#getFilteredUuids();
      if (uuids.length > 0) {
        this.#lastSelectedUuid = uuids[uuids.length - 1];
      }
    }
    this.#updateSelectionUI();
  }

  /** Full-size `ImagePopout` for card preview URL. */
  onOpenImage(event, target) {
    event.stopPropagation();
    new ImagePopout(target.dataset.url).render(true);
  }

  /** Sidebar tag filter; clears selection and invalidates caches. */
  onToggleTag(event, target) {
    const tagId = target.dataset.tag;
    handleTagToggle(this.#filters, tagId, tag);
    this.#tagFilterVersion++;
    this.#searchFilterVersion++;
    this.#tagFilteredImages = null;
    this.#filteredImages = null;
    this.#statsCache = null;
    this.#clearSelection();
    this.#app.render();
  }

  /** Collapse/expand sidebar category group. */
  onToggleTagGroup(event, target) {
    const group = target.closest('.cs-hero-box-data-manager__tag-group');
    if (group) {
      const category = group.dataset.category;
      group.classList.toggle('collapsed');
      if (group.classList.contains('collapsed')) {
        this.#collapsedGroups.add(category);
      } else {
        this.#collapsedGroups.delete(category);
      }
      this.#saveCollapsedState();
    }
  }

  /** @returns {string[]} */
  getSelectedUuids() {
    return this.#getEffectiveSelection();
  }

  /** @returns {Promise<void>} */
  async onCreateActorFromSelected() {
    const selectedUuids = this.#getEffectiveSelection();
    if (selectedUuids.length === 0) return;

    const selectedImages = [];
    const images = this.#filteredImages ?? [];
    for (const uuid of selectedUuids) {
      const img = images.find(i => i.uuid === uuid);
      if (img) {
        selectedImages.push({
          uuid,
          url: img.portraitUrl || img.tokenUrl,
          name: img.fileName,
        });
      }
    }

    const { ActorConfig } = await import('../actor-config/actor-config.mjs');
    const { actor } = await import('../../services/actor.mjs');

    const result = await ActorConfig.open(null, {
      initialSelectionMode: 'image',
      initialImages: selectedImages,
    });

    if (result?.submitted) {
      await actor.createOrUpdate(result.data, null, null);
    }
  }

  /** Patch sidebar counts and total label without full re-render. */
  #updateSidebarCounts() {
    this.#statsCache = tagIndex.getStats();
    const sidebar = this.#app.querySelector('.cs-hero-box-data-manager__tag-list');
    if (!sidebar) return;

    const tagButtons = sidebar.querySelectorAll('.cs-hero-box-data-manager__tag[data-tag]');
    for (const btn of tagButtons) {
      const tagId = btn.dataset.tag;
      const countEl = btn.querySelector('.cs-hero-box-data-manager__tag-count');
      if (countEl) {
        const newCount = this.#statsCache.tagCounts.get(tagId) ?? 0;
        if (countEl.textContent !== String(newCount)) {
          countEl.textContent = newCount;
        }
      }
    }

    const totalEl = this.#app.querySelector('.cs-hero-box-data-manager__total-count');
    if (totalEl) {
      const totalImages = this.#filteredImages?.length ?? 0;
      totalEl.textContent = `${totalImages} ${game.i18n.localize('cs-hero-box.dataManager.images')}`;
    }
  }

  /** Delegated hover handlers for card detail popup (non-picker). */
  #bindCardInteractions() {
    if (this.#app.pickerMode) return;
    const container = this.#app.querySelector('.cs-hero-box-data-manager__grid-container');
    if (!container) return;

    const onEnter = (e) => {
      const card = e.target.closest('.cs-hero-box-data-manager__card');
      if (card) this.#handleCardEnter(card);
    };
    const onLeave = (e) => {
      const card = e.target.closest('.cs-hero-box-data-manager__card');
      if (card) this.#handleCardLeave(card, e);
    };
    const onScroll = () => this.#hidePopup();

    container.addEventListener('mouseenter', onEnter, true);
    container.addEventListener('mouseleave', onLeave, true);
    container.addEventListener('scroll', onScroll, { passive: true });

    this.#cardListenerCleanups.push(
      () => container.removeEventListener('mouseenter', onEnter, true),
      () => container.removeEventListener('mouseleave', onLeave, true),
      () => container.removeEventListener('scroll', onScroll),
    );
  }

  /** @param {HTMLElement} card */
  #handleCardEnter(card) {
    if (this.#popupHideTimeout) {
      clearTimeout(this.#popupHideTimeout);
      this.#popupHideTimeout = null;
    }
    this.#currentHoveredCard = card;
    this.#showPopup(card);
  }

  /** @param {HTMLElement} card @param {MouseEvent} event */
  #handleCardLeave(card, event) {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget?.closest('.cs-hero-box-data-manager__card') === card) return;
    if (relatedTarget?.closest('.cs-hero-box-card-popup')) return;
    this.#scheduleHidePopup();
  }

  #scheduleHidePopup() {
    if (this.#popupHideTimeout) clearTimeout(this.#popupHideTimeout);
    this.#popupHideTimeout = setTimeout(() => {
      this.#hidePopup();
      this.#popupHideTimeout = null;
      this.#currentHoveredCard = null;
    }, 100);
  }

  /** @param {HTMLElement} card */
  #showPopup(card) {
    const uuid = card.dataset.uuid;
    const img = tagIndex.getByUuid(uuid);
    if (!img) return;

    if (!this.#popupElement) {
      this.#popupElement = document.createElement('div');
      this.#popupElement.className = 'cs-hero-box-card-popup';
      document.body.appendChild(this.#popupElement);
      this.#popupElement.addEventListener('mouseenter', () => {
        if (this.#popupHideTimeout) {
          clearTimeout(this.#popupHideTimeout);
          this.#popupHideTimeout = null;
        }
      });
      this.#popupElement.addEventListener('mouseleave', () => this.#scheduleHidePopup());
    }

    const tagsDisplay = img.tags.length > 0
      ? img.tags.map(t => tag.getLabel(t)).join(', ') : '';
    const tagsHtml = tagsDisplay
      ? `<strong>${game.i18n.localize('cs-hero-box.dataManager.tagsTitle')}:</strong> ${tagsDisplay}`
      : `<em>${game.i18n.localize('cs-hero-box.editor.noTags')}</em>`;
    const sourceName = source.getSourceName(img.sourceId);
    const sourceHtml = sourceName
      ? `<div class="cs-hero-box-card-popup__source"><i class="fas fa-database"></i> ${sourceName}</div>` : '';
    const tokenLabel = game.i18n.localize('cs-hero-box.editor.tokenPreview');
    const portraitLabel = game.i18n.localize('cs-hero-box.editor.portraitPreview');

    this.#popupElement.innerHTML = `<div class="cs-hero-box-card-popup__images"><div class="cs-hero-box-card-popup__image">${img.tokenUrl ? `<img src="${img.tokenUrl}" alt="Token" />` : `<div class="cs-hero-box-card-popup__placeholder"><i class="fas fa-user-circle"></i></div>`}<span>${tokenLabel}</span></div><div class="cs-hero-box-card-popup__image">${img.portraitUrl ? `<img src="${img.portraitUrl}" alt="Portrait" />` : `<div class="cs-hero-box-card-popup__placeholder"><i class="fas fa-portrait"></i></div>`}<span>${portraitLabel}</span></div></div><div class="cs-hero-box-card-popup__tags">${tagsHtml}</div>${sourceHtml}`;

    const cardRect = card.getBoundingClientRect();
    const popupWidth = 280;
    const popupHeight = this.#popupElement.offsetHeight || 200;
    let left = cardRect.right + 10;
    let top = cardRect.top;
    if (left + popupWidth > window.innerWidth) left = cardRect.left - popupWidth - 10;
    if (top + popupHeight > window.innerHeight) top = window.innerHeight - popupHeight - 10;
    if (top < 0) top = 10;

    this.#popupElement.style.left = `${left}px`;
    this.#popupElement.style.top = `${top}px`;
    this.#popupElement.style.opacity = '1';
    this.#popupElement.style.visibility = 'visible';
  }

  /** Hide hover popup via CSS. */
  #hidePopup() {
    if (this.#popupElement) {
      this.#popupElement.style.opacity = '0';
      this.#popupElement.style.visibility = 'hidden';
    }
    this.#currentHoveredCard = null;
  }

  /** After import/add: save scroll, clear caches, re-render manager. */
  #refreshAfterChange() {
    this.#saveScrollPosition();
    this.#clearSelection();
    this.#invalidateAll();
    this.#app.render();
  }

  /** Store grid `scrollTop` for post-render restore. */
  #saveScrollPosition() {
    const container = this.#app.querySelector('.cs-hero-box-data-manager__grid-container');
    if (container) {
      this.#pendingScrollTop = container.scrollTop;
    }
  }

  #restoreScrollPosition() {
    if (this.#pendingScrollTop == null) return;
    const container = this.#app.querySelector('.cs-hero-box-data-manager__grid-container');
    if (container) {
      container.scrollTop = this.#pendingScrollTop;
    }
    this.#pendingScrollTop = null;
  }

  /** Update visible card selected classes and toolbar. */
  #updateSelectionUI() {
    if (!this.#virtualScroll) return;

    this.#virtualScroll.updateVisibleCards((card) => {
      const uuid = card.dataset.uuid;
      const isSelected = this.#selectAllActive || this.#selectedImages.has(uuid);
      card.classList.toggle('selected', isSelected);
      card.classList.toggle('last-selected', uuid === this.#lastSelectedUuid);
    });

    this.#updateToolbarState();
  }

  /** Selection count and action button disabled state. */
  #updateToolbarState() {
    const toolbar = this.#app.querySelector('.cs-hero-box-data-manager__toolbar');
    if (!toolbar) return;

    const effectiveCount = this.#selectAllActive
      ? (this.#filteredImages?.length ?? 0)
      : this.#selectedImages.size;
    const hasSelection = effectiveCount > 0;

    toolbar.classList.toggle('has-selection', hasSelection);

    const countEl = toolbar.querySelector('.cs-hero-box-data-manager__selection-count');
    if (countEl) {
      countEl.textContent = `${effectiveCount} ${game.i18n.localize('cs-hero-box.dataManager.selected')}`;
      countEl.style.display = hasSelection ? '' : 'none';
    }

    toolbar.querySelectorAll('button[data-action="editSelected"], button[data-action="deleteSelected"], button[data-action="confirmSelection"], button[data-action="createActorFromSelected"], button[data-action="refreshTagsFromNames"]')
      .forEach(btn => btn.disabled = !hasSelection);
  }

  #restoreCollapsedGroups() {
    try {
      const saved = getSetting(SETTINGS.COLLAPSED_DATA_MANAGER);
      const tabCollapsed = saved?.images ?? [];
      this.#collapsedGroups = new Set(tabCollapsed);
    } catch {}

    for (const category of this.#collapsedGroups) {
      const group = this.#app.querySelector(`.cs-hero-box-data-manager__tag-group[data-category="${category}"]`);
      if (group) {
        group.classList.add('no-transition', 'collapsed');
        requestAnimationFrame(() => {
          requestAnimationFrame(() => group.classList.remove('no-transition'));
        });
      }
    }
  }

  /** Remove listeners, virtual scroll, popup, and filter worker. */
  destroy() {
    for (const cleanup of this.#cardListenerCleanups) cleanup();
    this.#cardListenerCleanups = [];

    if (this.#virtualScroll) {
      this.#virtualScroll.destroy();
      this.#virtualScroll = null;
    }
    if (this.#resizeObserver) {
      this.#resizeObserver.disconnect();
      this.#resizeObserver = null;
    }
    if (this.#popupHideTimeout) {
      clearTimeout(this.#popupHideTimeout);
      this.#popupHideTimeout = null;
    }
    if (this.#popupElement) {
      this.#popupElement.remove();
      this.#popupElement = null;
    }
    this.#currentHoveredCard = null;

    try {
      filterWorker.destroy();
    } catch {}
    this.#workerInitialized = false;
  }

  #saveCollapsedState() {
    try {
      const saved = getSetting(SETTINGS.COLLAPSED_DATA_MANAGER) ?? {};
      saved.images = Array.from(this.#collapsedGroups);
      setSetting(SETTINGS.COLLAPSED_DATA_MANAGER, saved);
    } catch {}
  }
}


/**
 * Virtualized grid: renders only viewport-visible cards plus a row buffer.
 */
class VirtualScrollGrid {
  #container = null;
  #content = null;
  #items = [];
  #cardsPerRow = 1;
  #bufferRows = 3;
  #renderCard = null;
  #getItemId = null;

  #cardWidth = 0;
  #cardHeight = 0;
  #gap = 6;
  #measured = false;

  #renderedCards = new Map();
  #renderedIndices = new Set();
  #scrollRAF = null;
  #mounted = false;

  /**
   * @param {{ container: HTMLElement, items: object[], bufferRows?: number, renderCard: function(object): HTMLElement, getItemId: function(object): string }} opts
   */
  constructor({ container, items, bufferRows, renderCard, getItemId }) {
    this.#container = container;
    this.#items = items;
    this.#bufferRows = bufferRows ?? 3;
    this.#renderCard = renderCard;
    this.#getItemId = getItemId;
  }

  /** @returns {HTMLDivElement|null} */
  get contentElement() { return this.#content; }

  /** Append content layer, bind scroll, measure, initial visible slice. */
  mount() {
    this.#content = document.createElement('div');
    this.#content.className = 'cs-hero-box-vs__content cs-hero-box-data-manager__grid';
    this.#content.style.position = 'relative';
    this.#container.appendChild(this.#content);

    this.#container.addEventListener('scroll', this.#onScrollBound, { passive: true });
    this.#mounted = true;

    this.#measure();
    this.#updateContentHeight();
    this.#renderVisible();
  }

  #onScrollBound = () => {
    if (this.#scrollRAF) return;
    this.#scrollRAF = requestAnimationFrame(() => {
      this.#scrollRAF = null;
      this.#renderVisible();
    });
  };

  /** Probe-render one card to read dimensions and cards-per-row. */
  #measure() {
    if (this.#items.length === 0) {
      this.#measured = true;
      return;
    }

    const probe = this.#renderCard(this.#items[0]);
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    this.#content.appendChild(probe);

    const rect = probe.getBoundingClientRect();
    this.#cardWidth = rect.width;
    this.#cardHeight = rect.height;

    probe.remove();

    this.#calculateCardsPerRow();
    this.#measured = true;
  }

  /** Derive column count from container inner width and card width. */
  #calculateCardsPerRow() {
    const containerStyle = getComputedStyle(this.#container);
    const paddingLeft = parseFloat(containerStyle.paddingLeft) || 0;
    const paddingRight = parseFloat(containerStyle.paddingRight) || 0;
    const availableWidth = this.#container.clientWidth - paddingLeft - paddingRight;

    if (this.#cardWidth > 0) {
      this.#cardsPerRow = Math.max(1, Math.floor((availableWidth + this.#gap) / (this.#cardWidth + this.#gap)));
    }
  }

  /** Set scrollable content height from row count. */
  #updateContentHeight() {
    const totalRows = Math.ceil(this.#items.length / this.#cardsPerRow);
    const totalHeight = totalRows > 0
      ? totalRows * this.#cardHeight + (totalRows - 1) * this.#gap
      : 0;
    this.#content.style.height = `${totalHeight}px`;
  }

  /** @param {number} index @returns {{ x: number, y: number }} */
  #getCardPosition(index) {
    const row = Math.floor(index / this.#cardsPerRow);
    const col = index % this.#cardsPerRow;
    return {
      x: col * (this.#cardWidth + this.#gap),
      y: row * (this.#cardHeight + this.#gap),
    };
  }

  /** Mount/unmount card DOM for indices in viewport ± buffer rows. */
  #renderVisible() {
    if (!this.#mounted || !this.#measured || this.#items.length === 0) return;

    const scrollTop = this.#container.scrollTop;
    const viewportHeight = this.#container.clientHeight;
    const rowHeight = this.#cardHeight + this.#gap;

    const firstVisibleRow = Math.floor(scrollTop / rowHeight);
    const visibleRows = Math.ceil(viewportHeight / rowHeight) + 1;

    const startRow = Math.max(0, firstVisibleRow - this.#bufferRows);
    const totalRows = Math.ceil(this.#items.length / this.#cardsPerRow);
    const endRow = Math.min(totalRows, firstVisibleRow + visibleRows + this.#bufferRows);

    const startIndex = startRow * this.#cardsPerRow;
    const endIndex = Math.min(endRow * this.#cardsPerRow, this.#items.length);

    const neededIndices = new Set();
    for (let i = startIndex; i < endIndex; i++) neededIndices.add(i);

    for (const idx of this.#renderedIndices) {
      if (!neededIndices.has(idx)) {
        const item = this.#items[idx];
        if (item) {
          const id = this.#getItemId(item);
          const card = this.#renderedCards.get(id);
          if (card) {
            card.remove();
            this.#renderedCards.delete(id);
          }
        }
        this.#renderedIndices.delete(idx);
      }
    }

    for (let i = startIndex; i < endIndex; i++) {
      if (this.#renderedIndices.has(i)) continue;

      const item = this.#items[i];
      if (!item) continue;

      const id = this.#getItemId(item);
      const card = this.#renderCard(item);
      const pos = this.#getCardPosition(i);

      card.style.position = 'absolute';
      card.style.left = `${pos.x}px`;
      card.style.top = `${pos.y}px`;
      card.style.width = `${this.#cardWidth}px`;

      this.#content.appendChild(card);
      this.#renderedCards.set(id, card);
      this.#renderedIndices.add(i);
    }
  }

  /** Recompute columns and reposition when grid width changes. */
  handleResize() {
    if (!this.#mounted || this.#items.length === 0) return;

    const prevPerRow = this.#cardsPerRow;
    this.#calculateCardsPerRow();

    if (prevPerRow !== this.#cardsPerRow) {
      this.#updateContentHeight();
      this.#repositionAll();
    }
  }

  /** After column count change, move rendered cards and refresh indices. */
  #repositionAll() {
    const indexById = new Map();
    for (let i = 0; i < this.#items.length; i++) {
      indexById.set(this.#getItemId(this.#items[i]), i);
    }

    for (const [id, card] of this.#renderedCards) {
      const idx = indexById.get(id);
      if (idx === undefined) continue;
      const pos = this.#getCardPosition(idx);
      card.style.left = `${pos.x}px`;
      card.style.top = `${pos.y}px`;
    }

    this.#renderedIndices.clear();
    for (const [id] of this.#renderedCards) {
      const idx = indexById.get(id);
      if (idx !== undefined) this.#renderedIndices.add(idx);
    }

    this.#renderVisible();
  }

  /** @param {object[]} newItems */
  updateItems(newItems) {
    const scrollTop = this.#container.scrollTop;
    this.#items = newItems;
    this.#updateContentHeight();
    this.#clearAll();
    this.#container.scrollTop = scrollTop;
    this.#renderVisible();
  }

  /** @param {(card: HTMLElement) => void} callback */
  updateVisibleCards(callback) {
    for (const card of this.#renderedCards.values()) {
      callback(card);
    }
  }

  /** Remove every rendered card from the content layer. */
  #clearAll() {
    for (const card of this.#renderedCards.values()) card.remove();
    this.#renderedCards.clear();
    this.#renderedIndices.clear();
  }

  /** Cancel RAF, detach scroll listener, clear cards. */
  destroy() {
    if (this.#scrollRAF) {
      cancelAnimationFrame(this.#scrollRAF);
      this.#scrollRAF = null;
    }
    this.#container?.removeEventListener('scroll', this.#onScrollBound);
    this.#clearAll();
    this.#mounted = false;
  }
}