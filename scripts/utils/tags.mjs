/**
 * @fileoverview Flat tag lists ↔ category buckets; filter items by tag-group AND/OR rules.
 */

import { GENDER_TAGS, AGE_TAGS, TAG_CATEGORY } from '../constants/index.mjs';

const GENDER_IDS = new Set(Object.values(GENDER_TAGS));
const AGE_IDS = new Set(Object.values(AGE_TAGS));

/**
 * @param {string[]} tags
 * @param {{ get: (id: string) => { category?: string }|null|undefined }} tagService
 * @returns {{ gender: string[], age: string[], race: string[], subrace: string[], role: string[], other: string[] }}
 */
export function groupTagsByCategory(tags, tagService) {
  const groups = {
    gender: [],
    age: [],
    race: [],
    subrace: [],
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
 * @template T
 * @param {T[]} items
 * @param {Record<string, string[]>} tagGroups
 * @param {(item: T) => string[]} getItemTags
 * @returns {T[]}
 */
export function filterByTagGroups(items, tagGroups, getItemTags) {
  const activeGroups = Object.values(tagGroups).filter(g => g.length > 0);

  if (activeGroups.length === 0) return items;

  return items.filter(item => {
    const itemTags = new Set(getItemTags(item));
    return activeGroups.every(group => group.some(tag => itemTags.has(tag)));
  });
}