**
 * @fileoverview Random image selection from the tag index with race/subrace weighting.
 */

import { logger } from '../utils/index.mjs';
import { tagIndex } from './tag-index.mjs';
import { tag } from './tag.mjs';

class ImagePickerService {
  /**
   * Pick a random indexed image: OR within each group, AND across groups.
   * @param {Record<string, string[]>} tagGroups
   * @param {{ excludeUuids?: Set<string>, excludeUrls?: Set<string>, preferDifferentFromUuid?: string|null }} [options]
   * @returns {{ uuid: string, tokenUrl: string, portraitUrl: string, scale: number, tags: string[], dynamicRing: boolean }|null}
   */
  pickRandomByGroups(tagGroups, options = {}) {
    const { excludeUuids, excludeUrls, preferDifferentFromUuid = null } = options;
    const hasExclusions = Boolean(excludeUuids?.size || excludeUrls?.size);

    let candidates = [];
    if (hasExclusions) {
      const isSceneExcluded = (img) => Boolean(
        excludeUuids?.has(img.uuid)
        || (img.tokenUrl && excludeUrls?.has(img.tokenUrl))
        || (img.portraitUrl && excludeUrls?.has(img.portraitUrl))
      );
      candidates = this.#findCandidatesByGroups(tagGroups, isSceneExcluded);
    }

    if (!candidates.length) {
      candidates = this.#findCandidatesByGroups(tagGroups);
      if (preferDifferentFromUuid && candidates.length > 1) {
        const different = candidates.filter(img => img.uuid !== preferDifferentFromUuid);
        if (different.length > 0) candidates = different;
      }
    }

    if (!candidates.length) {
      logger.debug('No images found for tag groups:', tagGroups);
      return null;
    }

    return this.#toResult(this.#weightedRandom(candidates));
  }

  /**
   * @param {Record<string, string[]>} tagGroups
   * @param {((img: object) => boolean)|null} [isExcluded]
   * @returns {object[]} Indexed images, possibly with `_pairWeight` for race/subrace fairness.
   */
  #findCandidatesByGroups(tagGroups, isExcluded = null) {
    if (Array.isArray(tagGroups)) {
      const excludeSet = isExcluded;
      const seen = new Map();
      for (const group of tagGroups) {
        for (const img of tagIndex.findByTags(group)) {
          if (excludeSet && excludeSet(img)) continue;
          seen.set(img.uuid, img);
        }
      }
      return [...seen.values()];
    }

    const races = tagGroups.race ?? [];
    const subraces = tagGroups.subrace ?? [];
    const roleGroups = tagGroups.roleGroup ?? [];
    const roles = tagGroups.role ?? [];

    const excludeTagSet = new Set([
      ...(tagGroups.raceExclude ?? []),
      ...(tagGroups.subraceExclude ?? []),
      ...(tagGroups.ageExclude ?? []),
      ...(tagGroups.roleGroupExclude ?? []),
      ...(tagGroups.roleExclude ?? []),
      ...(tagGroups.otherExclude ?? []),
    ]);
    for (const groupId of tagGroups.roleGroupExclude ?? []) {
      for (const childRole of tag.getRoles(groupId)) {
        excludeTagSet.add(childRole.id);
      }
    }

    const filterGroups = { ...tagGroups };
    delete filterGroups.raceExclude;
    delete filterGroups.subraceExclude;
    delete filterGroups.ageExclude;
    delete filterGroups.roleGroupExclude;
    delete filterGroups.roleExclude;
    delete filterGroups.otherExclude;

    const applyExclude = (candidates) => {
      let filtered = candidates;
      if (excludeTagSet.size > 0) {
        filtered = filtered.filter(img => !img.tags.some(t => excludeTagSet.has(t)));
      }
      if (isExcluded) {
        filtered = filtered.filter(img => !isExcluded(img));
      }
      return filtered;
    };

    if (races.length === 0 && roleGroups.length === 0 && roles.length === 0) {
      return applyExclude(tagIndex.findByTagGroups(filterGroups));
    }

    // pair each race with its selected subraces (or null if none selected for that race)
    const raceSubracePairs = [];
    if (races.length === 0) {
      raceSubracePairs.push({ race: null, subrace: null });
    } else {
      for (const raceId of races) {
        const raceSubraces = subraces.filter(s => tag.get(s)?.parentRaceId === raceId);
        if (raceSubraces.length > 0) {
          for (const subraceId of raceSubraces) {
            raceSubracePairs.push({ race: raceId, subrace: subraceId });
          }
        } else {
          raceSubracePairs.push({ race: raceId, subrace: null });
        }
      }
    }

