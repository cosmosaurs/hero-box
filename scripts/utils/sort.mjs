const RUSSIAN_REGEX = /^[а-яё]/i;

// compare two items by label, russian text goes first
export function compareByLabel(a, b) {
  const aLabel = (a.label ?? a.name ?? a ?? '').toLowerCase();
  const bLabel = (b.label ?? b.name ?? b ?? '').toLowerCase();

  const aIsRussian = RUSSIAN_REGEX.test(aLabel);
  const bIsRussian = RUSSIAN_REGEX.test(bLabel);

  if (aIsRussian && !bIsRussian) return -1;
  if (!aIsRussian && bIsRussian) return 1;

  return aLabel.localeCompare(bLabel, 'ru');
}

// returns a new sorted-by-label copy of the array
export function sortByLabel(items) {
  return [...items].sort(compareByLabel);
}