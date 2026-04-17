/**
 * @fileoverview Random image selection from the tag index with race/subrace weighting.
 */

import { logger } from '../utils/index.mjs';
import { tagIndex } from './tag-index.mjs';
import { tag } from './tag.mjs';

class ImagePickerService {
  /**
   * Pick a random indexed image: OR within each group, AND across groups.
   * @param {Record<string, string[]>} tagGroups
   * @returns {{ uuid: string, tokenUrl: string, portraitUrl: string, scale: number, tags: string[], dynamicRing: boolean }|null}
   */
  pickRandomByGroups(tagGroups) {
    const candidates = this.#findCandidatesByGroups(tagGroups);

    if (!candidates.length) {
      logger.debug('No images found for tag groups:', tagGroups);
      return null;
    }

    return this.#toResult(this.#weightedRandom(candidates));
  }

  /**
   * @param {Record<string, string[]>} tagGroups
   * @returns {object[]} Indexed images, possibly with `_pairWeight` for race/subrace fairness.
   */
  #findCandidatesByGroups(tagGroups) {
    const races = tagGroups.race ?? [];
    const subraces = tagGroups.subrace ?? [];
    const excludeTags = [
      ...(tagGroups.raceExclude ?? []),
      ...(tagGroups.subraceExclude ?? []),
      ...(tagGroups.ageExclude ?? []),
      ...(tagGroups.roleExclude ?? []),
      ...(tagGroups.otherExclude ?? []),
    ];

    const filterGroups = { ...tagGroups };
    delete filterGroups.raceExclude;
    delete filterGroups.subraceExclude;
    delete filterGroups.ageExclude;
    delete filterGroups.roleExclude;
    delete filterGroups.otherExclude;

    const applyExclude = (candidates) => {
      if (excludeTags.length === 0) return candidates;
      return candidates.filter(img => !excludeTags.some(t => img.tags.includes(t)));
    };

    if (races.length === 0) {
      return applyExclude(tagIndex.findByTagGroups(filterGroups));
    }

    // pair each race with its selected subraces (or no subrace if none selected)
    const raceSubracePairs = [];

    for (const raceId of races) {
      const raceSubraces = subraces.filter(s => {
        const tagData = tag.get(s);
        return tagData?.parentRaceId === raceId;
      });

      if (raceSubraces.length > 0) {
        for (const subraceId of raceSubraces) {
          raceSubracePairs.push({ race: raceId, subrace: subraceId });
        }
      } else {
        raceSubracePairs.push({ race: raceId, subrace: null });
      }
    }

    if (raceSubracePairs.length === 0) {
      return applyExclude(tagIndex.findByTagGroups(filterGroups));
    }

    const allCandidates = [];

    for (const pair of raceSubracePairs) {
      const pairGroups = {
        ...filterGroups,
        race: [pair.race],
        subrace: pair.subrace ? [pair.subrace] : [],
      };

      const candidates = applyExclude(tagIndex.findByTagGroups(pairGroups));

      if (candidates.length > 0) {
        const weight = 1 / raceSubracePairs.length;
        for (const candidate of candidates) {
          allCandidates.push({
            ...candidate,
            _pairWeight: weight / candidates.length,
          });
        }
      }
    }

    return allCandidates;
  }

  /**
   * @param {string} pageUuid Journal entry page uuid.
   * @returns {Promise<object|null>}
   */
  async getByUuid(pageUuid) {
    const candidates = tagIndex.findByTags([]);
    const found = candidates.find(c => c.uuid === pageUuid);
    return found ? this.#toResult(found) : null;
  }

  /** @param {object|null} image Raw index entry. */
  #toResult(image) {
    if (!image) return null;

    return {
      uuid: image.uuid,
      tokenUrl: image.tokenUrl,
      portraitUrl: image.portraitUrl,
      scale: image.scale,
      tags: image.tags,
      dynamicRing: image.dynamicRing,
    };
  }

  /**
   * @param {object[]} items Entries with `_pairWeight` or `weight`.
   * @returns {object|null}
   */
  #weightedRandom(items) {
    if (!items.length) return null;

    const hasPairWeight = items.some(item => item._pairWeight !== undefined);

    if (hasPairWeight) {
      const totalWeight = items.reduce((sum, item) => sum + (item._pairWeight ?? 0), 0);

      if (totalWeight <= 0) {
        return items[Math.floor(Math.random() * items.length)];
      }

      let random = Math.random() * totalWeight;

      for (const item of items) {
        random -= item._pairWeight ?? 0;
        if (random <= 0) return item;
      }

      return items[items.length - 1];
    }

    const totalWeight = items.reduce((sum, item) => sum + (item.weight ?? 1), 0);

    if (totalWeight <= 0) {
      return items[Math.floor(Math.random() * items.length)];
    }

    let random = Math.random() * totalWeight;

    for (const item of items) {
      random -= item.weight ?? 1;
      if (random <= 0) return item;
    }

    return items[items.length - 1];
  }
}

/** Singleton image picker. */
export const imagePicker = new ImagePickerService();