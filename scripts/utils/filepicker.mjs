/**
 * @fileoverview Filename tag parsing, FilePicker wrappers, and portrait URL helpers.
 */

import { GENDER_TAGS, AGE_TAGS } from '../constants/tags.mjs';

const BUILTIN_SHORT_TAGS = new Set([
  GENDER_TAGS.MALE,
  GENDER_TAGS.FEMALE,
  AGE_TAGS.CHILD,
  AGE_TAGS.ADULT,
  AGE_TAGS.OLD,
]);

/**
 * @param {string} fileName
 * @param {string[]|null} [knownTagIds]
 * @returns {string[]}
 */
export function parseTagsFromFileName(fileName, knownTagIds = null) {
  const baseName = fileName.replace(/\.\w+$/, '').toLowerCase();

  const validTags = knownTagIds
    ? [...BUILTIN_SHORT_TAGS, ...knownTagIds]
    : [...BUILTIN_SHORT_TAGS];

  const sortedTags = validTags.sort((a, b) => b.length - a.length);

  const detectedTags = [];
  let remainingName = baseName;

  for (const tagId of sortedTags) {
    const tagLower = tagId.toLowerCase();
    const regex = new RegExp(`(^|[._-])${escapeRegex(tagLower)}([._-]|$)`, 'g');

    if (regex.test(remainingName)) {
      detectedTags.push(tagId);
      remainingName = remainingName.replace(new RegExp(`(^|[._-])${escapeRegex(tagLower)}(?=[._-]|$)`, 'g'), '$1');
    }
  }

  return [...new Set(detectedTags)];
}

/** @param {string} string */
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getFilePicker() {
  return foundry.applications.apps.FilePicker.implementation ?? FilePicker;
}

/**
 * @param {string} current
 * @param {(path: string) => void} callback
 */
export function browseImage(current, callback) {
  const Picker = getFilePicker();
  new Picker({
    type: 'image',
    current: current || '',
    callback,
  }).render(true);
}

/**
 * @param {string} current
 * @param {(path: string) => void} callback
 */
export function browseFolder(current, callback) {
  const Picker = getFilePicker();
  new Picker({
    type: 'folder',
    current: current || '',
    callback,
  }).render(true);
}

/**
 * @param {string} folderPath
 * @returns {Promise<string[]>}
 */
export async function scanFolderForImages(folderPath) {
  const imageExtensions = ['webp', 'png', 'jpg', 'jpeg', 'gif', 'svg'];
  const Picker = getFilePicker();

  try {
    const result = await Picker.browse('data', folderPath);
    return (result.files || []).filter(f => {
      const ext = f.split('.').pop().toLowerCase();
      return imageExtensions.includes(ext);
    });
  } catch {
    return [];
  }
}

/**
 * @param {string} tokenUrl
 * @returns {string}
 */
export function derivePortraitUrl(tokenUrl) {
  if (!tokenUrl) return '';
  if (tokenUrl.includes('/token/')) {
    return tokenUrl.replace('/token/', '/portrait/');
  }
  return tokenUrl;
}

/** @param {string} filePath */
export function getFileNameFromPath(filePath) {
  return filePath.split('/').pop();
}