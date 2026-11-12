**
 * @fileoverview Filename tag parsing, FilePicker wrappers, and portrait URL helpers.
 */

import { BUILTIN_TAGS } from '../constants/tags.mjs';

const BUILTIN_SHORT_TAGS = new Set(BUILTIN_TAGS);
const FOLDER_ROOT_MARKERS = new Set(['tokens', 'token', 'portraits', 'portrait']);

/**
 * @param {string} fileName
 * @param {string[]|null} [knownTagIds]
 * @returns {string[]}
 */
export function parseTagsFromFileName(fileName, knownTagIds = null) {
  const baseName = stripFileExtension(fileName).toLowerCase();

  const validTags = knownTagIds
    ? [...new Set([...BUILTIN_SHORT_TAGS, ...knownTagIds])]
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

/**
 * Normalize a storage path: strip query string, decode URI, use forward slashes, trim leading/trailing `/`.
 * @param {string} rawPath
 * @returns {string}
 */
function normalizeStoragePath(rawPath) {
  if (!rawPath) return '';
  const clean = rawPath.split('?')[0].replace(/\\/g, '/');
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    // Keep raw clean path if malformed percent encoding
  }
  return decoded.replace(/^\/+|\/+$/g, '');
}

/**
 * Return lowercase relative path without file extension (relative to `rootFolder` if provided).
 * @param {string} filePath
 * @param {string} [rootFolder='']
 * @returns {string}
 */
export function getRelativeBasePath(filePath, rootFolder = '') {
  const normFile = normalizeStoragePath(filePath);
  if (!normFile) return '';

  const normRoot = normalizeStoragePath(rootFolder);
  let rel = normFile;
  if (normRoot && normFile.toLowerCase().startsWith(`${normRoot.toLowerCase()}/`)) {
    rel = normFile.slice(normRoot.length + 1);
  }

  return stripFileExtension(rel).toLowerCase();
}

/**
 * Parse tags from relative subfolder names AND the filename.
 * Single-letter built-in tags (`m`, `f`, `c`, `t`, `y`, `a`, `o`) are matched on subfolder names
 * only when the entire folder segment equals that tag (preventing false positives like `group-a`).
 * @param {string} filePath
 * @param {string[]|null} [knownTagIds]
 * @param {string} [rootFolder='']
 * @returns {string[]}
 */
export function parseTagsFromPath(filePath, knownTagIds = null, rootFolder = '') {
  const normFile = normalizeStoragePath(filePath);
  if (!normFile) return [];

  const normRoot = normalizeStoragePath(rootFolder);
  let dirSegments = [];
  let fileName = '';

  if (normRoot && normFile.toLowerCase().startsWith(`${normRoot.toLowerCase()}/`)) {
    const rel = normFile.slice(normRoot.length + 1);
    const parts = rel.split('/').filter(Boolean);
    fileName = parts.pop() || '';
    dirSegments = parts;
  } else {
    const parts = normFile.split('/').filter(Boolean);
    fileName = parts.pop() || '';
    let markerIdx = -1;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (FOLDER_ROOT_MARKERS.has(parts[i].toLowerCase())) {
        markerIdx = i;
        break;
      }
    }
    if (markerIdx !== -1 && markerIdx + 1 < parts.length) {
      dirSegments = parts.slice(markerIdx + 1);
    }
  }

  const validTags = knownTagIds
    ? [...new Set([...BUILTIN_SHORT_TAGS, ...knownTagIds])]
    : [...BUILTIN_SHORT_TAGS];

  const multiCharTags = validTags
    .filter(t => t.length >= 2)
    .sort((a, b) => b.length - a.length);
  const singleCharMap = new Map(
    validTags.filter(t => t.length === 1).map(t => [t.toLowerCase(), t])
  );

  const detectedTags = [];

  for (const segment of dirSegments) {
    const segLower = segment.trim().toLowerCase();
    if (!segLower) continue;

    if (singleCharMap.has(segLower)) {
      detectedTags.push(singleCharMap.get(segLower));
      continue;
    }

    let remaining = segLower;
    for (const tagId of multiCharTags) {
      const tagLower = tagId.toLowerCase();
      const regex = new RegExp(`(^|[._-])${escapeRegex(tagLower)}([._-]|$)`, 'g');
      if (regex.test(remaining)) {
        detectedTags.push(tagId);
        remaining = remaining.replace(new RegExp(`(^|[._-])${escapeRegex(tagLower)}(?=[._-]|$)`, 'g'), '$1');
      }
    }
  }

  if (fileName) {
    detectedTags.push(...parseTagsFromFileName(fileName, knownTagIds));
  }

  return [...new Set(detectedTags)];
}

