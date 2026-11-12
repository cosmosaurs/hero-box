**
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
   * Ephemeral per-scene sets of images/names rolled during the current synchronous batch
   * (e.g. `Scene.createEmbeddedDocuments('Token', [...])`) before tokens land in `scene.tokens`.
   * @type {Map<string, { uuids: Set<string>, urls: Set<string>, names: Set<string>, scheduled: boolean }>}
   */
  #inflightByScene = new Map();

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

    const notifKey = isNew ? 'cs-hero-box.actor.created' : 'cs-hero-box.actor.updated';
    ui.notifications.info(game.i18n.format(notifKey, { name: actorDoc.name }));

    return { actor: actorDoc, isNew };
  }

  /**
   * Apply rolled token texture, ring, name, and unlinked delta for random-mode actors.
   * Skips tokens that were already rolled (e.g. `Ctrl+C` / `Ctrl+V` copy-paste or cross-scene move)
   * unless `options.csHeroBoxForceRoll` is true, and avoids duplicating images/names already on the target scene.
   * @param {TokenDocument} token
   * @param {object} [createOptions]
   * @returns {boolean} Whether this token was updated.
   */
  applyRandomTokenImage(token, createOptions = {}) {
    if (createOptions?.csHeroBoxSkipRandom) return false;

    const actorDoc = game.actors?.get(token.actorId) ?? token.baseActor ?? token.actor;
    if (!actorDoc) return false;

    const forceRoll = Boolean(createOptions?.csHeroBoxForceRoll);
    if (!forceRoll) {
      if (getFlag(token, FLAGS.TOKEN_ROLLED)) {
        logger.debug('Skipping random roll for already-rolled token (copy/paste or move):', token.name);
        return false;
      }

      // Legacy fallback: pre-existing unlinked token copied/teleported with customized delta portrait & texture
      const protoSrc = actorDoc.prototypeToken?.texture?.src;
      if (
        !token.actorLink
        && token.delta?.img
        && token.texture?.src
        && token.texture.src !== protoSrc
        && token.texture.src !== RANDOM_PORTRAIT_PATH
      ) {
        logger.debug('Skipping random roll for customized token:', token.name);
        return false;
      }
    }

    const { criteria, fromCompendiumSource } = this.resolveCriteria(actorDoc);
    if (!criteria) {
      return false;
    }

    if (criteria.mode !== TOKEN_MODE.RANDOM) {
      if (fromCompendiumSource && criteria.mode === TOKEN_MODE.FIXED && criteria.fixedImageUuid) {
        return this.#applyFixedCompendiumImage(token, criteria.fixedImageUuid);
      }
      return false;
    }

    const scene = token.parent?.documentName === 'Scene' ? token.parent : canvas?.scene ?? null;
    const { usedUuids, usedUrls, usedNames } = this.#collectSceneUsedState(scene, token.id);

    const imageData = this.#rollImageForCriteria(criteria, { usedUuids, usedUrls });
    if (!imageData) {
      return false;
    }

    const nicknameChance = (criteria.nicknameChance ?? 50) / 100;
    const nicknameOnlyChance = (criteria.nicknameOnlyChance ?? 0) / 100;
    const noLastNameChance = (criteria.noLastNameChance ?? 0) / 100;

    const name = this.#resolveTokenName({
      imageTags: imageData.tags ?? [],
      nicknameChance,
      nicknameOnlyChance,
      noLastNameChance,
      fallbackName: actorDoc.prototypeToken?.name || actorDoc.name,
      usedNames,
    });

    this.#recordInflight(scene?.id, imageData, name);

    const scale = imageData.scale ?? 1;

    token.updateSource({
      name,
      actorLink: false,
      displayName: CONST.TOKEN_DISPLAY_MODES.HOVER,
      texture: {
        src: imageData.tokenUrl,
        scaleX: scale,
        scaleY: scale,
      },
      flags: {
        [MODULE_ID]: {
          [FLAGS.TOKEN_ROLLED]: true,
          [FLAGS.ROLLED_IMAGE_UUID]: imageData.uuid ?? null,
        },
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
    } else {
      token.updateSource({
        ring: {
          enabled: false,
        },
      });
    }

    if (!token.actorLink) {
      token.updateSource({
        delta: {
          name,
          img: imageData.portraitUrl,
        },
      });
    }

    logger.debug('Token updated:', { name, image: imageData.tokenUrl, fromCompendiumSource });
    return true;
  }

  /**
   * Reroll an already-placed scene token's appearance and/or name (for macros & UI actions).
   * @param {Token|TokenDocument|string} tokenOrId Placeable `Token`, `TokenDocument`, token ID on active scene, or UUID.
   * @param {{ rerollImage?: boolean, rerollName?: boolean, deduplicateScene?: boolean, criteria?: object }} [options]
   * @returns {Promise<{ token: TokenDocument, name: string, imageData: object|null }|null>}
   */
  async rerollToken(tokenOrId, options = {}) {
    const tokenDoc = await this.#resolveTokenDocument(tokenOrId);
    if (!tokenDoc) {
      logger.warn('rerollToken: token not found', tokenOrId);
      return null;
    }

    const {
      rerollImage = true,
      rerollName = true,
      deduplicateScene = true,
      criteria: customCriteria = null,
    } = options;

    if (!rerollImage && !rerollName) return null;

    const actorDoc = tokenDoc.actor ?? game.actors?.get(tokenDoc.actorId);
    const criteria = customCriteria ?? (actorDoc ? this.getEffectiveCriteria(actorDoc) : null);
    if (!criteria) {
      logger.warn('rerollToken: token actor has no Hero Box criteria', tokenDoc.name);
      return null;
    }

    const scene = tokenDoc.parent?.documentName === 'Scene' ? tokenDoc.parent : canvas?.scene ?? null;
    const { usedUuids, usedUrls, usedNames } = deduplicateScene
      ? this.#collectSceneUsedState(scene, tokenDoc.id)
      : { usedUuids: new Set(), usedUrls: new Set(), usedNames: new Set() };

    const currentRolledUuid = getFlag(tokenDoc, FLAGS.ROLLED_IMAGE_UUID)
      || tagIndex.findByUrl(tokenDoc.texture?.src)?.uuid
      || null;

    let imageData = null;
    if (rerollImage) {
      if (currentRolledUuid) usedUuids.add(currentRolledUuid);
      if (tokenDoc.texture?.src) usedUrls.add(tokenDoc.texture.src);

      imageData = this.#rollImageForCriteria(criteria, {
        usedUuids,
        usedUrls,
        preferDifferentFromUuid: currentRolledUuid,
      });

      if (!imageData) return null;
    } else {
      imageData = (currentRolledUuid ? tagIndex.getByUuid(currentRolledUuid) : null)
        ?? tagIndex.findByUrl(tokenDoc.texture?.src)
        ?? null;
    }

    let name = tokenDoc.name;
    if (rerollName) {
      if (tokenDoc.name) usedNames.add(tokenDoc.name.trim().toLowerCase());
      const nicknameChance = (criteria.nicknameChance ?? 50) / 100;
      const nicknameOnlyChance = (criteria.nicknameOnlyChance ?? 0) / 100;
      const noLastNameChance = (criteria.noLastNameChance ?? 0) / 100;
      const imageTags = imageData?.tags ?? criteria.tags ?? (actorDoc ? this.getTags(actorDoc) : []);

      name = this.#resolveTokenName({
        imageTags,
        nicknameChance,
        nicknameOnlyChance,
        noLastNameChance,
        fallbackName: actorDoc?.prototypeToken?.name || actorDoc?.name || tokenDoc.name,
        usedNames,
      });
    }

    this.#recordInflight(scene?.id, rerollImage ? imageData : null, rerollName ? name : null);

    const updateData = {
      [`flags.${MODULE_ID}.${FLAGS.TOKEN_ROLLED}`]: true,
    };

    if (rerollName) {
      updateData.name = name;
    }

    if (rerollImage && imageData) {
      const scale = imageData.scale ?? 1;
      updateData[`flags.${MODULE_ID}.${FLAGS.ROLLED_IMAGE_UUID}`] = imageData.uuid ?? null;
      updateData.texture = {
        src: imageData.tokenUrl,
        scaleX: scale,
        scaleY: scale,
      };
      updateData.ring = imageData.dynamicRing
        ? {
            enabled: true,
            effects: tokenDoc.ring?.effects ?? 1,
            subject: {
              texture: imageData.tokenUrl,
              scale,
            },
          }
        : {
            enabled: false,
          };
    }

    if (!tokenDoc.actorLink) {
      const deltaUpdate = {};
      if (rerollName) deltaUpdate.name = name;
      if (rerollImage && imageData) deltaUpdate.img = imageData.portraitUrl;
      if (Object.keys(deltaUpdate).length > 0) {
        updateData.delta = deltaUpdate;
      }
    }

    await tokenDoc.update(updateData);
    return { token: tokenDoc, name, imageData };
  }

  /**
   * Look up the Compendium document or index entry referenced by `actorDoc._stats.compendiumSource`
   * (or legacy `flags.core.sourceId`) synchronously.
   * @param {Actor|null|undefined} actorDoc
   * @returns {object|null}
   */
  getCompendiumSourceEntry(actorDoc) {
    if (!actorDoc || actorDoc.pack) return null;

    const sourceUuid = actorDoc._stats?.compendiumSource || actorDoc.flags?.core?.sourceId || null;
    if (!sourceUuid || typeof sourceUuid !== 'string' || !sourceUuid.startsWith('Compendium.')) {
      return null;
    }
    if (actorDoc.uuid && actorDoc.uuid === sourceUuid) {
      return null;
    }

    // 1. Try Foundry's built-in synchronous UUID parser
    if (typeof foundry?.utils?.parseUuid === 'function') {
      try {
        const parsed = foundry.utils.parseUuid(sourceUuid);
        const pack = parsed?.collection;
        const docId = parsed?.id ?? parsed?.documentId;
        if (pack && docId) {
          const found = pack.get?.(docId) ?? pack.index?.get?.(docId) ?? null;
          if (found) return found;
        }
      } catch {
        // Fall through to manual Compendium UUID parsing
      }
    }

    // 2. Manual `Compendium.<scope>.<pack>.Actor.<id>` / `Compendium.<scope>.<pack>.<id>` lookup
    const match = sourceUuid.match(/^Compendium\.([^.]+\.[^.]+)\.(?:Actor\.)?([^.]+)$/);
    if (match) {
      const [, packId, actorId] = match;
      const pack = game.packs?.get?.(packId);
      if (pack) {
        const found = pack.get?.(actorId) ?? pack.index?.get?.(actorId) ?? null;
        if (found) return found;
      }
    }

    // 3. Fallback to global `fromUuidSync` when available
    if (typeof fromUuidSync === 'function') {
      try {
        return fromUuidSync(sourceUuid) ?? null;
      } catch {
        return null;
      }
    }

    return null;
  }

  /**
   * Resolve effective Hero in a Box criteria for an actor:
   * - If the actor is a World Actor WITHOUT `FLAGS.LOCAL_OVERRIDE` and its `CompendiumSource`
   *   has `FLAGS.TOKEN_CRITERIA`, use the `CompendiumSource` criteria.
   * - Otherwise use the actor's own `FLAGS.TOKEN_CRITERIA`.
   * @param {Actor|null|undefined} actorDoc
   * @returns {{ criteria: object|null, fromCompendiumSource: boolean, sourceEntry: object|null }}
   */
  resolveCriteria(actorDoc) {
    if (!actorDoc) {
      return { criteria: null, fromCompendiumSource: false, sourceEntry: null };
    }

    const isWorldActor = !actorDoc.pack;
    const hasLocalOverride = isWorldActor && Boolean(getFlag(actorDoc, FLAGS.LOCAL_OVERRIDE));

    if (isWorldActor && !hasLocalOverride) {
      const sourceEntry = this.getCompendiumSourceEntry(actorDoc);
      const sourceCriteria = sourceEntry ? getFlag(sourceEntry, FLAGS.TOKEN_CRITERIA) : null;
      if (sourceCriteria) {
        return {
          criteria: sourceCriteria,
          fromCompendiumSource: true,
          sourceEntry,
        };
      }
      return {
        criteria: getFlag(actorDoc, FLAGS.TOKEN_CRITERIA) ?? null,
        fromCompendiumSource: false,
        sourceEntry,
      };
    }

    return {
      criteria: getFlag(actorDoc, FLAGS.TOKEN_CRITERIA) ?? null,
      fromCompendiumSource: false,
      sourceEntry: null,
    };
  }

  /**
   * @param {Actor|null|undefined} actorDoc
   * @returns {object|null}
   */
  getEffectiveCriteria(actorDoc) {
    return this.resolveCriteria(actorDoc).criteria;
  }

  /**
   * Resolve initial form state for `ActorConfig`, respecting `CompendiumSource` inheritance
   * until `FLAGS.LOCAL_OVERRIDE` is set on the World Actor.
   * @param {Actor|null|undefined} actorDoc
   * @returns {object|null}
   */
  getEffectiveFormValues(actorDoc) {
    if (!actorDoc) return null;

    const { criteria, fromCompendiumSource, sourceEntry } = this.resolveCriteria(actorDoc);
    if (fromCompendiumSource && sourceEntry) {
      const sourceSaved = getFlag(sourceEntry, FLAGS.PREV_FORM_VALUES);
      if (sourceSaved) return sourceSaved;
      return criteria ? this.#criteriaToFormValues(criteria) : null;
    }

    const localSaved = getFlag(actorDoc, FLAGS.PREV_FORM_VALUES);
    if (localSaved) return localSaved;
    return criteria ? this.#criteriaToFormValues(criteria) : null;
  }

  /**
   * Reconstruct `ActorConfig` form values from a `TOKEN_CRITERIA` object when `PREV_FORM_VALUES` is absent.
   * @param {object|null} criteria
   * @returns {object|null}
   */
  #criteriaToFormValues(criteria) {
    if (!criteria) return null;
    const tagGroups = criteria.tagGroups ?? this.#tagsToGroups(criteria.tags ?? []);
    const subraceByParent = {};
    const raceSet = new Set(tagGroups.race ?? []);

    for (const subId of (tagGroups.subrace ?? [])) {
      const parentId = tag.get(subId)?.parentRaceId;
      if (!parentId) continue;
      raceSet.add(parentId);
      if (!subraceByParent[parentId]) subraceByParent[parentId] = [];
      subraceByParent[parentId].push(subId);
    }

    return {
      selectionMode: criteria.selectionMode ?? 'tag',
      race: [...raceSet],
      raceExclude: [...(tagGroups.raceExclude ?? [])],
      subrace: subraceByParent,
      subraceExclude: [...(tagGroups.subraceExclude ?? [])],
      gender: [...(tagGroups.gender ?? [])],
      age: [...(tagGroups.age ?? [])],
      ageExclude: [...(tagGroups.ageExclude ?? [])],
      roleGroup: [...(tagGroups.roleGroup ?? [])],
      roleGroupExclude: [...(tagGroups.roleGroupExclude ?? [])],
      role: [...(tagGroups.role ?? [])],
      roleExclude: [...(tagGroups.roleExclude ?? [])],
      other: [...(tagGroups.other ?? [])],
      otherExclude: [...(tagGroups.otherExclude ?? [])],
      mode: criteria.mode ?? TOKEN_MODE.RANDOM,
      selectedImageUuids: [...(criteria.selectedImageUuids ?? [])],
      nicknameChance: criteria.nicknameChance ?? 50,
      nicknameOnlyChance: criteria.nicknameOnlyChance ?? 0,
      noLastNameChance: criteria.noLastNameChance ?? 0,
    };
  }

  /**
   * Apply fixed-mode image from `CompendiumSource` onto a newly placed token.
   * @param {TokenDocument} token
   * @param {string} fixedImageUuid
   * @returns {boolean}
   */
  #applyFixedCompendiumImage(token, fixedImageUuid) {
    const imageData = tagIndex.getByUuid(fixedImageUuid);
    if (!imageData) return false;

    const scale = imageData.scale ?? 1;
    token.updateSource({
      texture: {
        src: imageData.tokenUrl,
        scaleX: scale,
        scaleY: scale,
      },
      ring: imageData.dynamicRing
        ? {
            enabled: true,
            effects: token.ring?.effects ?? 1,
            subject: {
              texture: imageData.tokenUrl,
              scale,
            },
          }
        : {
            enabled: false,
          },
      flags: {
        [MODULE_ID]: {
          [FLAGS.TOKEN_ROLLED]: true,
          [FLAGS.ROLLED_IMAGE_UUID]: imageData.uuid ?? null,
        },
      },
    });

    if (!token.actorLink && imageData.portraitUrl) {
      token.updateSource({
        delta: {
          img: imageData.portraitUrl,
        },
      });
    }

    return true;
  }

  /**
   * @param {Actor} actorDoc
   * @returns {string[]}
   */
  getTags(actorDoc) {
    const criteria = this.getEffectiveCriteria(actorDoc);
    return criteria?.tags ?? [];
  }

  /**
   * @param {object} input Actor form state (race, subrace, gender, age, role).
   * @returns {Record<string, string[]>}
   */
  #buildTagGroups(input) {
    const groups = {
      race: [],
      raceExclude: input.raceExclude ?? [],
      subrace: [],
      subraceExclude: input.subraceExclude ?? [],
      gender: input.gender ?? [],
      age: input.age ?? [],
      ageExclude: input.ageExclude ?? [],
      roleGroup: input.roleGroup ?? [],
      roleGroupExclude: input.roleGroupExclude ?? [],
      role: input.role ?? [],
      roleExclude: input.roleExclude ?? [],
      other: input.other ?? [],
      otherExclude: input.otherExclude ?? [],
    };

    if (input.race?.length) {
      groups.race = [...input.race];
    }

    if (input.subrace) {
      if (Array.isArray(input.subrace)) {
        groups.subrace.push(...input.subrace);
      } else {
        for (const [_, subraces] of Object.entries(input.subrace)) {
          if (Array.isArray(subraces) && subraces.length > 0) {
            groups.subrace.push(...subraces);
          }
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
      raceExclude: [],
      subrace: [],
      subraceExclude: [],
      gender: [],
      age: [],
      ageExclude: [],
      roleGroup: [],
      roleGroupExclude: [],
      role: [],
      roleExclude: [],
      other: [],
      otherExclude: [],
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
          } else if (tagData.category === TAG_CATEGORY.ROLE_GROUP) {
            groups.roleGroup.push(tagId);
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
    const excludeKeys = new Set([
      'raceExclude',
      'subraceExclude',
      'ageExclude',
      'roleGroupExclude',
      'roleExclude',
      'otherExclude',
    ]);
    const tags = [];
    for (const [key, groupTags] of Object.entries(tagGroups)) {
      if (!excludeKeys.has(key) && Array.isArray(groupTags)) {
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

    const moduleFlags = {
      [FLAGS.TOKEN_CRITERIA]: {
        selectionMode: input.selectionMode ?? 'tag',
        tagGroups,
        tags: flatTags,
        selectedImageUuids: input.selectedImageUuids ?? [],
        mode: isRandom ? TOKEN_MODE.RANDOM : TOKEN_MODE.FIXED,
        fixedImageUuid: null,
        nicknameChance: input.nicknameChance ?? 50,
        nicknameOnlyChance: input.nicknameOnlyChance ?? 0,
        noLastNameChance: input.noLastNameChance ?? 0,
      },
    };

    if (existingActor && !existingActor.pack) {
      moduleFlags[FLAGS.LOCAL_OVERRIDE] = true;
    }

    actorData.flags = foundry.utils.mergeObject(actorData.flags ?? {}, {
      [MODULE_ID]: moduleFlags,
    });

    if (isRandom) {
      if (!existingActor) {
        actorData.name = this.#generatePlaceholderName(tagGroups, isImageMode);
        actorData.img = RANDOM_PORTRAIT_PATH;
      }

      actorData.prototypeToken = {
        displayName: CONST.TOKEN_DISPLAY_MODES.HOVER,
        actorLink: false,
        flags: {
          [MODULE_ID]: {
            [`-=${FLAGS.TOKEN_ROLLED}`]: null,
            [`-=${FLAGS.ROLLED_IMAGE_UUID}`]: null,
          },
        },
      };
    } else {
      const imageTags = imageData.tags ?? [];
      const nicknameChance = (input.nicknameChance ?? 50) / 100;
      const nicknameOnlyChance = (input.nicknameOnlyChance ?? 0) / 100;
      const noLastNameChance = (input.noLastNameChance ?? 0) / 100;
      const name = nameGenerator.generate(imageTags, nicknameChance, nicknameOnlyChance, noLastNameChance);
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
      } else {
        actorData.prototypeToken.ring = {
          enabled: false,
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

    if (tagGroups.subrace?.length) {
      const subraceLabels = tagGroups.subrace.map(s => tag.getLabel(s));
      return this.#uniqueName(subraceLabels.join('/'));
    }

    if (tagGroups.race?.length) {
      const raceLabels = tagGroups.race.map(r => tag.getLabel(r));
      return this.#uniqueName(raceLabels.join('/'));
    }

    if (tagGroups.role?.length) {
      const roleLabels = tagGroups.role.map(r => tag.getLabel(r));
      return this.#uniqueName(roleLabels.join('/'));
    }

    if (tagGroups.roleGroup?.length) {
      const groupLabels = tagGroups.roleGroup.map(g => tag.getLabel(g));
      return this.#uniqueName(groupLabels.join('/'));
    }

    const baseName = game.i18n.localize('cs-hero-box.actor.randomPrefix');
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
      delete data._stats?.compendiumSource;
      delete data.flags?.core?.sourceId;
      delete data.flags?.[MODULE_ID];

      return data;
    } catch (error) {
      logger.warn('Failed to get source actor data:', error);
      return null;
    }
  }

  /**
   * Roll an image according to stored `TOKEN_CRITERIA`, preferring images not yet used on the scene.
   * @param {object} criteria
   * @param {{ usedUuids?: Set<string>, usedUrls?: Set<string>, preferDifferentFromUuid?: string|null }} [dedup]
   * @returns {object|null}
   */
  #rollImageForCriteria(criteria, dedup = {}) {
    const { usedUuids, usedUrls, preferDifferentFromUuid = null } = dedup;
    const isImageMode = criteria.selectionMode === 'image';

    if (isImageMode) {
      const imageUuids = criteria.selectedImageUuids ?? [];
      if (!imageUuids.length) {
        logger.warn('No images in criteria for image mode');
        return null;
      }

      const validEntries = imageUuids.map(uuid => tagIndex.getByUuid(uuid)).filter(Boolean);
      if (!validEntries.length) {
        logger.warn('Selected images not found in index:', imageUuids);
        return null;
      }

      const unusedEntries = validEntries.filter(img =>
        !usedUuids?.has(img.uuid)
        && !(img.tokenUrl && usedUrls?.has(img.tokenUrl))
        && !(img.portraitUrl && usedUrls?.has(img.portraitUrl))
      );

      let pool = unusedEntries.length > 0 ? unusedEntries : validEntries;
      if (unusedEntries.length === 0 && preferDifferentFromUuid && pool.length > 1) {
        const different = pool.filter(img => img.uuid !== preferDifferentFromUuid);
        if (different.length > 0) pool = different;
      }

      const found = pool[Math.floor(Math.random() * pool.length)];
      return {
        uuid: found.uuid,
        tokenUrl: found.tokenUrl,
        portraitUrl: found.portraitUrl,
        scale: found.scale,
        dynamicRing: found.dynamicRing,
        tags: found.tags,
      };
    }

    const tagGroups = criteria.tagGroups ?? this.#tagsToGroups(criteria.tags ?? []);
    const picked = imagePicker.pickRandomByGroups(tagGroups, {
      excludeUuids: usedUuids,
      excludeUrls: usedUrls,
      preferDifferentFromUuid,
    });

    if (!picked) {
      logger.warn('No image found for tag groups:', tagGroups);
      return null;
    }

    return picked;
  }

  /**
   * Gather already-used image UUIDs, texture/portrait URLs, and lowercase names on a scene.
   * @param {Scene|null} scene
   * @param {string|null} [excludeTokenId]
   */
  #collectSceneUsedState(scene, excludeTokenId = null) {
    const usedUuids = new Set();
    const usedUrls = new Set();
    const usedNames = new Set();

    if (scene?.tokens) {
      for (const t of scene.tokens) {
        if (excludeTokenId && t.id === excludeTokenId) continue;

        const rolledUuid = getFlag(t, FLAGS.ROLLED_IMAGE_UUID);
        if (rolledUuid) usedUuids.add(rolledUuid);
        if (t.texture?.src) usedUrls.add(t.texture.src);
        if (t.delta?.img) usedUrls.add(t.delta.img);

        const existingName = (t.delta?.name || t.name || '').trim().toLowerCase();
        if (existingName) usedNames.add(existingName);
      }
    }

    if (scene?.id && this.#inflightByScene.has(scene.id)) {
      const inflight = this.#inflightByScene.get(scene.id);
      for (const u of inflight.uuids) usedUuids.add(u);
      for (const url of inflight.urls) usedUrls.add(url);
      for (const n of inflight.names) usedNames.add(n);
    }

    return { usedUuids, usedUrls, usedNames };
  }

  /**
   * Track synchronous batch rolls on the same scene within the current microtask.
   * @param {string|undefined} sceneId
   * @param {object|null} imageData
   * @param {string|null} name
   */
  #recordInflight(sceneId, imageData, name) {
    if (!sceneId) return;

    let entry = this.#inflightByScene.get(sceneId);
    if (!entry) {
      entry = { uuids: new Set(), urls: new Set(), names: new Set(), scheduled: false };
      this.#inflightByScene.set(sceneId, entry);
    }

    if (imageData?.uuid) entry.uuids.add(imageData.uuid);
    if (imageData?.tokenUrl) entry.urls.add(imageData.tokenUrl);
    if (imageData?.portraitUrl) entry.urls.add(imageData.portraitUrl);
    if (name) entry.names.add(name.trim().toLowerCase());

    if (!entry.scheduled) {
      entry.scheduled = true;
      queueMicrotask(() => {
        this.#inflightByScene.delete(sceneId);
      });
    }
  }

  /**
   * Resolve a `Token`, `TokenDocument`, token ID on active scene, or UUID to a `TokenDocument`.
   * @param {Token|TokenDocument|string} tokenOrId
   * @returns {Promise<TokenDocument|null>}
   */
  async #resolveTokenDocument(tokenOrId) {
    if (!tokenOrId) return null;
    if (tokenOrId.documentName === 'Token') return tokenOrId;
    if (tokenOrId.document?.documentName === 'Token') return tokenOrId.document;
    if (typeof tokenOrId === 'string') {
      const sceneToken = canvas?.scene?.tokens?.get(tokenOrId);
      if (sceneToken) return sceneToken;
      try {
        const doc = await fromUuid(tokenOrId);
        if (doc?.documentName === 'Token') return doc;
      } catch {}
    }
    return null;
  }

  #resolveTokenName({ imageTags, nicknameChance, nicknameOnlyChance, noLastNameChance, fallbackName, usedNames = null }) {
    const fallbackPrefix = game.i18n.localize('cs-hero-box.actor.fallbackName');
    const maxAttempts = usedNames?.size ? 12 : 1;
    let firstValidGenerated = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const generated = nameGenerator.generate(imageTags, nicknameChance, nicknameOnlyChance, noLastNameChance);
      if (generated && !generated.startsWith(fallbackPrefix)) {
        if (!firstValidGenerated) firstValidGenerated = generated;
        if (!usedNames?.has(generated.trim().toLowerCase())) {
          return generated;
        }
      }
    }

    if (firstValidGenerated) {
      return firstValidGenerated;
    }

    const subraceIds = new Set();
    const raceIds = new Set();
    const roleIds = new Set();
    const roleGroupIds = new Set();

    for (const tagId of imageTags) {
      const tagData = tag.get(tagId);
      if (!tagData) continue;
      if (tagData.category === TAG_CATEGORY.SUBRACE) subraceIds.add(tagId);
      else if (tagData.category === TAG_CATEGORY.RACE) raceIds.add(tagId);
      else if (tagData.category === TAG_CATEGORY.ROLE) {
        roleIds.add(tagId);
        if (tagData.roleGroupId) roleGroupIds.add(tagData.roleGroupId);
      } else if (tagData.category === TAG_CATEGORY.ROLE_GROUP) {
        roleGroupIds.add(tagId);
      }
    }

    if (subraceIds.size > 0) {
      return tag.getLabel([...subraceIds][0]);
    }

    if (raceIds.size > 0) {
      return tag.getLabel([...raceIds][0]);
    }

    if (roleIds.size > 0) {
      return tag.getLabel([...roleIds][0]);
    }

    if (roleGroupIds.size > 0) {
      return tag.getLabel([...roleGroupIds][0]);
    }

    return fallbackName || fallbackPrefix;
  }
}

/** Singleton actor service. */
export const actor = new ActorService();
