import { TAG_CATEGORY } from '../../constants/tags.mjs';
import { MODULE_ID, FLAGS } from '../../constants/index.mjs';
import { logger } from '../../utils/index.mjs';
import { buildSidebarCategories, handleTagToggle } from '../../utils/sidebar.mjs';
import { tagIndex, tag, source } from '../../services/index.mjs';
import { groupTagsByCategory, filterByTagGroups } from '../../utils/tags.mjs';
import { parseTagsFromFileName } from '../../utils/filepicker.mjs';
import { filterWorker } from '../../utils/filter-worker-bridge.mjs';
import { CollapsedGroupsManager } from '../../utils/collapsed-groups.mjs';

// handles everything on the images tab — filtering, selection, virtual scroll, popups
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

  constructor(app) {
    this.#app = app;
  }

  get searchQuery() { return this.#filters.search; }
  get hasFilters() { return this.#filters.tags.length > 0 || this.#filters.search.length > 0; }

  // updates the search text and bumps the version so we know to re-filter
  setSearchQuery(query) {
    const newQuery = query.toLowerCase();
    if (newQuery !== this.#filters.search) {
      this.#filters.search = newQuery;
      this.#searchFilterVersion++;
    }
  }

  // takes initial filter config (from picker mode) and shoves all tags into our filter list
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

  // nukes all filters and selection — fresh start
  reset() {
    this.#filters = { tags: [], search: '' };
    this.#clearSelection();
    this.#invalidateAll();
  }

  // just clears image selection without touching filters
  resetSelection() {
    this.#clearSelection();
  }

  // forces a full cache rebuild on next render
  invalidateCache() {
    this.#invalidateAll();
  }

  // builds the context object for rendering the images tab
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

  // spins up the web worker if we haven't yet
  async #ensureWorker() {
    if (this.#workerInitialized) return;
    const totalImages = tagIndex.getStats().totalImages;
    await filterWorker.initialize(totalImages);
    this.#workerInitialized = true;
  }

  // applies tag filters if they changed since last time
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

  // applies search filter on top of tag-filtered results, tries worker first
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

  // blows up all caches — the nuclear option
  #invalidateAll() {
    this.#tagFilterVersion++;
    this.#searchFilterVersion++;
    this.#tagFilteredImages = null;
    this.#filteredImages = null;
    this.#statsCache = null;
  }

  // called after DOM is ready — sets up scroll, card interactions, collapsed groups
  onRender() {
    this.#setupVirtualScroll();
    this.#restoreScrollPosition();
    this.#bindCardInteractions();
    this.#restoreCollapsedGroups();
  }

  // creates the virtual scroll grid and hooks up resize observer
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

  // builds a single card DOM element for an image entry
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

  // opens the image import dialog for adding a new image
  async onAddImage() {
    if (!this.#app.selectedJournalId) return;
    const { ImageImport } = await import('../import-image/image-import.mjs');
    const success = await ImageImport.open(this.#app.selectedJournalId);
    if (success) this.#refreshAfterChange();
  }

  // same as add, but conceptually for folder import (same dialog tho)
  async onImportFromFolder() {
    if (!this.#app.selectedJournalId) return;
    const { ImageImport } = await import('../import-image/image-import.mjs');
    const success = await ImageImport.open(this.#app.selectedJournalId);
    if (success) this.#refreshAfterChange();
  }

  // handles click on a card — supports ctrl/shift multi-select
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

  // grabs all uuids from currently filtered images
  #getFilteredUuids() {
    return (this.#filteredImages ?? []).map(img => img.uuid);
  }

  // converts "select all" flag into actual individual selections
  #materializeSelectAll() {
    if (!this.#selectAllActive) return;
    this.#selectAllActive = false;
    for (const uuid of this.#getFilteredUuids()) {
      this.#selectedImages.add(uuid);
    }
  }

  // opens the editor for all selected images
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

  // refreshes display after editing without blowing away the whole cache
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

  // re-parses filenames of selected images and adds any matching tags they're missing
  async onRefreshTagsFromNames() {
    const uuids = this.#getEffectiveSelection();
    if (uuids.length === 0) return;

    const knownTagIds = tag.getAll().map(t => t.id);
    const updates = [];
    const pagesByJournal = new Map();

    for (const uuid of uuids) {
      try {
        const page = await fromUuid(uuid);
        if (!page) continue;

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
    }

    if (updates.length === 0) return;

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

    this.#saveScrollPosition();
    tagIndex.updateImages(updates);
    this.#refreshAfterEditInPlace();
  }

  // returns the actual list of selected uuids, expanding "select all" if needed
  #getEffectiveSelection() {
    if (this.#selectAllActive) {
      return this.#getFilteredUuids();
    }
    return Array.from(this.#selectedImages);
  }

  // resets selection state completely
  #clearSelection() {
    this.#selectedImages.clear();
    this.#lastSelectedUuid = null;
    this.#selectAllActive = false;
  }

  // deletes selected images with confirmation, does the actual deletion in the background
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

  // groups page uuids by their parent journal for batch operations
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

  // fires off all journal deletions in parallel, doesn't block the ui
  async #executeBackgroundDeletion(pagesByJournal) {
    await Promise.allSettled(
      Array.from(pagesByJournal.entries()).map(([journalUuid, pageIds]) =>
        this.#deleteFromJournal(journalUuid, pageIds)
      )
    );
  }

  // deletes pages from a single journal, picks the best strategy based on how many we're nuking
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

  // toggles select all — if already all selected, deselects everything
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

  // pops open the full-size image viewer
  onOpenImage(event, target) {
    event.stopPropagation();
    new ImagePopout(target.dataset.url).render(true);
  }

  // handles clicking a tag in the sidebar — toggles it and re-filters everything
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

  // collapses/expands a tag group in the sidebar
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
    }
  }

  // returns the selected uuids for the picker callback
  getSelectedUuids() {
    return this.#getEffectiveSelection();
  }

  // creates an actor from the selected images via the actor config dialog
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

  // patches the sidebar tag counts and total without a full re-render
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

  // sets up hover listeners on the grid container for card popups (delegated)
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

  // mouse entered a card — cancel any pending hide and show the popup
  #handleCardEnter(card) {
    if (this.#popupHideTimeout) {
      clearTimeout(this.#popupHideTimeout);
      this.#popupHideTimeout = null;
    }
    this.#currentHoveredCard = card;
    this.#showPopup(card);
  }

  // mouse left a card — schedule hiding unless we moved to the popup itself
  #handleCardLeave(card, event) {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget?.closest('.cs-hero-box-data-manager__card') === card) return;
    if (relatedTarget?.closest('.cs-hero-box-card-popup')) return;
    this.#scheduleHidePopup();
  }

  // hides the popup after a short delay so it doesn't flicker
  #scheduleHidePopup() {
    if (this.#popupHideTimeout) clearTimeout(this.#popupHideTimeout);
    this.#popupHideTimeout = setTimeout(() => {
      this.#hidePopup();
      this.#popupHideTimeout = null;
      this.#currentHoveredCard = null;
    }, 100);
  }

  // renders the hover popup next to a card with token/portrait previews and tags
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
      ? `<strong>Tags:</strong> ${tagsDisplay}`
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

  // hides the popup (just css, doesn't remove it from dom)
  #hidePopup() {
    if (this.#popupElement) {
      this.#popupElement.style.opacity = '0';
      this.#popupElement.style.visibility = 'hidden';
    }
    this.#currentHoveredCard = null;
  }

  // full refresh after adding/removing images
  #refreshAfterChange() {
    this.#saveScrollPosition();
    this.#clearSelection();
    this.#invalidateAll();
    this.#app.render();
  }

  // saves current scroll position so we can restore it after re-render
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

  // updates card selection classes without re-rendering the whole thing
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

  // syncs toolbar buttons and selection count with current state
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

  // re-applies collapsed state to sidebar groups after re-render (skips animation)
  #restoreCollapsedGroups() {
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

  // tears down everything — listeners, virtual scroll, popup, worker
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
    filterWorker.destroy();
    this.#workerInitialized = false;
  }
}


