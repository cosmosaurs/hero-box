/**
 * @fileoverview Sidebar category trees and filter toggle handling for data manager UIs.
 */

import { TAG_CATEGORY, GENDER_TAGS, AGE_TAGS } from '../constants/tags.mjs';
import { tag } from '../services/tag.mjs';

/**
 * Build nested sidebar categories (gender, age, race, subrace, role, optional type/category filters).
 * @param {Record<string, unknown>} [options]
 * @returns {Record<string, unknown>}
 */
export function buildSidebarCategories(options = {}) {
  const {
    tagCounts = new Map(),
    activeTags = [],
    activeTypes = [],
    activeCategories = [],
    showTypes = false,
    showCategoryFilter = false,
    hideGender = false,
    hideAge = false,
    hideSubrace = false,
    hideRole = false,
    hideOther = false,
    typeOptions = [],
  } = options;

  const activeTagsSet = new Set(activeTags);
  const activeTypesSet = new Set(activeTypes);
  const activeCategoriesSet = new Set(activeCategories);

  const activeRaces = new Set(
    activeTags.filter(t => tag.get(t)?.category === TAG_CATEGORY.RACE)
  );

  const categories = {};

  if (showTypes && typeOptions.length > 0) {
    categories.type = {
      label: game.i18n.localize('cs-hero-box.editor.nameType'),
      icon: 'fa-font',
      collapsible: true,
      tags: typeOptions.map(opt => ({
        id: opt.id,
        label: opt.label,
        count: tagCounts.get(opt.id) ?? 0,
        isActive: activeTypesSet.has(opt.id),
        isTypeFilter: true,
      })),
    };
  }

  if (showCategoryFilter) {
    const categoryCounts = new Map();
    for (const t of tag.getAll()) {
      if (t.category && t.category !== 'builtin') {
        categoryCounts.set(t.category, (categoryCounts.get(t.category) ?? 0) + 1);
      }
    }

    categories.category = {
      label: game.i18n.localize('cs-hero-box.dataManager.allCategories'),
      icon: 'fa-folder',
      collapsible: true,
      tags: Object.values(TAG_CATEGORY).map(cat => ({
        id: cat,
        label: game.i18n.localize(`cs-hero-box.tagCategory.${cat}`),
        count: categoryCounts.get(cat) ?? 0,
        isActive: activeCategoriesSet.has(cat),
        isCategoryFilter: true,
      })).filter(t => t.count > 0),
    };
  }

  if (!hideGender) {
    categories.gender = {
      label: game.i18n.localize('cs-hero-box.form.labels.gender'),
      icon: 'fa-venus-mars',
      collapsible: true,
      tags: tag.getGenders().map(t => ({
        id: t.id,
        label: tag.getLabel(t.id),
        count: tagCounts.get(t.id) ?? 0,
        isActive: activeTagsSet.has(t.id),
      })),
    };
  }

  if (!hideAge) {
    categories.age = {
      label: game.i18n.localize('cs-hero-box.form.labels.age'),
      icon: 'fa-hourglass-half',
      collapsible: true,
      tags: tag.getAges().map(t => ({
        id: t.id,
        label: tag.getLabel(t.id),
        count: tagCounts.get(t.id) ?? 0,
        isActive: activeTagsSet.has(t.id),
      })),
    };
  }

  const races = tag.getRaces().map(t => ({
    id: t.id,
    label: tag.getLabel(t.id),
    count: tagCounts.get(t.id) ?? 0,
    isActive: activeTagsSet.has(t.id),
  }));

  categories.race = {
    label: game.i18n.localize('cs-hero-box.form.labels.race'),
    icon: 'fa-users',
    collapsible: true,
    tags: races.filter(t => t.count > 0 || showCategoryFilter),
  };

  if (!hideSubrace) {
    const subraces = tag.getSubraces()
      .filter(t => activeRaces.size === 0 || activeRaces.has(t.parentRaceId))
      .map(t => ({
        id: t.id,
        label: tag.getLabel(t.id),
        tooltip: tag.getLabel(t.parentRaceId),
        count: tagCounts.get(t.id) ?? 0,
        isActive: activeTagsSet.has(t.id),
      }));

    categories.subrace = {
      label: game.i18n.localize('cs-hero-box.form.labels.subrace'),
      icon: 'fa-user-friends',
      collapsible: true,
      hidden: activeRaces.size === 0,
      tags: subraces.filter(t => t.count > 0 || showCategoryFilter),
    };
  }

  if (!hideRole) {
    const roles = tag.getRoles().map(t => ({
      id: t.id,
      label: tag.getLabel(t.id),
      count: tagCounts.get(t.id) ?? 0,
      isActive: activeTagsSet.has(t.id),
    }));

    if (roles.some(t => t.count > 0) || showCategoryFilter) {
      categories.role = {
        label: game.i18n.localize('cs-hero-box.form.labels.role'),
        icon: 'fa-briefcase',
        collapsible: true,
        tags: roles.filter(t => t.count > 0 || showCategoryFilter),
      };
    }
  }

  if (!hideOther) {
    const others = tag.getOther().map(t => ({
      id: t.id,
      label: tag.getLabel(t.id),
      count: tagCounts.get(t.id) ?? 0,
      isActive: activeTagsSet.has(t.id),
    }));

    if (others.some(t => t.count > 0) || showCategoryFilter) {
      categories.other = {
        label: game.i18n.localize('cs-hero-box.form.labels.other'),
        icon: 'fa-ellipsis-h',
        collapsible: true,
        tags: others.filter(t => t.count > 0 || showCategoryFilter),
      };
    }
  }

  Object.values(categories).forEach(category => {
    category.tags?.sort((a, b) => a.label.localeCompare(b.label));
  });

  return categories;
}

/**
 * @param {{ tags: string[], types: string[], categories: string[] }} filters
 * @param {string} tagId
 * @param {{ get: (id: string) => { category?: string }|null|undefined }} tagService
 * @param {boolean} [isTypeFilter]
 * @param {boolean} [isCategoryFilter]
 */
export function handleTagToggle(filters, tagId, tagService, isTypeFilter = false, isCategoryFilter = false) {
  if (isTypeFilter) {
    const idx = filters.types.indexOf(tagId);
    if (idx >= 0) {
      filters.types.splice(idx, 1);
    } else {
      filters.types.push(tagId);
    }
  } else if (isCategoryFilter) {
    const idx = filters.categories.indexOf(tagId);
    if (idx >= 0) {
      filters.categories.splice(idx, 1);
    } else {
      filters.categories.push(tagId);
    }
  } else {
    const idx = filters.tags.indexOf(tagId);
    if (idx >= 0) {
      filters.tags.splice(idx, 1);

      // if we just unchecked a race, also uncheck its subraces
      const tagData = tagService.get(tagId);
      if (tagData?.category === TAG_CATEGORY.RACE) {
        const subraces = new Set(tagService.getSubraces(tagId).map(t => t.id));
        filters.tags = filters.tags.filter(t => !subraces.has(t));
      }
    } else {
      filters.tags.push(tagId);
    }
  }
}
