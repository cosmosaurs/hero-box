/**
 * @fileoverview Label sorting with Russian-first ordering for mixed lists.
 */

const RUSSIAN_REGEX = /^[а-яё]/i;

/**
 * @param {{ label?: string, name?: string }|string} a
 * @param {{ label?: string, name?: string }|string} b
 * @returns {number}
 */
export function compareByLabel(a, b) {
  const aLabel = (a.label ?? a.name ?? a ?? '').toLowerCase();
  const bLabel = (b.label ?? b.name ?? b ?? '').toLowerCase();

  const aIsRussian = RUSSIAN_REGEX.test(aLabel);
  const bIsRussian = RUSSIAN_REGEX.test(bLabel);

  if (aIsRussian && !bIsRussian) return -1;
  if (!aIsRussian && bIsRussian) return 1;

  return aLabel.localeCompare(bLabel, 'ru');
}

/**
 * @template T
 * @param {T[]} items
 * @returns {T[]}
 */
export function sortByLabel(items) {
  return [...items].sort(compareByLabel);
}