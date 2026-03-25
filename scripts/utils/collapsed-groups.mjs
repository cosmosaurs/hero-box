// remembers which sidebar tag groups are collapsed between re-renders
export class CollapsedGroupsManager {
  #collapsedGroups = new Set();
  #appRef = null;

  constructor(appRef) {
    this.#appRef = appRef;
  }

  // toggle a group open/closed and remember the state
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

  // reset everything to expanded
  clear() {
    this.#collapsedGroups.clear();
  }
}