// virtualized grid that only renders cards visible in the viewport + buffer
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

  constructor({ container, items, bufferRows, renderCard, getItemId }) {
    this.#container = container;
    this.#items = items;
    this.#bufferRows = bufferRows ?? 3;
    this.#renderCard = renderCard;
    this.#getItemId = getItemId;
  }

  get contentElement() { return this.#content; }

  // creates the content div, measures cards, and does initial render
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

  // throttled scroll handler via rAF
  #onScrollBound = () => {
    if (this.#scrollRAF) return;
    this.#scrollRAF = requestAnimationFrame(() => {
      this.#scrollRAF = null;
      this.#renderVisible();
    });
  };

  // renders a probe card offscreen to figure out card dimensions
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

  // figures out how many cards fit in a row based on container width
  #calculateCardsPerRow() {
    const containerStyle = getComputedStyle(this.#container);
    const paddingLeft = parseFloat(containerStyle.paddingLeft) || 0;
    const paddingRight = parseFloat(containerStyle.paddingRight) || 0;
    const availableWidth = this.#container.clientWidth - paddingLeft - paddingRight;

    if (this.#cardWidth > 0) {
      this.#cardsPerRow = Math.max(1, Math.floor((availableWidth + this.#gap) / (this.#cardWidth + this.#gap)));
    }
  }

  // sets the content div height to match the total grid size for proper scrollbar
  #updateContentHeight() {
    const totalRows = Math.ceil(this.#items.length / this.#cardsPerRow);
    const totalHeight = totalRows > 0
      ? totalRows * this.#cardHeight + (totalRows - 1) * this.#gap
      : 0;
    this.#content.style.height = `${totalHeight}px`;
  }

  // calculates the absolute x/y position for a card at a given index
  #getCardPosition(index) {
    const row = Math.floor(index / this.#cardsPerRow);
    const col = index % this.#cardsPerRow;
    return {
      x: col * (this.#cardWidth + this.#gap),
      y: row * (this.#cardHeight + this.#gap),
    };
  }

  // the core rendering loop — adds/removes cards based on scroll position
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

  // recalculates layout when container gets resized
  handleResize() {
    if (!this.#mounted || this.#items.length === 0) return;

    const prevPerRow = this.#cardsPerRow;
    this.#calculateCardsPerRow();

    if (prevPerRow !== this.#cardsPerRow) {
      this.#updateContentHeight();
      this.#repositionAll();
    }
  }

  // moves all currently rendered cards to their new positions after layout change
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

  // swaps the item list and re-renders, tries to keep scroll position
  updateItems(newItems) {
    const scrollTop = this.#container.scrollTop;
    this.#items = newItems;
    this.#updateContentHeight();
    this.#clearAll();
    this.#container.scrollTop = scrollTop;
    this.#renderVisible();
  }

  // runs a callback on every currently rendered card element
  updateVisibleCards(callback) {
    for (const card of this.#renderedCards.values()) {
      callback(card);
    }
  }

  // removes all rendered cards from DOM
  #clearAll() {
    for (const card of this.#renderedCards.values()) card.remove();
    this.#renderedCards.clear();
    this.#renderedIndices.clear();
  }

  // full teardown — cancel rAF, remove listener, clear cards
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