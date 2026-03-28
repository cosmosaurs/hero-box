/**
 * @fileoverview Data Manager "Tags" tab: list/filter custom tags and open editor.
 */

import { TAG_CATEGORY, isBuiltinTag } from '../../constants/tags.mjs';
import { logger } from '../../utils/index.mjs';
import { buildSidebarCategories, handleTagToggle } from '../../utils/sidebar.mjs';
import { tag, source } from '../../services/index.mjs';
import { sortByLabel } from '../../utils/sort.mjs';

/** Tab logic for tag definitions; `app` is the parent DataManager. */
export class TagsTab {
  #app = null;
  #filters = { tags: [], search: '', categories: [] };
  #collapsedGroups = new Set();
  #allTagsCache = null;
  #tagCountsCache = null;
  #filteredCache = null;
  #lastFilterKey = '';

  /** @param {import('./data-manager.mjs').DataManager} app */
  constructor(app) {
    this.#app = app;
  }

  /** @returns {string} */
  get searchQuery() { return this.#filters.search; }
  /** @returns {boolean} */
  get hasFilters() { return this.#filters.tags.length > 0 || this.#filters.search.length > 0 || this.#filters.categories.length > 0; }

  /** @param {string} query */
  setSearchQuery(query) {
    this.#filters.search = query;
    this.#filteredCache = null;
  }

  /** Clears filters and internal caches. */
  reset() {
    this.#filters = { tags: [], search: '', categories: [] };
    this.#allTagsCache = null;
    this.#tagCountsCache = null;
    this.#filteredCache = null;
    this.#lastFilterKey = '';
  }

  /** Marks tag list caches stale so they rebuild on next access. */
  invalidateCache() {
    this.#allTagsCache = null;
    this.#tagCountsCache = null;
    this.#filteredCache = null;
    this.#lastFilterKey = '';
  }

  /** @returns {Promise<object>} */
  async prepareContext() {
    const allTags = this.#getAllTags();
    const tagCounts = this.#getTagCounts(allTags);
    const filteredTags = this.#getFilteredTags(allTags);
    const groupedTags = this.#groupTagsForDisplay(filteredTags);

    const tagsByCategory = buildSidebarCategories({
      tagCounts,
      activeTags: this.#filters.tags,
      activeCategories: this.#filters.categories,
      showCategoryFilter: true,
      hideGender: true,
      hideAge: true,
      hideSubrace: true,
      hideRole: true,
    });

    return {
      tags: groupedTags,
      tagsByCategory,
      totalTags: allTags.length,
      filteredTags: groupedTags.length,
    };
  }

  /** @returns {object[]} */
  #getAllTags() {
    if (this.#allTagsCache) return this.#allTagsCache;
    this.#allTagsCache = tag.getAll().filter(t => !isBuiltinTag(t.id));
    return this.#allTagsCache;
  }

  /** @param {object[]} allTags @returns {Map<string, number>} */
  #getTagCounts(allTags) {
    if (this.#tagCountsCache) return this.#tagCountsCache;

    const counts = new Map();
    for (const t of allTags) {
      counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
      counts.set(t.id, 1);
    }

    this.#tagCountsCache = counts;
    return counts;
  }

  /** @param {object[]} allTags @returns {object[]} */
  #getFilteredTags(allTags) {
    const filterKey = `${this.#filters.categories.join(',')}|${this.#filters.tags.join(',')}|${this.#filters.search}`;
    if (filterKey === this.#lastFilterKey && this.#filteredCache) {
      return this.#filteredCache;
    }

    let result = allTags;

    if (this.#filters.categories.length > 0) {
      const catsSet = new Set(this.#filters.categories);
      result = result.filter(t => catsSet.has(t.category));
    }

    if (this.#filters.tags.length > 0) {
      const filterRaces = new Set(this.#filters.tags.filter(t => {
        const tagData = tag.get(t);
        return tagData?.category === TAG_CATEGORY.RACE;
      }));

      if (filterRaces.size > 0) {
        result = result.filter(t => {
          if (t.category === TAG_CATEGORY.RACE) return filterRaces.has(t.id);
          if (t.category === TAG_CATEGORY.SUBRACE) return filterRaces.has(t.parentRaceId);
          return true;
        });
      }
    }

    if (this.#filters.search) {
      const query = this.#filters.search.toLowerCase();
      result = result.filter(t => {
        const searchIn = `${t.id} ${t.label ?? ''}`.toLowerCase();
        return searchIn.includes(query);
      });
    }

    this.#filteredCache = result;
    this.#lastFilterKey = filterKey;
    return result;
  }

