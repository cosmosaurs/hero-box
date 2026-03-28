/**
 * @fileoverview Persists collapsed/open state for data-manager sidebar groups across re-renders.
 */
export class CollapsedGroupsManager {
  #collapsedGroups = new Set();
  #appRef = null;

  /**
   * @param {HTMLElement} appRef Root element to query for tag groups.
   */
  constructor(appRef) {
    this.#appRef = appRef;
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
  }

  // re-apply collapsed state after a re-render without the transition animation
  /** Re-apply `.collapsed` from `#collapsedGroups` after DOM update. */
  restore() {
    for (const category of this.#collapsedGroups) {
      const group = this.#appRef.querySelector(
        `.cs-hero-box-data-manager__tag-group[data-category="${category}"]`
      );
      if (group) {
        group.classList.add('no-transition', 'collapsed');
        requestAnimationFrame(() => {
          requestAnimationFrame(() => group.classList.remove('no-transition'));
        });
      }
    }
  }

  /** Expand all groups (forget collapsed ids). */
  clear() {
    this.#collapsedGroups.clear();
  }
}