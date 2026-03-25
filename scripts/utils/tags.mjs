import { GENDER_TAGS, AGE_TAGS, TAG_CATEGORY } from '../constants/index.mjs';

const GENDER_IDS = new Set(Object.values(GENDER_TAGS));
const AGE_IDS = new Set(Object.values(AGE_TAGS));

// split a flat list of tag ids into buckets: gender, age, race, subrace, role, other
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

// filter items where each active tag group has at least one matching tag (OR within group, AND between groups)
export function filterByTagGroups(items, tagGroups, getItemTags) {
  const activeGroups = Object.values(tagGroups).filter(g => g.length > 0);

  if (activeGroups.length === 0) return items;

  return items.filter(item => {
    const itemTags = new Set(getItemTags(item));
    return activeGroups.every(group => group.some(tag => itemTags.has(tag)));
  });
}