**
 * @fileoverview Flat tag lists ↔ category buckets; filter items by tag-group AND/OR rules.
 */

import { GENDER_TAGS, AGE_TAGS, TAG_CATEGORY } from '../constants/index.mjs';

const GENDER_IDS = new Set(Object.values(GENDER_TAGS));
const AGE_IDS = new Set(Object.values(AGE_TAGS));

/**
 * @param {string[]} tags
 * @param {{ get: (id: string) => { category?: string }|null|undefined }} tagService
 * @returns {{ gender: string[], age: string[], race: string[], subrace: string[], roleGroup: string[], role: string[], other: string[] }}
 */
export function groupTagsByCategory(tags, tagService) {
  const groups = {
    gender: [],
    age: [],
    race: [],
    subrace: [],
    roleGroup: [],
    role: [],
    other: [],
  };

  for (const tagId of tags) {
    let category;

    if (GENDER_IDS.has(tagId)) {
      category = 'gender';
    } else if (AGE_IDS.has(tagId)) {
      category = 'age';
    } else {
      const tagData = tagService?.get(tagId);
      if (!tagData) {
        category = 'other';
      } else if (tagData.category === TAG_CATEGORY.RACE) {
        category = 'race';
      } else if (tagData.category === TAG_CATEGORY.SUBRACE) {
        category = 'subrace';
      } else if (tagData.category === TAG_CATEGORY.ROLE_GROUP) {
        category = 'roleGroup';
      } else if (tagData.category === TAG_CATEGORY.ROLE) {
        category = 'role';
      } else {
        category = 'other';
      }
    }

    groups[category].push(tagId);
  }

  return groups;
}

/**
 * Ensure any detected `subrace` tag also includes its parent `race` tag.
 * @param {string[]} tags
 * @param {{ get: (id: string) => { category?: string, parentRaceId?: string|null }|null|undefined }} tagService
 * @returns {string[]}
 */
export function expandParentTags(tags, tagService) {
  if (!tags?.length || !tagService) return tags ?? [];
  const result = new Set(tags);
  for (const tagId of tags) {
    const tagData = tagService.get(tagId);
    if (tagData?.category === TAG_CATEGORY.SUBRACE && tagData.parentRaceId) {
      result.add(tagData.parentRaceId);
    }
  }
  return [...result];
}

/**
 * @template T
 * @param {T[]} items
 * @param {Record<string, string[]>} tagGroups
 * @param {(item: T) => string[]} getItemTags
 * @param {{ getRoles?: (roleGroupId?: string|null) => { id: string }[] }|null} [tagService]
 * @returns {T[]}
 */
export function filterByTagGroups(items, tagGroups, getItemTags, tagService = null) {
  const expandedGroups = Object.entries(tagGroups)
    .filter(([_, g]) => g?.length > 0)
    .map(([cat, g]) => {
      if (cat === 'roleGroup' && tagService?.getRoles) {
        const expanded = new Set(g);
        for (const groupId of g) {
          for (const r of tagService.getRoles(groupId)) expanded.add(r.id);
        }
        return [...expanded];
      }
      return g;
    });

  if (expandedGroups.length === 0) return items;

  return items.filter(item => {
    const itemTags = new Set(getItemTags(item));
    return expandedGroups.every(group => group.some(t => itemTags.has(t)));
  });
}