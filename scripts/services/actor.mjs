import { MODULE_ID, FLAGS, TOKEN_MODE, RANDOM_PORTRAIT_PATH } from '../constants/index.mjs';
import { GENDER_TAGS, AGE_TAGS, TAG_CATEGORY } from '../constants/tags.mjs';
import { logger, getFlag } from '../utils/index.mjs';
import { getDefaultActorType } from '../utils/system.mjs';
import { imagePicker } from './image-picker.mjs';
import { nameGenerator } from './name-generator.mjs';
import { tagIndex } from './tag-index.mjs';
import { tag } from './tag.mjs';

// handles creating and updating actors with random/fixed images and names
class ActorService {

  // main entry point — create a new actor or update an existing one
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

  // called on preCreateToken — rolls a new random image/name for unlinked tokens
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

    const name = nameGenerator.generate(imageData.tags);
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

  // get the tags stored on an actor from previous generation
  getTags(actorDoc) {
    const criteria = getFlag(actorDoc, FLAGS.TOKEN_CRITERIA);
    return criteria?.tags ?? [];
  }

  // convert form input into the tag groups format we use for filtering
  #buildTagGroups(input) {
    const groups = {
      race: [],
      subrace: [],
      gender: input.gender ?? [],
      age: input.age ?? [],
      role: input.role ?? [],
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

  // reverse operation — convert a flat tag array back into groups
  #tagsToGroups(tags) {
    const groups = {
      race: [],
      subrace: [],
      gender: [],
      age: [],
      role: [],
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
          }
        }
      }
    }

    return groups;
  }

  // squash all tag groups into a single flat array
  #flattenTagGroups(tagGroups) {
    const tags = [];
    for (const groupTags of Object.values(tagGroups)) {
      if (Array.isArray(groupTags)) {
        tags.push(...groupTags);
      }
    }
    return tags;
  }

  // build the full actor data object ready for Actor.create() or actor.update()
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
      const name = nameGenerator.generate(imageTags);
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

  // make a descriptive name like "Random Male Elf" for random-mode actors
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

  // append (1), (2), etc. if an actor with this name already exists
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

  // load and strip down actor data for use as a template
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

export const actor = new ActorService();
