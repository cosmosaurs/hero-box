/**
 * @fileoverview Bulk or single image import into a target journal with tag inference.
 */

import { MODULE_ID, FLAGS, DEFAULT_IMAGE_DATA, PATHS } from '../../constants/index.mjs';
import { logger } from '../../utils/index.mjs';
import { browseImage, browseFolder, scanFolderForImages, getFileNameFromPath, parseTagsFromFileName } from '../../utils/filepicker.mjs';
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
  #portraitFolder = '';
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

    app.render(true);
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

    try {
      if (this.#mode === MODE.SINGLE) {
        await this.#doSingleImport(formData.object);
      } else {
        await this.#doFolderImport(formData.object);
      }
    } catch (error) {
      logger.error('Import failed:', error);
      return false;
    }

    if (this.#onSave) this.#onSave();
    this.close();
    return false;
  }

  /** @param {object} formData @returns {Promise<void>} */
  async #doSingleImport(formData) {
    const tokenUrl = formData.tokenUrl?.trim() || '';
    const portraitUrl = formData.portraitUrl?.trim() || '';

    if (!tokenUrl && !portraitUrl) {
      throw new Error('No URL provided');
    }

    const knownTagIds = this.#getAllKnownTagIds();
    const fileName = getFileNameFromPath(portraitUrl || tokenUrl);

    await this.#importImages([{
      fileName,
      tokenUrl,
      portraitUrl,
      tags: parseTagsFromFileName(fileName, knownTagIds),
    }], this.#journalId);
  }

  /** @param {object} formData @returns {Promise<void>} */
  async #doFolderImport(formData) {
    const tokenFolder = formData.tokenFolder?.trim() || '';
    const portraitFolder = formData.portraitFolder?.trim() || '';

    if (!tokenFolder && !portraitFolder) {
      throw new Error('No folder provided');
    }

    const tokenFiles = tokenFolder ? await scanFolderForImages(tokenFolder) : [];
    const portraitFiles = portraitFolder ? await scanFolderForImages(portraitFolder) : [];

    if (!tokenFiles.length && !portraitFiles.length) {
      return;
    }

    const knownTagIds = this.#getAllKnownTagIds();
    const fileMap = this.#buildFileMap(tokenFiles, portraitFiles, knownTagIds);
    await this.#importImages(fileMap, this.#journalId);
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
    browseFolder(this.#tokenFolder, (path) => {
      this.#tokenFolder = path;
      this.render();
    });
  }

  /** Opens folder picker for portrait images directory. */
  _onBrowsePortraitFolder() {
    browseFolder(this.#portraitFolder, (path) => {
      this.#portraitFolder = path;
      this.render();
    });
  }

  /** Sync form fields to instance state; re-render on URL changes. */
  #bindInputs() {
    const inputs = {
      'input[name="tokenUrl"]': (v) => this.#tokenUrl = v,
      'input[name="portraitUrl"]': (v) => this.#portraitUrl = v,
      'input[name="tokenFolder"]': (v) => this.#tokenFolder = v,
      'input[name="portraitFolder"]': (v) => this.#portraitFolder = v,
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
  }

  /** @returns {string[]} */
  #getAllKnownTagIds() {
    const allTags = tag.getAll();
    return allTags.map(t => t.id);
  }

  /**
   * @param {string[]} tokenFiles
   * @param {string[]} portraitFiles
   * @param {string[]} knownTagIds
   * @returns {object[]}
   */
  #buildFileMap(tokenFiles, portraitFiles, knownTagIds) {
    const tokenMap = new Map(tokenFiles.map(f => [getFileNameFromPath(f), f]));
    const portraitMap = new Map(portraitFiles.map(f => [getFileNameFromPath(f), f]));

    const allFileNames = new Set([...tokenMap.keys(), ...portraitMap.keys()]);
    const result = [];

    for (const fileName of allFileNames) {
      result.push({
        fileName,
        tokenUrl: tokenMap.get(fileName) || '',
        portraitUrl: portraitMap.get(fileName) || '',
        tags: parseTagsFromFileName(fileName, knownTagIds),
      });
    }

    return result;
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
            tagIndex.addImage(page.uuid, imageData, journal.uuid);
          }
        }
      } catch (error) {
        logger.error('Failed to create pages:', error);
      }
    }

    return { created: toCreate.length, updated: toUpdate.length };
  }
}