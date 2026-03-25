import { GENDER_TAGS, AGE_TAGS } from '../constants/tags.mjs';

const BUILTIN_SHORT_TAGS = new Set([
  GENDER_TAGS.MALE,
  GENDER_TAGS.FEMALE,
  AGE_TAGS.CHILD,
  AGE_TAGS.ADULT,
  AGE_TAGS.OLD,
]);

// try to extract tags from a filename like "human.m.a.webp" → ["human", "m", "a"]
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

// escape special regex chars so user input doesn't break things
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// get the right filepicker class depending on foundry version
function getFilePicker() {
  return foundry.applications.apps.FilePicker.implementation ?? FilePicker;
}

// open the foundry file picker for a single image
export function browseImage(current, callback) {
  const Picker = getFilePicker();
  new Picker({
    type: 'image',
    current: current || '',
    callback,
  }).render(true);
}

// open the foundry file picker for a folder
export function browseFolder(current, callback) {
  const Picker = getFilePicker();
  new Picker({
    type: 'folder',
    current: current || '',
    callback,
  }).render(true);
}

// list all image files in a folder (webp, png, jpg, etc.)
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

// guess the portrait path from a token path by swapping /token/ → /portrait/
export function derivePortraitUrl(tokenUrl) {
  if (!tokenUrl) return '';
  if (tokenUrl.includes('/token/')) {
    return tokenUrl.replace('/token/', '/portrait/');
  }
  return tokenUrl;
}

// grab just the filename from a full path
export function getFileNameFromPath(filePath) {
  return filePath.split('/').pop();
}