/**
 * @fileoverview Actor and prototype-token creation; random token rolls on `preCreateToken`.
 */

import { MODULE_ID, FLAGS, TOKEN_MODE, RANDOM_PORTRAIT_PATH } from '../constants/index.mjs';
import { GENDER_TAGS, AGE_TAGS, TAG_CATEGORY } from '../constants/tags.mjs';
import { logger, getFlag } from '../utils/index.mjs';
import { getDefaultActorType } from '../utils/system.mjs';
import { imagePicker } from './image-picker.mjs';
import { nameGenerator } from './name-generator.mjs';
import { tagIndex } from './tag-index.mjs';
import { tag } from './tag.mjs';

class ActorService {
  /**
   * Create or update an actor from Hero Box form data.
   * @param {object} input Form payload (mode, tags, images, etc.).
   * @param {Actor|null} [existingActor]
   * @param {string|null} [folderId]
   * @returns {Promise<{ actor: Actor, isNew: boolean }|null>}
   */
  async createOrUpdate(input, existingActor = null, folderId = null) {
    logger.debug('Creating/updating actor with input:', input);

    const isImageMode = input.selectionMode === 'image';
    let imageData = null;
    let tagGroups = {};

    if (isImageMode) {
      if (!input.selectedImageUuids?.length) {
        ui.notifications.warn(game.i18n.localize('cs-hero-box.errors.noImagesSelected'));
        return null;
      }

      const randomIndex = Math.floor(Math.random() * input.selectedImageUuids.length);
      const selectedUuid = input.selectedImageUuids[randomIndex];
      imageData = await imagePicker.getByUuid(selectedUuid);

      if (!imageData) {
        ui.notifications.warn(game.i18n.localize('cs-hero-box.errors.noImagesFound'));
        return null;
      }
    } else {
      tagGroups = this.#buildTagGroups(input);
      logger.debug('Built tag groups:', tagGroups);

      imageData = imagePicker.pickRandomByGroups(tagGroups);

      if (!imageData) {
        logger.warn('No images found for tag groups:', tagGroups);
        ui.notifications.warn(game.i18n.localize('cs-hero-box.errors.noImagesFound'));
        return null;
      }
    }

    const isRandom = input.mode === TOKEN_MODE.RANDOM;
    const sourceActorData = await this.#getSourceActorData(input.sourceActor?.uuid);

    const actorData = await this.#prepareActorData({
      input,
      tagGroups,
      isRandom,
      isImageMode,
      imageData,
      sourceActorData,
      folderId,
      existingActor,
    });

    let actorDoc;
    let isNew = false;

    if (existingActor) {
      await existingActor.update(actorData);
      actorDoc = existingActor;
      logger.info(`Updated actor: ${actorDoc.name}`);
    } else {
      actorDoc = await Actor.create(actorData);
      isNew = true;
      logger.info(`Created actor: ${actorDoc.name}`);
    }

    await actorDoc.setFlag(MODULE_ID, FLAGS.PREV_FORM_VALUES, input);

    ui.notifications.info(game.i18n.format('cs-hero-box.actor.created', { name: actorDoc.name }));

    return { actor: actorDoc, isNew };
  }

  /**
   * Apply rolled token texture, ring, name, and unlinked delta for random-mode actors.
   * @param {TokenDocument} token
   * @returns {boolean} Whether this token was updated.
   */
  applyRandomTokenImage(token) {
    const actorDoc = game.actors.get(token.actorId);
    if (!actorDoc) return false;

    const criteria = getFlag(actorDoc, FLAGS.TOKEN_CRITERIA);

    if (!criteria || criteria.mode !== TOKEN_MODE.RANDOM) {
      return false;
    }

    const isImageMode = criteria.selectionMode === 'image';
    let imageData = null;

    if (isImageMode) {
      const imageUuids = criteria.selectedImageUuids ?? [];
      if (!imageUuids.length) {
        logger.warn('No images in criteria for image mode');
        return false;
      }

      const randomIndex = Math.floor(Math.random() * imageUuids.length);
      const selectedUuid = imageUuids[randomIndex];

      const allImages = tagIndex.findByTags([]);
      const found = allImages.find(img => img.uuid === selectedUuid);

      if (!found) {
        logger.warn('Selected image not found:', selectedUuid);
        return false;
      }

      imageData = {
        tokenUrl: found.tokenUrl,
        portraitUrl: found.portraitUrl,
        scale: found.scale,
        dynamicRing: found.dynamicRing,
        tags: found.tags,
      };
    } else {
      logger.debug('Applying random token for:', actorDoc.name, 'with criteria:', criteria);

      const tagGroups = criteria.tagGroups ?? this.#tagsToGroups(criteria.tags ?? []);
      imageData = imagePicker.pickRandomByGroups(tagGroups);

      if (!imageData) {
        logger.warn('No image found for tag groups:', tagGroups);
        return false;
      }
    }

    const nicknameChance = (criteria.nicknameChance ?? 50) / 100;
    const nicknameOnlyChance = (criteria.nicknameOnlyChance ?? 0) / 100;
    const name = nameGenerator.generate(imageData.tags, nicknameChance, nicknameOnlyChance);
    const scale = imageData.scale ?? 1;

    token.updateSource({
      name,
      displayName: CONST.TOKEN_DISPLAY_MODES.HOVER,
      texture: {
        src: imageData.tokenUrl,
        scaleX: scale,
        scaleY: scale,
      },
    });

    if (imageData.dynamicRing) {
      token.updateSource({
        ring: {
          enabled: true,
          effects: token.ring?.effects ?? 1,
          subject: {
            texture: imageData.tokenUrl,
            scale: scale,
          },
        },
      });
    }

    if (!token.actorLink) {
      token.updateSource({
        delta: {
          name: name,
          img: imageData.portraitUrl,
        },
      });
    }

    logger.debug('Token updated:', { name, image: imageData.tokenUrl });
    return true;
  }

  /**
   * @param {Actor} actorDoc
   * @returns {string[]}
   */
  getTags(actorDoc) {
    const criteria = getFlag(actorDoc, FLAGS.TOKEN_CRITERIA);
    return criteria?.tags ?? [];
  }

  /**
   * @param {object} input Actor form state (race, subrace, gender, age, role).
   * @returns {Record<string, string[]>}
   */
  #buildTagGroups(input) {
    const groups = {
      race: [],
      subrace: [],
      gender: input.gender ?? [],
      age: input.age ?? [],
      role: input.role ?? [],
      other: input.other ?? [],
    };

    if (input.race?.length) {
      groups.race = [...input.race];
    }

    if (input.subrace) {
      for (const [_, subraces] of Object.entries(input.subrace)) {
        if (Array.isArray(subraces) && subraces.length > 0) {
          groups.subrace.push(...subraces);
        }
      }
    }

    return groups;
  }

  /**
   * @param {string[]} tags Flat list from stored token criteria.
   * @returns {Record<string, string[]>}
   */
  #tagsToGroups(tags) {
    const groups = {
      race: [],
      subrace: [],
      gender: [],
      age: [],
      role: [],
      other: [],
    };

    const genderIds = new Set(Object.values(GENDER_TAGS));
    const ageIds = new Set(Object.values(AGE_TAGS));

    for (const tagId of tags) {
      if (genderIds.has(tagId)) {
        groups.gender.push(tagId);
      } else if (ageIds.has(tagId)) {
        groups.age.push(tagId);
      } else {
        const tagData = tag.get(tagId);
        if (tagData) {
          if (tagData.category === TAG_CATEGORY.RACE) {
            groups.race.push(tagId);
          } else if (tagData.category === TAG_CATEGORY.SUBRACE) {
            groups.subrace.push(tagId);
          } else if (tagData.category === TAG_CATEGORY.ROLE) {
            groups.role.push(tagId);
          } else {
            groups.other.push(tagId);
          }
        }
      }
    }

    return groups;
  }

  /** @param {Record<string, string[]>} tagGroups */
  #flattenTagGroups(tagGroups) {
    const tags = [];
    for (const groupTags of Object.values(tagGroups)) {
      if (Array.isArray(groupTags)) {
        tags.push(...groupTags);
      }
    }
    return tags;
  }

  /**
   * @param {object} params
   * @returns {Promise<object>} `Actor` create/update payload.
   */
  async #prepareActorData({ input, tagGroups, isRandom, isImageMode, imageData, sourceActorData, folderId, existingActor }) {
    const actorData = {};

    if (!existingActor) {
      actorData.type = getDefaultActorType();
      actorData.folder = folderId;
    }

    if (sourceActorData) {
      Object.assign(actorData, sourceActorData);
    }

    const flatTags = this.#flattenTagGroups(tagGroups);

    actorData.flags = {
      [MODULE_ID]: {
        [FLAGS.TOKEN_CRITERIA]: {
          selectionMode: input.selectionMode ?? 'tag',
          tagGroups,
          tags: flatTags,
          selectedImageUuids: input.selectedImageUuids ?? [],
          mode: isRandom ? TOKEN_MODE.RANDOM : TOKEN_MODE.FIXED,
          fixedImageUuid: null,
          nicknameChance: input.nicknameChance ?? 50,
          nicknameOnlyChance: input.nicknameOnlyChance ?? 0,
        },
      },
    };

    if (isRandom) {
      actorData.name = this.#generatePlaceholderName(tagGroups, isImageMode);
      actorData.img = RANDOM_PORTRAIT_PATH;

      actorData.prototypeToken = {
        displayName: CONST.TOKEN_DISPLAY_MODES.HOVER,
        actorLink: false,
      };
    } else {
      const imageTags = imageData.tags ?? [];
      const nicknameChance = (input.nicknameChance ?? 50) / 100;
      const nicknameOnlyChance = (input.nicknameOnlyChance ?? 0) / 100;
      const name = nameGenerator.generate(imageTags, nicknameChance, nicknameOnlyChance);
      const scale = imageData.scale ?? 1;

      actorData.name = name;
      actorData.img = imageData.portraitUrl;

      actorData.prototypeToken = {
        name,
        displayName: CONST.TOKEN_DISPLAY_MODES.HOVER,
        actorLink: true,
        texture: {
          src: imageData.tokenUrl,
          scaleX: scale,
          scaleY: scale,
        },
      };

      if (imageData.dynamicRing) {
        actorData.prototypeToken.ring = {
          enabled: true,
          effects: 1,
          subject: {
            texture: imageData.tokenUrl,
            scale: scale,
          },
        };
      }

      actorData.flags[MODULE_ID][FLAGS.TOKEN_CRITERIA].fixedImageUuid = imageData.uuid;
    }

    return actorData;
  }

  /**
   * @param {Record<string, string[]>} tagGroups
   * @param {boolean} [isImageMode]
   * @returns {string}
   */
  #generatePlaceholderName(tagGroups, isImageMode = false) {
    if (isImageMode) {
      const baseName = game.i18n.localize('cs-hero-box.actor.randomFromImages');
      return this.#uniqueName(baseName);
    }

    const parts = [game.i18n.localize('cs-hero-box.actor.randomPrefix')];

    if (tagGroups.gender?.length === 1) {
      const genderLabel = game.i18n.localize(`cs-hero-box.gender.${tagGroups.gender[0]}`);
      parts.push(genderLabel);
    }

    if (tagGroups.race?.length) {
      const raceLabels = tagGroups.race.map(r => tag.getLabel(r));
      parts.push(raceLabels.join('/'));
    }

    if (tagGroups.subrace?.length) {
      const subraceLabels = tagGroups.subrace.map(s => tag.getLabel(s));
      parts.push(`(${subraceLabels.join('/')})`);
    }

    if (tagGroups.role?.length) {
      const roleLabels = tagGroups.role.map(r => tag.getLabel(r));
      parts.push(roleLabels.join('/'));
    }

    const baseName = parts.join(' ');
    return this.#uniqueName(baseName);
  }

  /**
   * @param {string} baseName
   * @returns {string} Unique name among `game.actors`.
   */
  #uniqueName(baseName) {
    const escapedName = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escapedName}(?: \\((\\d+)\\))?$`);

    let maxNum = 0;
    let hasExact = false;

    for (const actorDoc of game.actors) {
      const match = actorDoc.name.match(regex);
      if (match) {
        if (match[1]) {
          maxNum = Math.max(maxNum, parseInt(match[1], 10));
        } else {
          hasExact = true;
        }
      }
    }

    if (!hasExact && maxNum === 0) {
      return baseName;
    }

    return `${baseName} (${maxNum + 1})`;
  }

  /**
   * @param {string|undefined} actorUuid
   * @returns {Promise<object|null>} Cloned actor data without id/folder/token/module flags.
   */
  async #getSourceActorData(actorUuid) {
    if (!actorUuid) return null;

    try {
      const actorDoc = await fromUuid(actorUuid);
      if (!actorDoc) return null;

      const data = foundry.utils.deepClone(actorDoc.toObject());

      delete data._id;
      delete data.folder;
      delete data.prototypeToken;
      delete data.flags?.[MODULE_ID];

      return data;
    } catch (error) {
      logger.warn('Failed to get source actor data:', error);
      return null;
    }
  }
}

/** Singleton actor service. */
export const actor = new ActorService();
