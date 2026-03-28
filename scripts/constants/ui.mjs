/**
 * @fileoverview UI timing, name assembly, data-manager tabs, and actor-config selection modes.
 */

export const UI = Object.freeze({
  DEBOUNCE_DELAY: 300,
  NICKNAME_CHANCE: 0.5,
});

export const NAME_TYPE = Object.freeze({
  FIRST_NAME: 'firstName',
  LAST_NAME: 'lastName',
  NICKNAME: 'nickname',
});

export const NAME_TYPES = Object.freeze([
  NAME_TYPE.FIRST_NAME,
  NAME_TYPE.LAST_NAME,
  NAME_TYPE.NICKNAME,
]);

export const TAB = Object.freeze({
  IMAGES: 'images',
  NAMES: 'names',
  TAGS: 'tags',
});

export const SELECTION_MODE = Object.freeze({
  TAG: 'tag',
  IMAGE: 'image',
});