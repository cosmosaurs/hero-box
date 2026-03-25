import { logger } from '../utils/index.mjs';
import { tagIndex } from './tag-index.mjs';
import { tag } from './tag.mjs';

// picks random images from the index, with weighting for race/subrace combos
class ImagePickerService {

  // main method — pick a random image matching the given tag groups
  pickRandomByGroups(tagGroups) {
    const candidates = this.#findCandidatesByGroups(tagGroups);

    if (!candidates.length) {
      logger.debug('No images found for tag groups:', tagGroups);
      return null;
    }

    return this.#toResult(this.#weightedRandom(candidates));
  }

  // find all images that match the tag groups, with special handling for race+subrace
  #findCandidatesByGroups(tagGroups) {
    const races = tagGroups.race ?? [];
    const subraces = tagGroups.subrace ?? [];

    if (races.length === 0) {
      return tagIndex.findByTagGroups(tagGroups);
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
      return tagIndex.findByTagGroups(tagGroups);
    }

    // weight each pair equally, then divide by the number of images in that pair
    const allCandidates = [];

    for (const pair of raceSubracePairs) {
      const pairGroups = {
        ...tagGroups,
        race: [pair.race],
        subrace: pair.subrace ? [pair.subrace] : [],
      };

      const candidates = tagIndex.findByTagGroups(pairGroups);

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

  // fetch a specific image by its page uuid
  async getByUuid(pageUuid) {
    const candidates = tagIndex.findByTags([]);
    const found = candidates.find(c => c.uuid === pageUuid);
    return found ? this.#toResult(found) : null;
  }

  // strip internal fields and return a clean result object
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

  // pick one item from a weighted list
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

export const imagePicker = new ImagePickerService();