import { MODULE_ID, SETTINGS, PATHS } from '../../constants/index.mjs';
import { TAB } from '../../constants/ui.mjs';
import { getSetting, setSetting } from '../../settings.mjs';
import { tagIndex, source } from '../../services/index.mjs';
import { BaseApplication } from '../base/base.mjs';

import { ImagesTab } from './images-tab.mjs';
import { NamesTab } from './names-tab.mjs';
import { TagsTab } from './tags-tab.mjs';

// main window for managing all module data — images, names, and tags
export class DataManager extends BaseApplication {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-data-manager`,
    window: {
      title: 'cs-hero-box.dataManager.title',
      resizable: false,
      minimizable: true,
    },
    position: {
      width: 'auto',
      height: 'auto',
    },
    actions: {
      switchTab: function(event, target) { this._onSwitchTab(event, target); },
      addImage: function() { this._onAddImage(); },
      importFromFolder: function() { this._onImportFromFolder(); },
      selectImage: function(event, target) { this._onSelectImage(event, target); },
      editSelected: function() { this._onEditSelected(); },
      deleteSelected: function() { this._onDeleteSelected(); },
      selectAll: function() { this._onSelectAll(); },
      addNameSet: function() { this._onAddNameSet(); },
      editNameSet: function(event, target) { this._onEditNameSet(event, target); },
      deleteNameSet: function(event, target) { this._onDeleteNameSet(event, target); },
      testGenerate: function(event, target) { this._onTestGenerate(event, target); },
      addTag: function() { this._onAddTag(); },
      editTag: function(event, target) { this._onEditTag(event, target); },
      deleteTag: function(event, target) { this._onDeleteTag(event, target); },
      toggleTag: function(event, target) { this._onToggleTag(event, target); },
      openImage: function(event, target) { this._onOpenImage(event, target); },
      confirmSelection: function() { this._onConfirmSelection(); },
      cancelSelection: function() { this._onCancelSelection(); },
      toggleTagGroup: function(event, target) { this._onToggleTagGroup(event, target); },
      openDataSources: function() { this._onOpenDataSources(); },
      createActorFromSelected: function() { this._onCreateActorFromSelected(); },
      refreshTagsFromNames: function() { this._onRefreshTagsFromNames(); },
    },
  };

  static PARTS = {
    main: {
      template: `${PATHS.TEMPLATES}/data-manager/data-manager.hbs`,
    },
  };

  #activeTab = TAB.IMAGES;
  #selectedJournalId = null;
  #journalsCache = null;
  #pickerMode = false;
  #pickerCallback = null;
  #initialFilters = {};

  #tabs = {
    [TAB.IMAGES]: new ImagesTab(this),
    [TAB.NAMES]: new NamesTab(this),
    [TAB.TAGS]: new TagsTab(this),
  };

  // sets up the manager, optionally in picker mode with pre-applied filters
  constructor(options = {}) {
    super();

    this.#pickerMode = options.pickerMode ?? false;
    this.#pickerCallback = options.onSelect ?? null;
    this.#initialFilters = options.initialFilters ?? {};

    if (this.#pickerMode) {
      this.#activeTab = TAB.IMAGES;
      this.#tabs[TAB.IMAGES].applyInitialFilters(this.#initialFilters);
    }

    this.#initializeDefaultJournal();
    this.#unlockAllCompendiums();
    this.#prefetchModules();
  }

  // opens as an image picker dialog, returns selected uuids or null on cancel
  static async pick(options = {}) {
    const { createSingleResolvePromise } = await import('../../utils/promise.mjs');
    const { promise, resolve } = createSingleResolvePromise();

    const app = new DataManager({
      pickerMode: true,
      ...options,
      onSelect: (uuids) => resolve(uuids),
    });

    const originalClose = app.close.bind(app);
    app.close = async (opts = {}) => {
      await originalClose(opts);
      resolve(null);
    };

    app.render(true);
    return promise;
  }

  // dynamic title depending on whether we're picking or managing
  get title() {
    return this.#pickerMode
      ? game.i18n.localize('cs-hero-box.imagePicker.title')
      : game.i18n.localize('cs-hero-box.dataManager.title');
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ['cs-hero-box-data-manager'],
    });
  }

  get element() { return super.element; }
  get selectedJournalId() { return this.#selectedJournalId; }
  get pickerMode() { return this.#pickerMode; }

  render(force, options) {
    return super.render(force, options);
  }

  // unlock compendium packs so we can actually write stuff to them
  async #unlockAllCompendiums() {
    const sources = source.getEnabledSources();

    for (const sourceId of sources) {
      if (sourceId.startsWith('Compendium.')) {
        const packId = sourceId.replace('Compendium.', '');
        const pack = game.packs.get(packId);

        if (pack?.locked) {
          try {
            await pack.configure({ locked: false });
          } catch (error) {
            console.warn(`Failed to unlock compendium ${packId}:`, error);
          }
        }
      }
    }
  }

  // post-render hook — wires up inputs and delegates to active tab
  _onRender(context, options) {
    super._onRender(context, options);
    this.#bindSearchInput();
    this.#bindSelectInputs();
    this.#addSettingsButton();
    this.#tabs[this.#activeTab].onRender();
  }

  // cleanup when closing the window
  _onClose(options) {
    this.#tabs[TAB.IMAGES].destroy();
    this.#removeOrphanedPopup();
    return super._onClose(options);
  }

  // builds the full render context merging shared stuff with the active tab's data
  async _prepareContext(options) {
    const journals = this.#getJournals();

    const context = {
      activeTab: this.#activeTab,
      isImagesTab: this.#activeTab === TAB.IMAGES,
      isNamesTab: this.#activeTab === TAB.NAMES,
      isTagsTab: this.#activeTab === TAB.TAGS,
      journals,
      selectedJournalId: this.#selectedJournalId,
      searchQuery: this.#tabs[this.#activeTab].searchQuery,
      pickerMode: this.#pickerMode,
      hasFilters: this.#tabs[this.#activeTab].hasFilters,
    };

    const tabContext = await this.#tabs[this.#activeTab].prepareContext();
    return { ...context, ...tabContext };
  }

  // grabs writable journals, cached after first call
  #getJournals() {
    if (this.#journalsCache) return this.#journalsCache;
    this.#journalsCache = source.getWritableJournals();
    return this.#journalsCache;
  }

  // figures out which journal to select by default — last used or first available
  #initializeDefaultJournal() {
    const lastSelected = getSetting(SETTINGS.LAST_SELECTED_JOURNAL);
    const journals = this.#getJournals();

    if (lastSelected && journals.some(j => j.id === lastSelected)) {
      this.#selectedJournalId = lastSelected;
    } else if (journals.length > 0) {
      this.#selectedJournalId = journals[0].id;
    }
  }

  // preloads heavy dialog modules in idle time so they open instantly later
  #prefetchModules() {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => {
        import('../editor/editor.mjs');
        import('../import-image/image-import.mjs');
        import('../data-sources/data-sources.mjs');
        import('../actor-config/actor-config.mjs');
      }, { timeout: 5000 });
    }
  }

  // hooks up the search box with debounced filtering
  #bindSearchInput() {
    const searchInput = this.querySelector('.cs-hero-box-data-manager__search');
    if (!searchInput) return;

    searchInput.value = this.#tabs[this.#activeTab].searchQuery;

    this.addDebouncedEvent(searchInput, 'input', (e) => {
      this.#tabs[this.#activeTab].setSearchQuery(e.target.value.toLowerCase());
      this.render();
    }, 300);
  }

  // hooks up the journal dropdown and persists selection
  #bindSelectInputs() {
    const journalSelect = this.querySelector('.cs-hero-box-data-manager__journal-select');
    if (journalSelect) {
      this.addEvent(journalSelect, 'change', (e) => {
        this.#selectedJournalId = e.target.value || null;
        if (this.#selectedJournalId) {
          setSetting(SETTINGS.LAST_SELECTED_JOURNAL, this.#selectedJournalId);
        }
        this.render();
      });
    }
  }

  // sticks a gear icon into the window header for quick access to data sources
  #addSettingsButton() {
    if (this.#pickerMode) return;

    const header = this.element.querySelector('.window-header');
    if (!header) return;

    const existingBtn = header.querySelector('.cs-hero-box-settings-btn');
    if (existingBtn) return;

    const closeBtn = header.querySelector('.header-control.close') ?? header.querySelector('button[data-action="close"]');
    if (!closeBtn) return;

    const settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.className = 'header-control cs-hero-box-settings-btn';
    settingsBtn.dataset.action = 'openDataSources';
    settingsBtn.dataset.tooltip = game.i18n.localize('cs-hero-box.settings.dataSources.name');
    settingsBtn.innerHTML = '<i class="fas fa-cog"></i>';

    closeBtn.insertAdjacentElement('afterend', settingsBtn);
  }

  // switches between images/names/tags tabs, resets the new tab's state
  _onSwitchTab(event, target) {
    if (this.#pickerMode) return;
    const newTab = target.dataset.tab;
    if (newTab === this.#activeTab) return;

    this.#activeTab = newTab;

    if (newTab !== TAB.IMAGES) {
      this.#tabs[newTab].reset();
    }

    this.render();
  }

  // opens the data sources config dialog
  async _onOpenDataSources() {
    const { DataSources } = await import('../data-sources/data-sources.mjs');
    const app = new DataSources();
    app.render(true);
  }

  // --- action delegates, just forwarding to the right tab ---

  _onRefreshTagsFromNames() { this.#tabs[TAB.IMAGES].onRefreshTagsFromNames(); }

  _onAddImage() { this.#tabs[TAB.IMAGES].onAddImage(); }
  _onImportFromFolder() { this.#tabs[TAB.IMAGES].onImportFromFolder(); }
  _onSelectImage(e, t) { this.#tabs[TAB.IMAGES].onSelectImage(e, t); }
  _onEditSelected() { this.#tabs[TAB.IMAGES].onEditSelected(); }
  _onDeleteSelected() { this.#tabs[TAB.IMAGES].onDeleteSelected(); }
  _onSelectAll() { this.#tabs[TAB.IMAGES].onSelectAll(); }
  _onOpenImage(e, t) { this.#tabs[TAB.IMAGES].onOpenImage(e, t); }
  _onCreateActorFromSelected() { this.#tabs[TAB.IMAGES].onCreateActorFromSelected(); }

  // confirms picked images and closes the picker
  _onConfirmSelection() {
    const uuids = this.#tabs[TAB.IMAGES].getSelectedUuids();
    if (this.#pickerCallback) this.#pickerCallback(uuids);
    this.close();
  }

  // nope out of picker mode
  _onCancelSelection() { this.close(); }

  _onAddNameSet() { this.#tabs[TAB.NAMES].onAddNameSet(); }
  _onEditNameSet(e, t) { this.#tabs[TAB.NAMES].onEditNameSet(e, t); }
  _onDeleteNameSet(e, t) { this.#tabs[TAB.NAMES].onDeleteNameSet(e, t); }
  _onTestGenerate(e, t) { this.#tabs[TAB.NAMES].onTestGenerate(e, t); }

  _onAddTag() { this.#tabs[TAB.TAGS].onAddTag(); }
  _onEditTag(e, t) { this.#tabs[TAB.TAGS].onEditTag(e, t); }
  _onDeleteTag(e, t) { this.#tabs[TAB.TAGS].onDeleteTag(e, t); }

  _onToggleTag(e, t) { this.#tabs[this.#activeTab].onToggleTag(e, t); }
  _onToggleTagGroup(e, t) { this.#tabs[this.#activeTab].onToggleTagGroup(e, t); }

  #removeOrphanedPopup() {
    const popup = document.querySelector('.cs-hero-box-card-popup');
    if (popup) {
      popup.remove();
    }
  }

  refreshAllTabs() {
    for (const tabInstance of Object.values(this.#tabs)) {
      if (typeof tabInstance.invalidateCache === 'function') {
        tabInstance.invalidateCache();
      }
    }
    this.#journalsCache = null;
    this.render();
  }
}