/** @param {string} string */
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getFilePicker() {
  return foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
}

/**
 * @param {string} current
 * @param {(path: string, picker?: object) => void} callback
 */
export function browseImage(current, callback) {
  const Picker = getFilePicker();
  new Picker({
    type: 'image',
    current: current || '',
    callback,
  }).render({ force: true });
}

/**
 * @param {string} current
 * @param {(path: string, picker?: object) => void} callback
 */
export function browseFolder(current, callback) {
  const Picker = getFilePicker();
  new Picker({
    type: 'folder',
    current: current || '',
    callback,
  }).render({ force: true });
}

/**
 * Scan a directory (and optionally its subfolders) for image files across Foundry storage sources
 * (`data`, `public`, `s3`, `forgevtt`, etc.).
 * @param {string} folderPath
 * @param {string} [activeSource='data']
 * @param {object} [browseOptions={}]
 * @param {{ recursive?: boolean }} [options={}]
 * @returns {Promise<string[]>}
 */
export async function scanFolderForImages(folderPath, activeSource = 'data', browseOptions = {}, { recursive = true } = {}) {
  const imageExtensions = new Set(['webp', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'avif']);
  const Picker = getFilePicker();

  const filterFiles = (files) => (files || []).filter(f => {
    const cleanPath = f.split('?')[0];
    const ext = cleanPath.split('.').pop()?.toLowerCase() ?? '';
    return imageExtensions.has(ext);
  });

  let sourceToTry = activeSource || 'data';
  if (!activeSource && folderPath.startsWith('https://assets.forge-vtt.com/')) {
    sourceToTry = 'forgevtt';
  }

  let effectiveSource = sourceToTry;
  let rootResult = null;

  try {
    const result = await Picker.browse(sourceToTry, folderPath, browseOptions);
    const rootFiles = filterFiles(result.files);
    const rootDirs = result.dirs || [];
    if (rootFiles.length > 0 || rootDirs.length > 0 || sourceToTry !== 'data') {
      rootResult = result;
    }
  } catch {
    // Fall through to 'public' check if 'data' failed on built-in paths
  }

  if (!rootResult && sourceToTry === 'data') {
    try {
      rootResult = await Picker.browse('public', folderPath);
      effectiveSource = 'public';
    } catch {
      return [];
    }
  }

  if (!rootResult) return [];

  const collected = [...filterFiles(rootResult.files)];
  if (!recursive) {
    return collected;
  }

  const visited = new Set([normalizeStoragePath(folderPath).toLowerCase()]);
  const queue = [...(rootResult.dirs || [])];

  while (queue.length > 0) {
    const subDir = queue.shift();
    const normSub = normalizeStoragePath(subDir).toLowerCase();
    if (!normSub || visited.has(normSub)) continue;
    visited.add(normSub);

    try {
      const subResult = await Picker.browse(effectiveSource, subDir, browseOptions);
      collected.push(...filterFiles(subResult.files));
      if (Array.isArray(subResult.dirs)) {
        for (const nestedDir of subResult.dirs) {
          const normNested = normalizeStoragePath(nestedDir).toLowerCase();
          if (normNested && !visited.has(normNested)) {
            queue.push(nestedDir);
          }
        }
      }
    } catch {
      // Skip inaccessible subfolder without failing whole import
    }
  }

  return collected;
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
  if (!filePath) return '';
  const clean = filePath.split('?')[0];
  return decodeURIComponent(clean.split('/').pop() || '');
}

/** @param {string} fileName */
export function stripFileExtension(fileName) {
  return (fileName || '').replace(/\.[^/.]+$/, '');
}
