import { MODULE_ID, FLAGS } from '../constants/index.mjs';
import { logger, safeFromUuid } from './index.mjs';

export const SOURCE_TYPE = Object.freeze({
  COMPENDIUM: 'compendium',
  WORLD: 'world',
});

const COMPENDIUM_PREFIX = 'Compendium.';

// figure out if a source id points to a compendium or a world journal
export function parseSourceId(sourceId) {
  if (sourceId.startsWith(COMPENDIUM_PREFIX)) {
    return {
      type: SOURCE_TYPE.COMPENDIUM,
      id: sourceId,
      packId: sourceId.replace(COMPENDIUM_PREFIX, ''),
    };
  }

  return {
    type: SOURCE_TYPE.WORLD,
    id: sourceId,
    packId: null,
  };
}

// load all journal pages from a source (compendium or world journal)
export async function getSourcePages(sourceId) {
  const parsed = parseSourceId(sourceId);

  try {
    if (parsed.type === SOURCE_TYPE.COMPENDIUM) {
      return await getCompendiumPages(parsed.packId);
    }

    const journal = await safeFromUuid(sourceId);
    if (!journal || !(journal instanceof JournalEntry)) {
      return [];
    }

    return Array.from(journal.pages);
  } catch (error) {
    logger.warn(`Failed to get pages from source: ${sourceId}`, error);
    return [];
  }
}

// pull all pages out of every journal in a compendium pack
async function getCompendiumPages(packId) {
  const pack = game.packs.get(packId);

  if (!pack) {
    logger.warn(`Compendium pack not found: ${packId}`);
    return [];
  }

  if (pack.documentName !== 'JournalEntry') {
    logger.warn(`Compendium pack is not JournalEntry type: ${packId}`);
    return [];
  }

  const journals = await pack.getDocuments();
  return journals.flatMap(j => Array.from(j.pages));
}

// get or create the journal we'll write new pages into
export async function getJournalForWrite(sourceId) {
  if (!sourceId) return null;

  const parsed = parseSourceId(sourceId);

  if (parsed.type === SOURCE_TYPE.COMPENDIUM) {
    return await getOrCreateCompendiumJournal(parsed.packId);
  }

  return fromUuid(sourceId);
}

// find the first journal in a compendium, or create one if empty
async function getOrCreateCompendiumJournal(packId) {
  const pack = game.packs.get(packId);

  if (!pack) {
    ui.notifications.error(game.i18n.localize('cs-hero-box.errors.packNotFound'));
    return null;
  }

  await pack.configure({ locked: false });

  const journals = await pack.getDocuments();
  let journal = journals[0];

  if (!journal) {
    journal = await JournalEntry.create({
      name: 'CS HIAB Data',
      flags: {
        [MODULE_ID]: {
          [FLAGS.IS_DATA_SOURCE]: true,
        },
      },
    }, { pack: pack.collection });
  }

  return journal;
}

// check if a world journal has any pages with our module flags
export function journalHasModuleData(journal) {
  for (const page of journal.pages) {
    const imageData = page.getFlag(MODULE_ID, FLAGS.IMAGE_DATA);
    const nameData = page.getFlag(MODULE_ID, FLAGS.NAME_DATA);
    const tagData = page.getFlag(MODULE_ID, FLAGS.TAG_DATA);

    if (imageData || nameData || tagData) {
      return true;
    }
  }
  return false;
}