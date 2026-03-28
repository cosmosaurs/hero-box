import { NAME_TYPES } from '../../constants/ui.mjs';
import { logger } from '../../utils/index.mjs';
import { buildSidebarCategories, handleTagToggle } from '../../utils/sidebar.mjs';
import { nameGenerator, tag } from '../../services/index.mjs';
import { sortByLabel } from '../../utils/sort.mjs';

// handles the names tab — loading name sets, filtering, sidebar, crud ops
export class NamesTab {
  #app = null;
  #filters = { tags: [], search: '', types: [] };
  #collapsedGroups = new Set();

  #sortedCache = null;
  #filteredCache = null;
  #lastFilterKey = '';

  constructor(app) {
    this.#app = app;
  }

  get searchQuery() { return this.#filters.search; }
  get hasFilters() { return this.#filters.tags.length > 0 || this.#filters.search.length > 0 || this.#filters.types.length > 0; }

  // updates search and invalidates filtered cache
  setSearchQuery(query) {
    this.#filters.search = query;
    this.#filteredCache = null;
  }

  // clears all filters back to defaults
  reset() {
    this.#filters = { tags: [], search: '', types: [] };
    this.#sortedCache = null;
    this.#filteredCache = null;
    this.#lastFilterKey = '';
  }

  // blows away all cached data so everything gets reloaded
  invalidateCache() {
    this.#sortedCache = null;
    this.#filteredCache = null;
    this.#lastFilterKey = '';
  }

  // builds the full context for rendering the names tab
  async prepareContext() {
    const allSets = nameGenerator.getAllSets();

    if (!this.#sortedCache) {
      this.#sortedCache = sortByLabel(allSets);
    }

    const filteredSets = this.#getFilteredSets();
    const tagCounts = nameGenerator.getTagCounts();

    const tagsByCategory = buildSidebarCategories({
      tagCounts,
      activeTags: this.#filters.tags,
      activeTypes: this.#filters.types,
      showTypes: true,
      hideAge: true,
      typeOptions: NAME_TYPES.map(id => ({
        id,
        label: game.i18n.localize(`cs-hero-box.nameType.${id}`),
      })),
    });

    return {
      nameSets: filteredSets.map(set => ({
        uuid: set.uuid,
        name: set.name,
        typeLabel: game.i18n.localize(`cs-hero-box.nameType.${set.type ?? 'firstName'}`),
        tagsDisplay: set.tagsDisplay,
        localesDisplay: set.localesDisplay,
        tags: set.tags.join(','),
        sourceName: set.sourceName,
      })),
      tagsByCategory,
      totalSets: allSets.length,
      filteredSets: filteredSets.length,
    };
  }

  // applies type, tag, and search filters to the sorted name sets
  #getFilteredSets() {
    const filterKey = this.#buildFilterKey();
    if (filterKey === this.#lastFilterKey && this.#filteredCache) {
      return this.#filteredCache;
    }

    let result = this.#sortedCache ?? [];

    if (this.#filters.types.length > 0) {
      const typesSet = new Set(this.#filters.types);
      result = result.filter(set => typesSet.has(set.type));
    }

    if (this.#filters.tags.length > 0) {
      const filterTagsSet = new Set(this.#filters.tags);
      result = result.filter(set => {
        const setTags = new Set(set.tags);
        for (const t of filterTagsSet) {
          if (!setTags.has(t)) return false;
        }
        return true;
      });
    }

    if (this.#filters.search) {
      const query = this.#filters.search.toLowerCase();
      result = result.filter(set => set.searchString.includes(query));
    }

    this.#filteredCache = result;
    this.#lastFilterKey = filterKey;
    return result;
  }

  // creates a string key from current filters for cache invalidation checks
  #buildFilterKey() {
    return `${this.#filters.types.join(',')}|${this.#filters.tags.join(',')}|${this.#filters.search}`;
  }

  // post-render hook — restores collapsed sidebar groups
  onRender() {
    this.#restoreCollapsedGroups();
  }

  // opens editor for creating a new name set
  async onAddNameSet() {
    if (!this.#app.selectedJournalId) return;
    const { Editor } = await import('../editor/editor.mjs');
    const saved = await Editor.openName(null, this.#app.selectedJournalId);
    if (saved) {
      await nameGenerator.reload();
      this.invalidateCache();
      this.#app.render();
    }
  }

  // opens editor for an existing name set
  async onEditNameSet(event, target) {
    const uuid = target.closest('[data-uuid]').dataset.uuid;
    try {
      const page = await fromUuid(uuid);
      if (page) {
        const { Editor } = await import('../editor/editor.mjs');
        const saved = await Editor.openName(page);
        if (saved) {
          await nameGenerator.reload();
          this.invalidateCache();
          this.#app.render();
        }
      }
    } catch (error) {
      logger.warn(`Failed to edit name set ${uuid}:`, error);
    }
  }

  // deletes a name set after confirmation
  async onDeleteNameSet(event, target) {
    const uuid = target.closest('[data-uuid]').dataset.uuid;

    try {
      const page = await fromUuid(uuid);
      if (!page) return;

      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: game.i18n.localize('cs-hero-box.dataManager.deleteConfirm.title') },
        content: `<p>${game.i18n.format('cs-hero-box.dataManager.deleteConfirm.content', { name: page.name })}</p>`,
        yes: { default: true },
        no: { default: false },
      });

      if (confirmed) {
        await page.delete();
        this.invalidateCache();
        this.#app.render();
      }
    } catch (error) {
      logger.warn(`Failed to delete name set ${uuid}:`, error);
    }
  }

  // generates a random name from the set's tags and copies it to clipboard
  async onTestGenerate(event, target) {
    const tags = target.dataset.tags?.split(',').filter(Boolean) ?? [];
    const name = nameGenerator.generate(tags);

    try {
      await navigator.clipboard.writeText(name);
    } catch {
      const textArea = document.createElement('textarea');
      textArea.value = name;
      textArea.style.position = 'fixed';
      textArea.style.left = '-9999px';
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
    }

    ui.notifications.info(game.i18n.format('cs-hero-box.dataManager.testResult', { name }));
  }

  // toggles a tag or type filter in the sidebar
  onToggleTag(event, target) {
    const tagId = target.dataset.tag;
    const isTypeFilter = target.dataset.typeFilter === 'true';

    handleTagToggle(this.#filters, tagId, tag, isTypeFilter);
    this.#filteredCache = null;
    this.#app.render();
  }

  // collapses/expands a sidebar tag group
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

  // re-applies collapsed state to groups after re-render without animation glitch
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
}