    // build weighted role selection units across roleGroups (expanding child roles with their weights) and standalone roles
    const roleUnits = [];
    if (roleGroups.length === 0 && roles.length === 0) {
      roleUnits.push({ roleGroup: null, role: null, weight: 1 });
    } else {
      const addedRoleIds = new Set();
      for (const groupId of roleGroups) {
        const selectedChildRoles = roles.filter(rId => tag.get(rId)?.roleGroupId === groupId && !excludeTagSet.has(rId));
        if (selectedChildRoles.length > 0) {
          for (const rId of selectedChildRoles) {
            if (addedRoleIds.has(rId)) continue;
            addedRoleIds.add(rId);
            roleUnits.push({ roleGroup: null, role: rId, weight: tag.getRoleWeight(rId) });
          }
        } else {
          const allGroupChildRoles = tag.getRoles(groupId);
          const childRoleIdSet = new Set(allGroupChildRoles.map(r => r.id));
          for (const childRole of allGroupChildRoles) {
            if (excludeTagSet.has(childRole.id) || addedRoleIds.has(childRole.id)) continue;
            addedRoleIds.add(childRole.id);
            roleUnits.push({
              roleGroup: null,
              role: childRole.id,
              weight: tag.getRoleWeight(childRole.id),
            });
          }
          if (!excludeTagSet.has(groupId)) {
            roleUnits.push({
              roleGroupOnly: groupId,
              childRoleIds: childRoleIdSet,
              role: null,
              weight: 1,
            });
          }
        }
      }
      for (const rId of roles) {
        if (!addedRoleIds.has(rId) && !excludeTagSet.has(rId)) {
          addedRoleIds.add(rId);
          roleUnits.push({ roleGroup: null, role: rId, weight: tag.getRoleWeight(rId) });
        }
      }
    }

    const matchedBatches = [];

    for (const rPair of raceSubracePairs) {
      for (const rlUnit of roleUnits) {
        if (rlUnit.roleGroupOnly) {
          const pairGroups = {
            ...filterGroups,
            race: rPair.race ? [rPair.race] : [],
            subrace: rPair.subrace ? [rPair.subrace] : [],
            roleGroup: [rlUnit.roleGroupOnly],
            role: [],
          };
          const rawCandidates = tagIndex
            .findByTagGroups(pairGroups)
            .filter(img => img.tags.includes(rlUnit.roleGroupOnly) && !img.tags.some(t => rlUnit.childRoleIds.has(t)));
          const candidates = applyExclude(rawCandidates);
          if (candidates.length > 0) {
            matchedBatches.push({ candidates, weight: rlUnit.weight ?? 1 });
          }
          continue;
        }

        const pairGroups = {
          ...filterGroups,
          race: rPair.race ? [rPair.race] : [],
          subrace: rPair.subrace ? [rPair.subrace] : [],
          roleGroup: rlUnit.roleGroup ? [rlUnit.roleGroup] : [],
          role: rlUnit.role ? [rlUnit.role] : [],
        };

        const candidates = applyExclude(tagIndex.findByTagGroups(pairGroups));
        if (candidates.length > 0) {
          matchedBatches.push({ candidates, weight: rlUnit.weight ?? 1 });
        }
      }
    }

    const totalBatchWeight = matchedBatches.reduce((sum, b) => sum + b.weight, 0);
    const candidateMap = new Map();

    for (const { candidates, weight } of matchedBatches) {
      const batchShare = totalBatchWeight > 0 ? weight / totalBatchWeight : 0;
      const itemWeight = batchShare / candidates.length;
      for (const candidate of candidates) {
        const existing = candidateMap.get(candidate.uuid);
        if (existing) {
          existing._pairWeight += itemWeight;
        } else {
          candidateMap.set(candidate.uuid, {
            ...candidate,
            _pairWeight: itemWeight,
          });
        }
      }
    }

    return [...candidateMap.values()];
  }

  /**
   * @param {string} pageUuid Journal entry page uuid.
   * @returns {Promise<object|null>}
   */
  async getByUuid(pageUuid) {
    const found = tagIndex.getByUuid(pageUuid);
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