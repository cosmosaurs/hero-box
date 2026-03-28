/**
 * @fileoverview Module id, asset paths, Foundry flag keys, and default image shape.
 */

/** Foundry package / module id. */
export const MODULE_ID = 'cs-hero-box';

export const PATHS = Object.freeze({
  ASSETS: `modules/${MODULE_ID}/assets`,
  IMAGES: `modules/${MODULE_ID}/assets/images`,
  TOKENS: `modules/${MODULE_ID}/assets/images/token`,
  PORTRAITS: `modules/${MODULE_ID}/assets/images/portrait`,
  TEMPLATES: `modules/${MODULE_ID}/scripts/applications`,
});

export const FLAGS = Object.freeze({
  IMAGE_DATA: 'imageData',
  TOKEN_CRITERIA: 'tokenCriteria',
  PREV_FORM_VALUES: 'prevFormValues',
  NAME_DATA: 'nameData',
  TAG_DATA: 'tagData',
  IS_DATA_SOURCE: 'isDataSource',
});

export const PACKS = Object.freeze({
  DATA: `${MODULE_ID}.${MODULE_ID}-data`,
});

export const RANDOM_PORTRAIT_PATH = 'icons/svg/d20-highlight.svg';

export const DEFAULT_IMAGE_DATA = Object.freeze({
  tokenUrl: '',
  portraitUrl: '',
  scale: 1,
  tags: [],
  dynamicRing: true,
});