export const TAG_CATEGORY = Object.freeze({
  RACE: 'race',
  SUBRACE: 'subrace',
  ROLE: 'role',
  OTHER: 'other',
});

export const GENDER_TAGS = Object.freeze({
  MALE: 'm',
  FEMALE: 'f',
});

export const AGE_TAGS = Object.freeze({
  CHILD: 'c',
  TEEN: 't',
  YOUNG: 'y',
  ADULT: 'a',
  OLD: 'o',
});

export const BUILTIN_TAGS = Object.freeze([
  ...Object.values(GENDER_TAGS),
  ...Object.values(AGE_TAGS),
]);

export function isBuiltinTag(tagId) {
  return BUILTIN_TAGS.includes(tagId);
}