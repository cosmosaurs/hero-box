**
 * @fileoverview Data Manager "Tags" tab: list/filter custom tags and open editor.
 */

import { TAG_CATEGORY, isBuiltinTag } from '../../constants/tags.mjs';
import { logger } from '../../utils/index.mjs';
import { buildSidebarCategories, handleTagToggle } from '../../utils/sidebar.mjs';
import { tag, source } from '../../services/index.mjs';
import { sortByLabel } from '../../utils/sort.mjs';
import { CollapsedGroupsManager } from '../../utils/collapsed-groups.mjs';

/** Tab logic for tag definitions; `app` is the parent DataManager. */
export class TagsTab {
  #app = null;
  #filters = { tags: [], search: '', categories: [] };
  #collapsedManager = null;
  #expandedGroupIds = new Set();
  #allTagsCache = null;
  #tagCountsCache = null;
  #filteredCache = null;
  #lastFilterKey = '';

  /** @param {import('./data-manager.mjs').DataManager} app */
  constructor(app) {
    this.#app = app;
    this.#collapsedManager = new CollapsedGroupsManager(app, 'tags');
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
    this.#expandedGroupIds.clear();
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
      hideRoleGroup: false,
      hideRole: true,
      hideOther: true,
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
      const filterRaces = new Set(this.#filters.tags.filter(t => tag.get(t)?.category === TAG_CATEGORY.RACE));
      const filterRoleGroups = new Set(this.#filters.tags.filter(t => tag.get(t)?.category === TAG_CATEGORY.ROLE_GROUP));

      if (filterRaces.size > 0 || filterRoleGroups.size > 0) {
        result = result.filter(t => {
          if (filterRaces.size > 0 && (t.category === TAG_CATEGORY.RACE ? filterRaces.has(t.id) : t.category === TAG_CATEGORY.SUBRACE && filterRaces.has(t.parentRaceId))) {
            return true;
          }
          if (filterRoleGroups.size > 0 && (t.category === TAG_CATEGORY.ROLE_GROUP ? filterRoleGroups.has(t.id) : t.category === TAG_CATEGORY.ROLE && filterRoleGroups.has(t.roleGroupId))) {
            return true;
          }
          return false;
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
    this.#collapsedManager.restore();
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

      const safeName = foundry.utils.escapeHTML(page.name ?? '');
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: game.i18n.localize('cs-hero-box.dataManager.deleteConfirm.title') },
        content: `<p>${game.i18n.format('cs-hero-box.dataManager.deleteConfirm.content', { name: safeName })}</p>`,
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
    this.#collapsedManager.toggle(target);
  }

  /** Collapse/expand a role-group subtree in the sidebar. */
  onToggleRoleGroupTree(event, target) {
    this.#collapsedManager.toggleSubTree(target);
  }

  /** Expand/collapse child role rows under a roleGroup row in the tags table. */
  onToggleTagTableGroup(event, target) {
    const groupId = target.dataset.groupId;
    if (!groupId) return;

    const safeId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(groupId) : groupId;
    const groupRow = this.#app.querySelector(`.cs-hero-box-data-manager__tag-row[data-role-group-row="${safeId}"]`);
    const isCurrentlyCollapsed = groupRow
      ? groupRow.classList.contains('collapsed')
      : !this.#expandedGroupIds.has(groupId);
    const shouldExpand = isCurrentlyCollapsed;

    if (shouldExpand) {
      this.#expandedGroupIds.add(groupId);
    } else {
      this.#expandedGroupIds.delete(groupId);
    }

    if (groupRow) {
      groupRow.classList.toggle('collapsed', !shouldExpand);
    }

    const childRows = this.#app.querySelectorAll(`.cs-hero-box-data-manager__tag-row[data-parent-role-group="${safeId}"]`);
    for (const row of childRows) {
      row.style.display = shouldExpand ? '' : 'none';
    }
  }

  /** @param {object[]} filteredTags @returns {object[]} */
  #groupTagsForDisplay(filteredTags) {
    const raceTags = filteredTags.filter(t => t.category === TAG_CATEGORY.RACE);
    const subraceTags = filteredTags.filter(t => t.category === TAG_CATEGORY.SUBRACE);
    const roleTags = filteredTags.filter(t => t.category === TAG_CATEGORY.ROLE);
    const otherTags = filteredTags.filter(t =>
      t.category !== TAG_CATEGORY.RACE
      && t.category !== TAG_CATEGORY.SUBRACE
      && t.category !== TAG_CATEGORY.ROLE_GROUP
      && t.category !== TAG_CATEGORY.ROLE
    );

    const roleGroupMap = new Map();
    for (const g of filteredTags) {
      if (g.category === TAG_CATEGORY.ROLE_GROUP) {
        roleGroupMap.set(g.id, g);
      }
    }
    for (const r of roleTags) {
      if (r.roleGroupId && !roleGroupMap.has(r.roleGroupId)) {
        const parentGroup = tag.get(r.roleGroupId);
        if (parentGroup?.category === TAG_CATEGORY.ROLE_GROUP) {
          roleGroupMap.set(parentGroup.id, parentGroup);
        }
      }
    }
    const roleGroupTags = Array.from(roleGroupMap.values());

    const sortedRaces = sortByLabel(raceTags);
    const sortedRoleGroups = sortByLabel(roleGroupTags.map(g => ({ ...g, label: tag.getLabel(g.id) })));
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

    for (const group of sortedRoleGroups) {
      const groupedRoles = roleTags
        .filter(r => r.roleGroupId === group.id)
        .map(r => ({ ...r, label: tag.getLabel(r.id) }));

      const forceExpand = Boolean(this.#filters.search)
        || this.#filters.tags.includes(group.id)
        || this.#filters.categories.includes(TAG_CATEGORY.ROLE);
      const isExpanded = forceExpand || this.#expandedGroupIds.has(group.id);

      groupedTags.push({
        ...group,
        label: tag.getLabel(group.id),
        categoryLabel: game.i18n.localize(`cs-hero-box.tagCategory.${group.category}`),
        sourceName: source.getSourceName(group.sourceId),
        isRoleGroup: true,
        hasChildRoles: groupedRoles.length > 0,
        childCount: groupedRoles.length,
        isExpanded,
      });

      for (const role of sortByLabel(groupedRoles)) {
        const w = tag.getRoleWeight(role.id);
        groupedTags.push({
          ...role,
          categoryLabel: game.i18n.localize(`cs-hero-box.tagCategory.${role.category}`),
          sourceName: source.getSourceName(role.sourceId),
          isGroupedRole: true,
          parentRoleGroupId: group.id,
          isHiddenByCollapse: !isExpanded,
          weightBadge: w !== 1 ? `×${w}` : null,
        });
      }
    }

    const ungroupedRoles = roleTags
      .filter(r => !roleGroupMap.has(r.roleGroupId))
      .map(r => ({ ...r, label: tag.getLabel(r.id) }));

    for (const role of sortByLabel(ungroupedRoles)) {
      const w = tag.getRoleWeight(role.id);
      groupedTags.push({
        ...role,
        categoryLabel: game.i18n.localize(`cs-hero-box.tagCategory.${role.category}`),
        sourceName: source.getSourceName(role.sourceId),
        isRole: true,
        isGroupedRole: false,
        weightBadge: w !== 1 ? `×${w}` : null,
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