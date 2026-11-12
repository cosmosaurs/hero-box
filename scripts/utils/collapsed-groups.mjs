**
 * @fileoverview Persists collapsed/open state for data-manager sidebar groups across re-renders and sessions.
 */

import { SETTINGS } from '../constants/settings.mjs';
import { getSetting, setSetting } from '../settings.mjs';

export class CollapsedGroupsManager {
  #collapsedGroups = new Set();
  #subTreeOverrides = new Map();
  #app = null;
  #tabKey = null;

  /**
   * @param {{ querySelector: (selector: string) => Element|null }} app Parent application or element provider.
   * @param {string|null} [tabKey] Key under `SETTINGS.COLLAPSED_DATA_MANAGER` (`'images' | 'names' | 'tags'`).
   */
  constructor(app, tabKey = null) {
    this.#app = app;
    this.#tabKey = tabKey;
  }

  /** @param {HTMLElement} target Click target inside a tag group header. */
  toggle(target) {
    const group = target.closest('.cs-hero-box-data-manager__tag-group');
    if (!group) return;

    const category = group.dataset.category;
    group.classList.toggle('collapsed');

    if (group.classList.contains('collapsed')) {
      this.#collapsedGroups.add(category);
    } else {
      this.#collapsedGroups.delete(category);
    }

    this.#save();
  }

  /**
   * Expand/collapse a nested tree item (such as a Role Group inside the Roles sidebar section).
   * @param {HTMLElement} target
   */
  toggleSubTree(target) {
    const tree = target.closest('.cs-hero-box-data-manager__tag-tree');
    if (!tree) return;

    const treeId = tree.dataset.treeId;
    tree.classList.toggle('collapsed');
    const isExpanded = !tree.classList.contains('collapsed');
    if (treeId) {
      this.#subTreeOverrides.set(treeId, isExpanded);
    }
  }

  /**
   * Explicitly set whether a nested tree item is expanded across re-renders.
   * @param {string} treeId
   * @param {boolean} expanded
   */
  setSubTreeExpanded(treeId, expanded) {
    if (!treeId) return;
    this.#subTreeOverrides.set(treeId, expanded);
  }

  /** Re-apply `.collapsed` from settings / `#collapsedGroups` after DOM update without transition flash. */
  restore() {
    if (this.#tabKey) {
      try {
        const saved = getSetting(SETTINGS.COLLAPSED_DATA_MANAGER);
        const tabCollapsed = saved?.[this.#tabKey] ?? [];
        this.#collapsedGroups = new Set(tabCollapsed);
      } catch {
        // ignore if settings unavailable
      }
    }

    for (const category of this.#collapsedGroups) {
      const group = this.#app?.querySelector(
        `.cs-hero-box-data-manager__tag-group[data-category="${category}"]`
      );
      if (group) {
        group.classList.add('no-transition', 'collapsed');
        requestAnimationFrame(() => {
          requestAnimationFrame(() => group.classList.remove('no-transition'));
        });
      }
    }

    for (const [treeId, isExpanded] of this.#subTreeOverrides) {
      const tree = this.#app?.querySelector(
        `.cs-hero-box-data-manager__tag-tree[data-tree-id="${treeId}"]`
      );
      if (tree) {
        tree.classList.add('no-transition');
        tree.classList.toggle('collapsed', !isExpanded);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => tree.classList.remove('no-transition'));
        });
      }
    }
  }

  /** Expand all groups (forget collapsed ids). */
  clear() {
    this.#collapsedGroups.clear();
    this.#subTreeOverrides.clear();
  }

  #save() {
    if (!this.#tabKey) return;
    try {
      const saved = { ...(getSetting(SETTINGS.COLLAPSED_DATA_MANAGER) ?? {}) };
      saved[this.#tabKey] = Array.from(this.#collapsedGroups);
      setSetting(SETTINGS.COLLAPSED_DATA_MANAGER, saved);
    } catch {
      // ignore if settings unavailable
    }
  }
}