  /** Restores collapsed sidebar groups after template render. */
  onRender() {
    this.#restoreCollapsedGroups();
  }

  /** @returns {Promise<void>} */
  async onAddTag() {
    if (!this.#app.selectedJournalId) {
      ui.notifications.warn(game.i18n.localize('cs-hero-box.dataManager.selectJournalFirst'));
      return;
    }
    const { Editor } = await import('../editor/editor.mjs');
    const saved = await Editor.openTag(null, this.#app.selectedJournalId);
    if (saved) {
      this.invalidateCache();
      this.#app.render();
    }
  }

  /** @returns {Promise<void>} */
  async onEditTag(event, target) {
    const uuid = target.closest('[data-uuid]').dataset.uuid;
    try {
      const page = await fromUuid(uuid);
      if (page) {
        const { Editor } = await import('../editor/editor.mjs');
        const saved = await Editor.openTag(page);
        if (saved) {
          this.invalidateCache();
          this.#app.render();
        }
      }
    } catch (error) {
      logger.warn(`Failed to edit tag ${uuid}:`, error);
    }
  }

  /** @returns {Promise<void>} */
  async onDeleteTag(event, target) {
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
        await tag.reload();
        this.invalidateCache();
        this.#app.render();
      }
    } catch (error) {
      logger.warn(`Failed to delete tag ${uuid}:`, error);
    }
  }

  /** Sidebar tag/category filter toggle. */
  onToggleTag(event, target) {
    const tagId = target.dataset.tag;
    const isCategoryFilter = target.dataset.categoryFilter === 'true';

    handleTagToggle(this.#filters, tagId, tag, false, isCategoryFilter);
    this.#filteredCache = null;
    this.#app.render();
  }

  /** Collapse/expand a category group in the sidebar. */
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

  /** Reapply `.collapsed` without transition flash after render. */
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

  /** @param {object[]} filteredTags @returns {object[]} */
  #groupTagsForDisplay(filteredTags) {
    const raceTags = filteredTags.filter(t => t.category === TAG_CATEGORY.RACE);
    const subraceTags = filteredTags.filter(t => t.category === TAG_CATEGORY.SUBRACE);
    const otherTags = filteredTags.filter(t =>
      t.category !== TAG_CATEGORY.RACE && t.category !== TAG_CATEGORY.SUBRACE
    );

    const sortedRaces = sortByLabel(raceTags);
    const sortedOther = sortByLabel(otherTags);

    const groupedTags = [];

    for (const race of sortedRaces) {
      groupedTags.push({
        ...race,
        label: tag.getLabel(race.id),
        categoryLabel: game.i18n.localize(`cs-hero-box.tagCategory.${race.category}`),
        sourceName: source.getSourceName(race.sourceId),
        isRace: true,
      });

      const raceSubraces = subraceTags
        .filter(s => s.parentRaceId === race.id)
        .map(s => ({ ...s, label: tag.getLabel(s.id) }));

      for (const subrace of sortByLabel(raceSubraces)) {
        groupedTags.push({
          ...subrace,
          categoryLabel: game.i18n.localize(`cs-hero-box.tagCategory.${subrace.category}`),
          sourceName: source.getSourceName(subrace.sourceId),
          isSubrace: true,
        });
      }
    }

    const orphanSubraces = subraceTags
      .filter(s => !raceTags.some(r => r.id === s.parentRaceId))
      .map(s => ({ ...s, label: tag.getLabel(s.id) }));

    for (const subrace of sortByLabel(orphanSubraces)) {
      groupedTags.push({
        ...subrace,
        categoryLabel: game.i18n.localize(`cs-hero-box.tagCategory.${subrace.category}`),
        sourceName: source.getSourceName(subrace.sourceId),
        isSubrace: true,
      });
    }

    for (const t of sortedOther) {
      groupedTags.push({
        ...t,
        label: tag.getLabel(t.id),
        categoryLabel: game.i18n.localize(`cs-hero-box.tagCategory.${t.category}`),
        sourceName: source.getSourceName(t.sourceId),
      });
    }

    return groupedTags;
  }
}