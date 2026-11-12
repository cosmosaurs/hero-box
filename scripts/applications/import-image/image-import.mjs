**
 * @fileoverview Bulk or single image import into a target journal with tag inference.
 */

import { MODULE_ID, FLAGS, DEFAULT_IMAGE_DATA, PATHS } from '../../constants/index.mjs';
import { logger } from '../../utils/index.mjs';
import { browseImage, browseFolder, scanFolderForImages, getFileNameFromPath, stripFileExtension, parseTagsFromFileName, parseTagsFromPath, getRelativeBasePath } from '../../utils/filepicker.mjs';
import { expandParentTags } from '../../utils/tags.mjs';
import { getJournalForWrite } from '../../utils/source.mjs';
import { tagIndex, tag } from '../../services/index.mjs';
import { BaseFormApplication } from '../base/base.mjs';

/** Import mode: single file vs folder scan. */
export const MODE = {
  SINGLE: 'single',
  FOLDER: 'folder',
};

export class ImageImport extends BaseFormApplication {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-image-import`,
    form: {
      handler: function(event, form, formData) {
        return this._onFormSubmit(event, form, formData);
      },
      closeOnSubmit: false,
    },
    window: {
      title: 'cs-hero-box.imageImport.title',
      resizable: false,
    },
    position: {
      width: 550,
      height: 'auto',
    },
    actions: {
      setMode: function(event, target) { this._onSetMode(event, target); },
      browseToken: function() { this._onBrowseToken(); },
      browsePortrait: function() { this._onBrowsePortrait(); },
      browseTokenFolder: function() { this._onBrowseTokenFolder(); },
      browsePortraitFolder: function() { this._onBrowsePortraitFolder(); },
    },
  };

  static PARTS = {
    form: {
      template: `${PATHS.TEMPLATES}/import-image/image-import.hbs`,
    },
    footer: {
      template: 'templates/generic/form-footer.hbs',
    },
  };

  #journalId = null;
  #onSave = null;
  #mode = MODE.SINGLE;

  #tokenUrl = '';
  #portraitUrl = '';
  #tokenFolder = '';
  #tokenFolderSource = 'data';
  #tokenFolderOptions = {};
  #portraitFolder = '';
  #portraitFolderSource = 'data';
  #portraitFolderOptions = {};
  #recursive = true;
  #scale = DEFAULT_IMAGE_DATA.scale;
  #dynamicRing = DEFAULT_IMAGE_DATA.dynamicRing;

  /**
   * @param {string} journalId
   * @param {string} [mode]
   * @param {function(): void} [onSave]
   */
  constructor(journalId, mode = MODE.SINGLE, onSave = null) {
    super();
    this.#journalId = journalId;
    this.#onSave = onSave;
    this.#mode = mode;
  }

  /**
   * @param {string} journalId
   * @param {string} [mode]
   * @returns {Promise<boolean>} True if import completed successfully.
   */
  static async open(journalId, mode = MODE.SINGLE) {
    const { createSingleResolvePromise } = await import('../../utils/promise.mjs');
    const { promise, resolve } = createSingleResolvePromise();

    const app = new ImageImport(journalId, mode, () => resolve(true));

    const originalClose = app.close.bind(app);
    app.close = async (opts = {}) => {
      await originalClose(opts);
      resolve(false);
    };

    app.render({ force: true });
    return promise;
  }

  get title() {
    return game.i18n.localize('cs-hero-box.imageImport.title');
  }

  /** @param {object} context @param {object} options */
  _onRender(context, options) {
    super._onRender(context, options);
    this.#bindInputs();
  }

  /** @returns {object} */
  _prepareContext(options) {
    const isSingleMode = this.#mode === MODE.SINGLE;
    const isFolderMode = this.#mode === MODE.FOLDER;

    return {
      mode: this.#mode,
      isSingleMode,
      isFolderMode,
      tokenUrl: this.#tokenUrl,
      portraitUrl: this.#portraitUrl,
      tokenFolder: this.#tokenFolder,
      portraitFolder: this.#portraitFolder,
      recursive: this.#recursive,
      scale: this.#scale,
      dynamicRing: this.#dynamicRing,
      buttons: [
        {
          type: 'submit',
          icon: isSingleMode ? 'fa-solid fa-plus' : 'fa-solid fa-file-import',
          label: isSingleMode ? 'cs-hero-box.imageImport.add' : 'cs-hero-box.imageImport.import',
        },
      ],
    };
  }

  /** @returns {Promise<boolean>} */
  async _onFormSubmit(event, form, formData) {
    this.#scale = parseFloat(formData.object.scale) || DEFAULT_IMAGE_DATA.scale;
    this.#dynamicRing = formData.object.dynamicRing ?? DEFAULT_IMAGE_DATA.dynamicRing;

    let completed = false;
    try {
      if (this.#mode === MODE.SINGLE) {
        completed = await this.#doSingleImport(formData.object);
      } else {
        completed = await this.#doFolderImport(formData.object);
      }
    } catch (error) {
      logger.error('Import failed:', error);
      ui.notifications.error(game.i18n.localize('cs-hero-box.imageImport.error'));
      return false;
    }

    if (!completed) return false;

    if (this.#onSave) this.#onSave();
    this.close();
    return false;
  }

  /** @param {object} formData @returns {Promise<boolean>} */
  async #doSingleImport(formData) {
    const tokenUrl = formData.tokenUrl?.trim() || '';
    const portraitUrl = formData.portraitUrl?.trim() || '';

    if (!tokenUrl && !portraitUrl) {
      ui.notifications.warn(game.i18n.localize('cs-hero-box.imageImport.errorNoUrl'));
      return false;
    }

    const knownTagIds = this.#getAllKnownTagIds();
    const fileName = getFileNameFromPath(portraitUrl || tokenUrl);
    const rawTags = [
      ...(tokenUrl ? parseTagsFromPath(tokenUrl, knownTagIds) : []),
      ...(portraitUrl ? parseTagsFromPath(portraitUrl, knownTagIds) : []),
      ...parseTagsFromFileName(fileName, knownTagIds),
    ];

    const { created, updated } = await this.#importImages([{
      fileName,
      tokenUrl,
      portraitUrl,
      tags: expandParentTags([...new Set(rawTags)], tag),
    }], this.#journalId);

    this.#notifyImportResult(created, updated);
    return created > 0 || updated > 0;
  }

  /** @param {object} formData @returns {Promise<boolean>} */
  async #doFolderImport(formData) {
    const tokenFolder = formData.tokenFolder?.trim() || '';
    const portraitFolder = formData.portraitFolder?.trim() || '';

    if (!tokenFolder && !portraitFolder) {
      ui.notifications.warn(game.i18n.localize('cs-hero-box.imageImport.errorNoFolder'));
      return false;
    }

    const recursive = Boolean(formData.recursive ?? this.#recursive);
    this.#recursive = recursive;

    const tokenFiles = tokenFolder
      ? await scanFolderForImages(tokenFolder, this.#tokenFolderSource, this.#tokenFolderOptions, { recursive })
      : [];
    const portraitFiles = portraitFolder
      ? await scanFolderForImages(portraitFolder, this.#portraitFolderSource, this.#portraitFolderOptions, { recursive })
      : [];

    if (!tokenFiles.length && !portraitFiles.length) {
      ui.notifications.warn(game.i18n.localize('cs-hero-box.imageImport.noImages'));
      return false;
    }

    const knownTagIds = this.#getAllKnownTagIds();
    const fileMap = this.#buildFileMap(tokenFiles, portraitFiles, knownTagIds, tokenFolder, portraitFolder);
    const { created, updated } = await this.#importImages(fileMap, this.#journalId);

    this.#notifyImportResult(created, updated);
    return created > 0 || updated > 0;
  }

  #notifyImportResult(created, updated) {
    if (created > 0) {
      ui.notifications.info(game.i18n.format('cs-hero-box.imageImport.success', { count: created }));
    }
    if (updated > 0) {
      ui.notifications.info(game.i18n.format('cs-hero-box.imageImport.updated', { count: updated }));
    }
  }

  /** Toggle single vs folder import UI. */
  _onSetMode(event, target) {
    const mode = target.dataset.mode;
    if (mode && mode !== this.#mode) {
      this.#mode = mode;
      this.render();
    }
  }

  /** Opens file picker for token image path. */
  _onBrowseToken() {
    browseImage(this.#tokenUrl, (path) => {
      this.#tokenUrl = path;
      this.render();
    });
  }

  /** Opens file picker for portrait image path. */
  _onBrowsePortrait() {
    browseImage(this.#portraitUrl, (path) => {
      this.#portraitUrl = path;
      this.render();
    });
  }

  /** Opens folder picker for token images directory. */
  _onBrowseTokenFolder() {
    browseFolder(this.#tokenFolder, (path, picker) => {
      this.#tokenFolder = path;
      this.#tokenFolderSource = picker?.activeSource || 'data';
      this.#tokenFolderOptions = picker?.source?.bucket ? { bucket: picker.source.bucket } : {};
      this.render();
    });
  }

  /** Opens folder picker for portrait images directory. */
  _onBrowsePortraitFolder() {
    browseFolder(this.#portraitFolder, (path, picker) => {
      this.#portraitFolder = path;
      this.#portraitFolderSource = picker?.activeSource || 'data';
      this.#portraitFolderOptions = picker?.source?.bucket ? { bucket: picker.source.bucket } : {};
      this.render();
    });
  }

  /** Sync form fields to instance state; re-render on URL changes. */
  #bindInputs() {
    const inputs = {
      'input[name="tokenUrl"]': (v) => this.#tokenUrl = v,
      'input[name="portraitUrl"]': (v) => this.#portraitUrl = v,
      'input[name="tokenFolder"]': (v) => {
        this.#tokenFolder = v;
        this.#tokenFolderSource = 'data';
        this.#tokenFolderOptions = {};
      },
      'input[name="portraitFolder"]': (v) => {
        this.#portraitFolder = v;
        this.#portraitFolderSource = 'data';
        this.#portraitFolderOptions = {};
      },
      'input[name="scale"]': (v) => this.#scale = parseFloat(v) || DEFAULT_IMAGE_DATA.scale,
    };

    for (const [selector, setter] of Object.entries(inputs)) {
      const input = this.querySelector(selector);
      if (input) {
        this.addEvent(input, 'change', (e) => {
          setter(e.target.value);
          if (selector.includes('Url')) {
            this.render();
          }
        });
      }
    }

    const dynamicRingCheckbox = this.querySelector('input[name="dynamicRing"]');
    if (dynamicRingCheckbox) {
      this.addEvent(dynamicRingCheckbox, 'change', (e) => {
        this.#dynamicRing = e.target.checked;
      });
    }

    const recursiveCheckbox = this.querySelector('input[name="recursive"]');
    if (recursiveCheckbox) {
      this.addEvent(recursiveCheckbox, 'change', (e) => {
        this.#recursive = e.target.checked;
      });
    }
  }

  /** @returns {string[]} */
  #getAllKnownTagIds() {
    const allTags = tag.getAll();
    return allTags.map(t => t.id);
  }

  /**
   * Pair token and portrait files by relative path (with unique-basename fallback when one folder is flat)
   * and infer tags from subfolder segments + filename.
   * @param {string[]} tokenFiles
   * @param {string[]} portraitFiles
   * @param {string[]} knownTagIds
   * @param {string} [tokenFolder='']
   * @param {string} [portraitFolder='']
   * @returns {object[]}
   */
  #buildFileMap(tokenFiles, portraitFiles, knownTagIds, tokenFolder = '', portraitFolder = '') {
    const tokenByRel = new Map();
    for (const f of tokenFiles) {
      const relKey = getRelativeBasePath(f, tokenFolder);
      if (relKey) tokenByRel.set(relKey, f);
    }

    const portraitByRel = new Map();
    for (const f of portraitFiles) {
      const relKey = getRelativeBasePath(f, portraitFolder);
      if (relKey) portraitByRel.set(relKey, f);
    }

    const pairs = [];
    const pairedTokenRels = new Set();
    const pairedPortraitRels = new Set();

    // 1. Exact relative-path match (preserves subfolder hierarchy, avoids collisions like human/01 vs elf/01)
    for (const [relKey, tokenUrl] of tokenByRel) {
      if (portraitByRel.has(relKey)) {
        pairs.push({ tokenUrl, portraitUrl: portraitByRel.get(relKey) });
        pairedTokenRels.add(relKey);
        pairedPortraitRels.add(relKey);
      }
    }

    // 2. Unique-basename fallback for remaining unpaired files (e.g. subfolders in tokens, flat portraits)
    const remainingTokens = [...tokenByRel.entries()].filter(([k]) => !pairedTokenRels.has(k));
    const remainingPortraits = [...portraitByRel.entries()].filter(([k]) => !pairedPortraitRels.has(k));

    const tokenByBase = new Map();
    for (const [relKey, url] of remainingTokens) {
      const base = stripFileExtension(getFileNameFromPath(url)).toLowerCase();
      if (!tokenByBase.has(base)) tokenByBase.set(base, []);
      tokenByBase.get(base).push({ relKey, url });
    }

    const portraitByBase = new Map();
    for (const [relKey, url] of remainingPortraits) {
      const base = stripFileExtension(getFileNameFromPath(url)).toLowerCase();
      if (!portraitByBase.has(base)) portraitByBase.set(base, []);
      portraitByBase.get(base).push({ relKey, url });
    }

    for (const [base, tEntries] of tokenByBase) {
      const pEntries = portraitByBase.get(base);
      if (tEntries.length === 1 && pEntries?.length === 1) {
        pairs.push({ tokenUrl: tEntries[0].url, portraitUrl: pEntries[0].url });
        pairedTokenRels.add(tEntries[0].relKey);
        pairedPortraitRels.add(pEntries[0].relKey);
      }
    }

    // 3. Unpaired single-sided files
    for (const [relKey, tokenUrl] of remainingTokens) {
      if (!pairedTokenRels.has(relKey)) {
        pairs.push({ tokenUrl, portraitUrl: '' });
      }
    }
    for (const [relKey, portraitUrl] of remainingPortraits) {
      if (!pairedPortraitRels.has(relKey)) {
        pairs.push({ tokenUrl: '', portraitUrl });
      }
    }

    return pairs.map(({ tokenUrl, portraitUrl }) => {
      const fileName = getFileNameFromPath(portraitUrl || tokenUrl);
      const rawTags = [
        ...(tokenUrl ? parseTagsFromPath(tokenUrl, knownTagIds, tokenFolder) : []),
        ...(portraitUrl ? parseTagsFromPath(portraitUrl, knownTagIds, portraitFolder) : []),
      ];
      return {
        fileName,
        tokenUrl,
        portraitUrl,
        tags: expandParentTags([...new Set(rawTags)], tag),
      };
    });
  }

  /**
   * @param {object[]} fileMap
   * @param {string} journalId
   * @returns {Promise<{ created: number, updated: number }>}
   */
  async #importImages(fileMap, journalId) {
    const journal = await getJournalForWrite(journalId);
    if (!journal) return { created: 0, updated: 0 };

    const toCreate = [];
    const toUpdate = [];
    let createdCount = 0;
    let updatedCount = 0;

    for (const file of fileMap) {
      const existing = tagIndex.findByUrl(file.tokenUrl) || tagIndex.findByUrl(file.portraitUrl);

      if (existing) {
        toUpdate.push({ existing, data: file });
      } else {
        toCreate.push(file);
      }
    }

    for (const { existing, data } of toUpdate) {
      try {
        const page = await fromUuid(existing.uuid);
        if (page) {
          const currentData = page.getFlag(MODULE_ID, FLAGS.IMAGE_DATA) ?? {};
          const newImageData = {
            ...currentData,
            tokenUrl: data.tokenUrl,
            portraitUrl: data.portraitUrl,
            tags: data.tags,
            scale: this.#scale,
            dynamicRing: this.#dynamicRing,
          };
          await page.setFlag(MODULE_ID, FLAGS.IMAGE_DATA, newImageData);
          tagIndex.updateImage(page.uuid, newImageData);
          updatedCount++;
        }
      } catch (error) {
        logger.warn(`Failed to update image ${existing.uuid}:`, error);
      }
    }

    if (toCreate.length > 0) {
      const pages = toCreate.map(data => ({
        name: data.fileName,
        type: 'image',
        src: data.portraitUrl || data.tokenUrl,
        flags: {
          [MODULE_ID]: {
            [FLAGS.IMAGE_DATA]: {
              tokenUrl: data.tokenUrl,
              portraitUrl: data.portraitUrl,
              scale: this.#scale,
              tags: data.tags,
              dynamicRing: this.#dynamicRing,
            },
          },
        },
      }));

      try {
        const createdPages = await journal.createEmbeddedDocuments('JournalEntryPage', pages);

        for (const page of createdPages) {
          const imageData = page.getFlag(MODULE_ID, FLAGS.IMAGE_DATA);
          if (imageData) {
            tagIndex.addImage(page.uuid, imageData, journalId);
            createdCount++;
          }
        }
      } catch (error) {
        logger.error('Failed to create pages:', error);
      }
    }

    return { created: createdCount, updated: updatedCount };
  }
}