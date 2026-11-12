**
 * @fileoverview Journal page editor for IMAGE_DATA, NAME_DATA, and TAG_DATA flags.
 */

import { MODULE_ID, FLAGS, DEFAULT_IMAGE_DATA, PATHS } from '../../constants/index.mjs';
import { TAG_CATEGORY, GENDER_TAGS, isBuiltinTag } from '../../constants/tags.mjs';
import { NAME_TYPE, NAME_TYPES } from '../../constants/ui.mjs';
import { logger, getFlag } from '../../utils/index.mjs';
import { browseImage, derivePortraitUrl } from '../../utils/filepicker.mjs';
import { getJournalForWrite } from '../../utils/source.mjs';
import { batchWriter } from '../../utils/batch-writer.mjs';
import { tagIndex, tag } from '../../services/index.mjs';
import { BaseFormApplication } from '../base/base.mjs';

const MODE = {
  IMAGE: 'image',
  NAME: 'name',
  TAG: 'tag',
};

/** @returns {{ id: string, label: string }[]} */
function getAvailableLocales() {
  const locales = new Map();

  const systemLangs = game.system?.languages ?? game.i18n?.languages ?? [];
  for (const lang of systemLangs) {
    if (lang?.lang) locales.set(lang.lang, lang.name ?? lang.lang);
  }

  for (const mod of game.modules.values()) {
    if (!mod.active) continue;
    for (const lang of mod.languages ?? []) {
      if (lang?.lang && !locales.has(lang.lang)) {
        locales.set(lang.lang, lang.name ?? lang.lang);
      }
    }
  }

  if (locales.size === 0) {
    locales.set('en', 'English');
  }

  return Array.from(locales.entries())
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Create/edit a single journal page entry (image, name set, or tag). */
export class Editor extends BaseFormApplication {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-editor`,
    form: {
      handler: function(event, form, formData) {
        return this._onFormSubmit(event, form, formData);
      },
      closeOnSubmit: false,
    },
    window: {
      title: 'cs-hero-box.editor.title',
      resizable: false,
    },
    position: {
      width: 550,
      height: 'auto',
    },
    actions: {
      addCustomTag: function() { this._onAddCustomTag(); },
      removeCustomTag: function(event, target) { this._onRemoveCustomTag(event, target); },
      browseToken: function() { this._onBrowseToken(); },
      browsePortrait: function() { this._onBrowsePortrait(); },
      addLocale: function() { this._onAddLocale(); },
      removeLocale: function(event, target) { this._onRemoveLocale(event, target); },
    },
  };

  static PARTS = {
    form: {
      template: `${PATHS.TEMPLATES}/editor/editor.hbs`,
    },
    footer: {
      template: 'templates/generic/form-footer.hbs',
    },
  };

  #mode = MODE.IMAGE;
  #pages = [];
  #page = null;
  #journalId = null;
  #onSave = null;
  #multiEdit = false;
  #initialTags = new Set();

  // image mode state
  #selectedTags = new Set();
  #tokenUrl = '';
  #portraitUrl = '';
  #scale = 1;
  #dynamicRing = true;

  // name mode state
  #name = '';
  #nameType = NAME_TYPE.FIRST_NAME;
  #selectedGenders = [];
  #selectedRaces = [];
  #selectedSubraces = [];
  #selectedRoleGroups = [];
  #selectedRoles = [];
  #extraNameTags = [];
  #localeSets = [];

  // tag mode state
  #tagId = '';
  #tagLabel = '';
  #tagCategory = TAG_CATEGORY.RACE;
  #parentRaceId = '';
  #roleGroupId = '';
  #tagWeight = 1;
  #expandedRoleGroups = new Set();

  constructor(options = {}) {
    super();

    this.#mode = options.mode ?? MODE.IMAGE;
    this.#pages = options.pages ?? [];
    this.#page = options.page ?? null;
    this.#journalId = options.journalId ?? null;
    this.#onSave = options.onSave ?? null;
    this.#multiEdit = options.multiEdit ?? false;

    this.#initialize();
  }

  // open editor for one or more images
  static async openImage(pageOrPages, options = {}) {
    const pages = Array.isArray(pageOrPages) ? pageOrPages : [pageOrPages];
    return Editor.#open({
      mode: MODE.IMAGE,
      pages,
      multiEdit: pages.length > 1,
      ...options,
    });
  }

  // open editor for a name set (new or existing)
  static async openName(page = null, journalId = null, options = {}) {
    return Editor.#open({
      mode: MODE.NAME,
      page,
      journalId,
      ...options,
    });
  }

  // open editor for a tag (new or existing)
  static async openTag(page = null, journalId = null, options = {}) {
    return Editor.#open({
      mode: MODE.TAG,
      page,
      journalId,
      ...options,
    });
  }

  // internal helper to create and show the editor
  static async #open(options) {
    const { createSingleResolvePromise } = await import('../../utils/promise.mjs');
    const { promise, resolve } = createSingleResolvePromise();

    const app = new Editor({
      ...options,
      onSave: () => resolve(true),
    });

    const originalClose = app.close.bind(app);
    app.close = async (opts = {}) => {
      await originalClose(opts);
      resolve(false);
    };

    app.render({ force: true });
    return promise;
  }

  // dynamic title based on mode and what we're editing
  get title() {
    switch (this.#mode) {
      case MODE.IMAGE:
        if (this.#multiEdit) {
          return game.i18n.format('cs-hero-box.editor.imageTitleMultiple', { count: this.#pages.length });
        }
        return game.i18n.format('cs-hero-box.editor.imageTitle', { name: this.#pages[0]?.name ?? '' });

      case MODE.NAME:
        if (this.#page) {
          return game.i18n.format('cs-hero-box.editor.nameTitleEdit', { name: this.#page.name });
        }
        return game.i18n.localize('cs-hero-box.editor.nameTitleNew');

      case MODE.TAG:
        if (this.#page) {
          return game.i18n.format('cs-hero-box.editor.tagTitleEdit', { name: this.#tagId });
        }
        return game.i18n.localize('cs-hero-box.editor.tagTitleNew');
    }
    return '';
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this.#bindInputs();
    this.#bindRaceCheckboxes();
  }

  _prepareContext(options) {
    const base = {
      mode: this.#mode,
      isImageMode: this.#mode === MODE.IMAGE,
      isNameMode: this.#mode === MODE.NAME,
      isTagMode: this.#mode === MODE.TAG,
      buttons: [
        { type: 'submit', icon: 'fa-solid fa-save', label: 'cs-hero-box.common.save' },
      ],
    };

    switch (this.#mode) {
      case MODE.IMAGE:
        return { ...base, ...this.#prepareImageContext() };
      case MODE.NAME:
        return { ...base, ...this.#prepareNameContext() };
      case MODE.TAG:
        return { ...base, ...this.#prepareTagContext() };
    }
    return base;
  }

  // route form submission to the right handler
  async _onFormSubmit(event, form, formData) {
    let success = false;

    try {
      switch (this.#mode) {
        case MODE.IMAGE:
          success = await this.#saveImage(form, formData);
          break;
        case MODE.NAME:
          success = await this.#saveName(form, formData);
          break;
        case MODE.TAG:
          success = await this.#saveTag(form, formData);
          break;
      }
    } catch (error) {
      logger.error('Failed to save:', error);
      ui.notifications.error(game.i18n.localize('cs-hero-box.editor.saveError'));
      return;
    }

    if (success) {
      this.close();
      if (this.#onSave) this.#onSave();
    }
  }

  _onAddCustomTag() {
    const input = this.querySelector('.cs-hero-box-editor__custom-input');
    if (input?.value) {
      this.#addCustomTag(input.value);
      input.value = '';
    }
  }

  _onRemoveCustomTag(event, target) {
    const tagId = target.dataset.tag;
    this.#selectedTags.delete(tagId);
    this.render();
  }

  _onBrowseToken() {
    if (this.#multiEdit) return;
    browseImage(this.#tokenUrl, (path) => {
      this.#tokenUrl = path;
      this.render();
    });
  }

  _onBrowsePortrait() {
    if (this.#multiEdit) return;
    browseImage(this.#portraitUrl, (path) => {
      this.#portraitUrl = path;
      this.render();
    });
  }

  _onRemoveLocale(event, target) {
    this.#syncNameState();
    const index = parseInt(target.dataset.index);
    if (this.#localeSets.length > 1 && index >= 0 && index < this.#localeSets.length) {
      this.#localeSets.splice(index, 1);
      this.render();
    }
  }

  _onAddLocale() {
    this.#syncNameState();
    const allLocales = getAvailableLocales();
    const usedLocales = new Set(this.#localeSets.map(s => s.locale));
    const nextLocale = allLocales.find(l => !usedLocales.has(l.id));
    if (nextLocale) {
      this.#localeSets.push({ locale: nextLocale.id, names: '' });
      this.render();
    }
  }

  // load initial state based on mode and existing data
  #initialize() {
    switch (this.#mode) {
      case MODE.IMAGE: this.#initImage(); break;
      case MODE.NAME: this.#initName(); break;
      case MODE.TAG: this.#initTag(); break;
    }
  }

  // load image data from page flags
  #initImage() {
    if (this.#multiEdit) {
      // for multi-edit, collect all tags from all selected images
      for (const page of this.#pages) {
        const imageData = getFlag(page, FLAGS.IMAGE_DATA) ?? {};
        for (const t of imageData.tags ?? []) this.#selectedTags.add(t);
      }
      this.#initialTags = new Set(this.#selectedTags);
    } else if (this.#pages.length > 0) {
      const page = this.#pages[0];
      const imageData = getFlag(page, FLAGS.IMAGE_DATA) ?? {};
      this.#selectedTags = new Set(imageData.tags ?? []);
      this.#initialTags = new Set(this.#selectedTags);
      this.#tokenUrl = imageData.tokenUrl || imageData.url || page.src || '';
      this.#portraitUrl = imageData.portraitUrl || derivePortraitUrl(this.#tokenUrl);
      this.#scale = imageData.scale ?? DEFAULT_IMAGE_DATA.scale;
      this.#dynamicRing = imageData.dynamicRing ?? DEFAULT_IMAGE_DATA.dynamicRing;
    }
  }

  // load name set data from page flags
  #initName() {
    if (this.#page) {
      const nameData = getFlag(this.#page, FLAGS.NAME_DATA);
      this.#name = this.#page.name ?? '';
      this.#nameType = nameData?.type ?? NAME_TYPE.FIRST_NAME;

      const hasExplicitGroups = Boolean(
        nameData?.genders?.length
        || nameData?.races?.length
        || nameData?.subraces?.length
        || nameData?.roleGroups?.length
        || nameData?.roles?.length
      );

      if (hasExplicitGroups) {
        this.#selectedGenders = [...(nameData?.genders ?? [])];
        this.#selectedRaces = [...(nameData?.races ?? [])];
        this.#selectedSubraces = [...(nameData?.subraces ?? [])];
        this.#selectedRoleGroups = [...(nameData?.roleGroups ?? [])];
        this.#selectedRoles = [...(nameData?.roles ?? [])];
        const known = new Set([
          ...this.#selectedGenders,
          ...this.#selectedRaces,
          ...this.#selectedSubraces,
          ...this.#selectedRoleGroups,
          ...this.#selectedRoles,
        ]);
        this.#extraNameTags = (nameData?.tags ?? []).filter(t => !known.has(t));
      } else if (Array.isArray(nameData?.tags) && nameData.tags.length > 0) {
        const genderIds = new Set(Object.values(GENDER_TAGS));
        const raceIds = new Set(tag.getRaces().map(t => t.id));
        const roleGroupIds = new Set(tag.getRoleGroups().map(t => t.id));
        const roleIds = new Set(tag.getRoles().map(t => t.id));
        this.#selectedGenders = [];
        this.#selectedRaces = [];
        this.#selectedSubraces = [];
        this.#selectedRoleGroups = [];
        this.#selectedRoles = [];
        this.#extraNameTags = [];

        for (const t of nameData.tags) {
          if (genderIds.has(t)) {
            this.#selectedGenders.push(t);
          } else if (raceIds.has(t)) {
            this.#selectedRaces.push(t);
          } else if (roleGroupIds.has(t)) {
            this.#selectedRoleGroups.push(t);
          } else if (roleIds.has(t)) {
            this.#selectedRoles.push(t);
          } else if (tag.get(t)?.category === TAG_CATEGORY.SUBRACE) {
            this.#selectedSubraces.push(t);
            const parentRaceId = tag.get(t)?.parentRaceId;
            if (parentRaceId && !this.#selectedRaces.includes(parentRaceId)) {
              this.#selectedRaces.push(parentRaceId);
            }
          } else {
            this.#extraNameTags.push(t);
          }
        }
      } else {
        this.#selectedGenders = [];
        this.#selectedRaces = [];
        this.#selectedSubraces = [];
        this.#selectedRoleGroups = [];
        this.#selectedRoles = [];
        this.#extraNameTags = [];
      }

      if (nameData?.names) {
        this.#localeSets = Object.entries(nameData.names).map(([locale, names]) => ({
          locale,
          names: Array.isArray(names) ? names.join(', ') : '',
        }));
      }
    }
    if (this.#localeSets.length === 0) {
      this.#localeSets.push({ locale: 'en', names: '' });
    }
  }

  // load tag data from page flags
  #initTag() {
    if (this.#page) {
      const tagData = getFlag(this.#page, FLAGS.TAG_DATA);
      this.#tagId = tagData?.id ?? '';
      this.#tagLabel = tagData?.label ?? '';
      this.#tagCategory = tagData?.category ?? TAG_CATEGORY.RACE;
      this.#parentRaceId = tagData?.parentRaceId ?? '';
      this.#roleGroupId = tagData?.roleGroupId ?? '';
      const rawWeight = Number(tagData?.weight);
      this.#tagWeight = Number.isFinite(rawWeight) && rawWeight > 0 ? rawWeight : 1;
    }
  }

  // build template context for image mode
  #prepareImageContext() {
    const knownTagIds = this.#collectKnownTagIds();
    const customTags = Array.from(this.#selectedTags).filter(t => !knownTagIds.has(t));

    return {
      multiEdit: this.#multiEdit,
      pageCount: this.#pages.length,
      tokenUrl: this.#tokenUrl,
      portraitUrl: this.#portraitUrl,
      scale: this.#scale,
      dynamicRing: this.#dynamicRing,
      genderTags: this.#mapTagsWithSelection(tag.getGenders()),
      ageTags: this.#mapTagsWithSelection(tag.getAges()),
      raceTags: this.#buildRaceTagsWithSelection(),
      roleTags: this.#buildRoleTagsWithSelection(),
      otherTags: this.#mapTagsWithSelection(tag.getOther()),
      customTags,
      selectedTagsDisplay: Array.from(this.#selectedTags).map(t => tag.getLabel(t)).join(', '),
    };
  }

  // build template context for name mode
  #prepareNameContext() {
    const allLocales = getAvailableLocales();
    const usedLocales = new Set(this.#localeSets.map(s => s.locale));
    const availableLocales = allLocales.filter(l => !usedLocales.has(l.id));

    return {
      isNew: !this.#page,
      name: this.#name,
      nameType: this.#nameType,
      nameTypes: NAME_TYPES.map(id => ({
        id,
        label: game.i18n.localize(`cs-hero-box.nameType.${id}`),
        isSelected: this.#nameType === id,
      })),
      genderTags: tag.getGenders().map(t => ({
        id: t.id,
        label: tag.getLabel(t.id),
        isSelected: this.#selectedGenders.includes(t.id),
      })),
      raceTags: this.#buildRaceTagsForName(),
      roleTags: this.#buildRoleTagsForName(),
      localeSets: this.#localeSets.map((set, index) => ({
        ...set,
        index,
        canRemove: this.#localeSets.length > 1,
      })),
      availableLocales: allLocales,
      canAddLocale: availableLocales.length > 0,
    };
  }

  // build template context for tag mode
  #prepareTagContext() {
    return {
      isNew: !this.#page,
      tagId: this.#tagId,
      tagLabel: this.#tagLabel,
      categories: Object.values(TAG_CATEGORY).map(cat => ({
        value: cat,
        label: game.i18n.localize(`cs-hero-box.tagCategory.${cat}`),
        isSelected: this.#tagCategory === cat,
      })),
      raceTags: tag.getRaces().map(t => ({
        value: t.id,
        label: tag.getLabel(t.id),
        isSelected: this.#parentRaceId === t.id,
      })),
      roleGroups: tag.getRoleGroups().map(t => ({
        value: t.id,
        label: tag.getLabel(t.id),
        isSelected: this.#roleGroupId === t.id,
      })),
      tagWeight: this.#tagWeight,
      showParentRace: this.#tagCategory === TAG_CATEGORY.SUBRACE,
      showRoleGroup: this.#tagCategory === TAG_CATEGORY.ROLE,
    };
  }

  // save image data (single or multi-edit)
  async #saveImage(form, formData) {
    const formTags = new Set();

    for (const checkbox of form.querySelectorAll('input[type="checkbox"][name^="tag."]')) {
      if (checkbox.checked) formTags.add(checkbox.name.replace('tag.', ''));
    }

    // keep custom tags that aren't in the known list
    for (const t of this.#selectedTags) {
      if (!tag.get(t)) formTags.add(t);
    }

    const tags = Array.from(formTags);

    if (this.#multiEdit) {
      await this.#saveMultiImage(tags);
    } else {
      await this.#saveSingleImage(form, tags);
    }

    return true;
  }

  // save tags to multiple images, only changing what was added/removed
  async #saveMultiImage(newTags) {
    const newTagsSet = new Set(newTags);
    const addedTags = newTags.filter(t => !this.#initialTags.has(t));
    const removedTags = Array.from(this.#initialTags).filter(t => !newTagsSet.has(t));

    if (addedTags.length === 0 && removedTags.length === 0) return;

    const updates = [];

    for (const page of this.#pages) {
      const existingData = getFlag(page, FLAGS.IMAGE_DATA) ?? {};
      const existingTags = new Set(existingData.tags ?? []);

      for (const t of addedTags) existingTags.add(t);
      for (const t of removedTags) existingTags.delete(t);

      const finalTags = Array.from(existingTags);
      const newImageData = { ...existingData, tags: finalTags };

      updates.push({ uuid: page.uuid, imageData: newImageData });

      const journalUuid = page.parent.uuid;
      batchWriter.enqueue(journalUuid, page.id, FLAGS.IMAGE_DATA, newImageData);
    }

    await batchWriter.flush();
    tagIndex.updateImages(updates);
  }

  // save a single image with all its data
  async #saveSingleImage(form, tags) {
    const page = this.#pages[0];

    const newImageData = {
      tokenUrl: form.querySelector('input[name="tokenUrl"]')?.value?.trim() || '',
      portraitUrl: form.querySelector('input[name="portraitUrl"]')?.value?.trim() || '',
      scale: parseFloat(form.querySelector('input[name="scale"]')?.value) || 1,
      dynamicRing: form.querySelector('input[name="dynamicRing"]')?.checked ?? true,
      tags,
    };

    try {
      await page.setFlag(MODULE_ID, FLAGS.IMAGE_DATA, newImageData);
      tagIndex.updateImage(page.uuid, newImageData);
    } catch (error) {
      logger.error('Failed to save image:', error);
      throw error;
    }
  }

  // save name set data
  async #saveName(form, formData) {
    const data = foundry.utils.expandObject(formData.object);

    const selectedGenders = Object.entries(data.gender ?? {})
      .filter(([_, checked]) => checked).map(([id]) => id);
    const selectedRaces = Object.entries(data.race ?? {})
      .filter(([_, checked]) => checked).map(([id]) => id);
    const selectedSubraces = Object.entries(data.subrace ?? {})
      .filter(([_, checked]) => checked).map(([id]) => id);
    const selectedRoleGroups = Object.entries(data.roleGroup ?? {})
      .filter(([_, checked]) => checked).map(([id]) => id);
    const selectedRoles = Object.entries(data.role ?? {})
      .filter(([_, checked]) => checked).map(([id]) => id);

    // parse locale sets into the names object
    const names = {};
    if (data.localeSet) {
      for (const setData of Object.values(data.localeSet)) {
        const locale = setData.locale?.trim();
        const namesStr = setData.names?.trim();
        if (locale && namesStr) {
          const namesList = namesStr.split(',').map(n => n.trim()).filter(Boolean);
          if (namesList.length > 0) names[locale] = namesList;
        }
      }
    }

    const combinedTags = this.#extraNameTags.length > 0
      ? [...new Set([
          ...selectedGenders,
          ...selectedRaces,
          ...selectedSubraces,
          ...selectedRoleGroups,
          ...selectedRoles,
          ...this.#extraNameTags,
        ])]
      : null;

    const nameData = {
      type: data.type,
      genders: selectedGenders,
      races: selectedRaces,
      subraces: selectedSubraces,
      roleGroups: selectedRoleGroups,
      roles: selectedRoles,
      names,
      tags: combinedTags,
    };

    const pageName = data.name?.trim() || this.#page?.name || `NameSet-${foundry.utils.randomID(6)}`;

    try {
      if (this.#page) {
        await this.#page.update({ name: pageName });
        await this.#page.setFlag(MODULE_ID, FLAGS.NAME_DATA, nameData);
      } else {
        const journal = await getJournalForWrite(this.#journalId);
        if (!journal) return false;

        await journal.createEmbeddedDocuments('JournalEntryPage', [{
          name: pageName,
          type: 'text',
          text: { content: '' },
          flags: { [MODULE_ID]: { [FLAGS.NAME_DATA]: nameData } },
        }]);
      }
    } catch (error) {
      logger.error('Failed to save name set:', error);
      throw error;
    }

    ui.notifications.info(game.i18n.localize('cs-hero-box.editor.nameSaved'));
    return true;
  }

  // save tag definition
  async #saveTag(form, formData) {
    let identifier = formData.object.identifier?.trim() || '';

    // keep existing id if editing
    if (this.#page && !identifier) {
      const existingData = getFlag(this.#page, FLAGS.TAG_DATA);
      identifier = existingData?.id ?? '';
    }

    identifier = identifier.toLowerCase().replace(/\s+/g, '-');

    if (!identifier) {
      ui.notifications.error(game.i18n.localize('cs-hero-box.editor.tagErrorNoId'));
      return false;
    }

    if (isBuiltinTag(identifier)) {
      ui.notifications.error(game.i18n.localize('cs-hero-box.editor.tagErrorBuiltin'));
      return false;
    }

    const existingTag = tag.get(identifier);
    if (existingTag && (!this.#page || existingTag.uuid !== this.#page.uuid)) {
      ui.notifications.error(game.i18n.localize('cs-hero-box.editor.tagErrorDuplicate'));
      return false;
    }

    const category = formData.object.category ?? TAG_CATEGORY.RACE;
    const parentRaceId = category === TAG_CATEGORY.SUBRACE
      ? (formData.object.parentRaceId || null) : null;
    const roleGroupId = category === TAG_CATEGORY.ROLE
      ? (formData.object.roleGroupId || null) : null;
    const parsedWeight = Number(formData.object.weight);
    const weight = category === TAG_CATEGORY.ROLE && Number.isFinite(parsedWeight) && parsedWeight > 0
      ? Math.round(parsedWeight * 100) / 100
      : 1;
    const label = formData.object.label?.trim() || identifier;

    const tagData = { id: identifier, category, parentRaceId, roleGroupId, weight, label };

    try {
      if (this.#page) {
        await this.#page.update({ name: `Tag: ${identifier}` });
        await this.#page.setFlag(MODULE_ID, FLAGS.TAG_DATA, tagData);
      } else {
        const journal = await getJournalForWrite(this.#journalId);
        if (!journal) return false;

        await journal.createEmbeddedDocuments('JournalEntryPage', [{
          name: `Tag: ${identifier}`,
          type: 'text',
          text: { content: '' },
          flags: { [MODULE_ID]: { [FLAGS.TAG_DATA]: tagData } },
        }]);
      }
    } catch (error) {
      logger.error('Failed to save tag:', error);
      throw error;
    }

    await tag.reload();
    return true;
  }

  // wire up input handlers
  #bindInputs() {
    // enter key in custom tag input adds the tag
    const customInput = this.querySelector('.cs-hero-box-editor__custom-input');
    if (customInput) {
      this.addEvent(customInput, 'keypress', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.#addCustomTag(e.target.value);
          e.target.value = '';
        }
      });
    }

    // update preview when urls change
    if (this.#mode === MODE.IMAGE && !this.#multiEdit) {
      const tokenInput = this.querySelector('input[name="tokenUrl"]');
      const portraitInput = this.querySelector('input[name="portraitUrl"]');
      if (tokenInput) {
        this.addEvent(tokenInput, 'change', (e) => {
          this.#tokenUrl = e.target.value;
          this.render();
        });
      }
      if (portraitInput) {
        this.addEvent(portraitInput, 'change', (e) => {
          this.#portraitUrl = e.target.value;
          this.render();
        });
      }
    }

    // show/hide parent race / role group / weight fields when category changes
    if (this.#mode === MODE.TAG) {
      const categorySelect = this.querySelector('select[name="category"]');
      const parentRaceGroup = this.querySelector('.cs-hero-box-editor__parent-race');
      const roleGroupField = this.querySelector('.cs-hero-box-editor__role-group');
      const roleWeightField = this.querySelector('.cs-hero-box-editor__role-weight');
      if (categorySelect) {
        this.addEvent(categorySelect, 'change', (e) => {
          const isRole = e.target.value === TAG_CATEGORY.ROLE;
          if (parentRaceGroup) {
            parentRaceGroup.style.display = e.target.value === TAG_CATEGORY.SUBRACE ? '' : 'none';
          }
          if (roleGroupField) {
            roleGroupField.style.display = isRole ? '' : 'none';
          }
          if (roleWeightField) {
            roleWeightField.style.display = isRole ? '' : 'none';
          }
        });
      }
    }
  }

  // toggle subrace and role-group visibility in image/name modes
  #bindRaceCheckboxes() {
    if (this.#mode !== MODE.IMAGE && this.#mode !== MODE.NAME) return;

    for (const checkbox of this.querySelectorAll('input[data-race-id]')) {
      this.addEvent(checkbox, 'change', (e) => {
        const raceId = e.target.dataset.raceId;
        const subraceContainer = this.querySelector(`[data-subrace-container="${raceId}"]`);
        if (subraceContainer) {
          subraceContainer.style.display = e.target.checked ? '' : 'none';
          if (!e.target.checked) {
            subraceContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
          }
        }
      });
    }

    for (const toggleBtn of this.querySelectorAll('[data-role-group-toggle]')) {
      this.addEvent(toggleBtn, 'click', (e) => {
        e.preventDefault();
        const groupId = toggleBtn.dataset.roleGroupToggle;
        const container = this.querySelector(`[data-role-group-container="${groupId}"]`);
        if (!container) return;

        const isNowOpen = container.style.display === 'none';
        container.style.display = isNowOpen ? '' : 'none';
        toggleBtn.classList.toggle('expanded', isNowOpen);
        if (isNowOpen) {
          this.#expandedRoleGroups.add(groupId);
        } else {
          this.#expandedRoleGroups.delete(groupId);
        }
      });
    }

    for (const checkbox of this.querySelectorAll('input[data-role-group-id]')) {
      this.addEvent(checkbox, 'change', (e) => {
        const groupId = e.target.dataset.roleGroupId;
        const container = this.querySelector(`[data-role-group-container="${groupId}"]`);
        const toggleBtn = this.querySelector(`[data-role-group-toggle="${groupId}"]`);
        if (e.target.checked && container) {
          container.style.display = '';
          toggleBtn?.classList.add('expanded');
          this.#expandedRoleGroups.add(groupId);
        }
      });
    }
  }

  // read current values from name form inputs before re-render
  #syncNameState() {
    if (!this.element) return;

    const nameInput = this.querySelector('input[name="name"]');
    if (nameInput) this.#name = nameInput.value;

    const typeSelect = this.querySelector('select[name="type"]');
    if (typeSelect) this.#nameType = typeSelect.value;

    this.#selectedGenders = Array.from(this.querySelectorAll('input[type="checkbox"][name^="gender."]'))
      .filter(cb => cb.checked)
      .map(cb => cb.name.replace('gender.', ''));

    this.#selectedRaces = Array.from(this.querySelectorAll('input[type="checkbox"][name^="race."]'))
      .filter(cb => cb.checked)
      .map(cb => cb.name.replace('race.', ''));

    this.#selectedSubraces = Array.from(this.querySelectorAll('input[type="checkbox"][name^="subrace."]'))
      .filter(cb => cb.checked)
      .map(cb => cb.name.replace('subrace.', ''));

    this.#selectedRoleGroups = Array.from(this.querySelectorAll('input[type="checkbox"][name^="roleGroup."]'))
      .filter(cb => cb.checked)
      .map(cb => cb.name.replace('roleGroup.', ''));

    this.#selectedRoles = Array.from(this.querySelectorAll('input[type="checkbox"][name^="role."]'))
      .filter(cb => cb.checked)
      .map(cb => cb.name.replace('role.', ''));

    this.#localeSets = [];
    let index = 0;
    while (true) {
      const localeSelect = this.querySelector(`select[name="localeSet.${index}.locale"]`);
      const namesInput = this.querySelector(`input[name="localeSet.${index}.names"]`);
      if (!localeSelect && !namesInput) break;
      this.#localeSets.push({
        locale: localeSelect?.value ?? 'en',
        names: namesInput?.value ?? '',
      });
      index++;
    }
  }

  // add a custom tag (user-defined, not in the registry)
  #addCustomTag(value) {
    const tagId = value.toLowerCase().trim().replace(/\s+/g, '-');
    if (tagId && !this.#selectedTags.has(tagId)) {
      this.#selectedTags.add(tagId);
      this.render();
    }
  }

  // get all known tag ids for filtering custom tags
  #collectKnownTagIds() {
    const ids = new Set();
    const addTags = (tags) => tags.forEach(t => ids.add(t.id));

    addTags(tag.getGenders());
    addTags(tag.getAges());
    addTags(tag.getRoleGroups());
    addTags(tag.getRoles());
    addTags(tag.getOther());

    for (const raceTag of tag.getRaces()) {
      ids.add(raceTag.id);
      tag.getSubraces(raceTag.id).forEach(s => ids.add(s.id));
    }

    return ids;
  }

  // map tags to template format with selection state
  #mapTagsWithSelection(tags) {
    return tags.map(t => ({
      id: t.id,
      label: tag.getLabel(t.id),
      isSelected: this.#selectedTags.has(t.id),
    }));
  }

  // build race tags with nested subraces for image mode
  #buildRaceTagsWithSelection() {
    return tag.getRaces().map(raceTag => {
      const subraces = tag.getSubraces(raceTag.id);
      const isSelected = this.#selectedTags.has(raceTag.id);

      return {
        id: raceTag.id,
        label: tag.getLabel(raceTag.id),
        isSelected,
        hasSubraces: subraces.length > 0,
        showSubraces: isSelected && subraces.length > 0,
        subraces: subraces.map(s => ({
          id: s.id,
          label: tag.getLabel(s.id),
          isSelected: this.#selectedTags.has(s.id),
        })),
      };
    });
  }

  // build role groups + ungrouped roles for image mode
  #buildRoleTagsWithSelection() {
    const groupEntries = tag.getRoleGroups()
      .map(groupTag => {
        const roles = tag.getRoles(groupTag.id)
          .map(r => ({
            id: r.id,
            label: tag.getLabel(r.id),
            isSelected: this.#selectedTags.has(r.id),
          }))
          .sort((a, b) => a.label.localeCompare(b.label));

        const isSelected = this.#selectedTags.has(groupTag.id);
        const hasSelectedChild = roles.some(r => r.isSelected);
        const hasRoles = roles.length > 0;

        return {
          id: groupTag.id,
          label: tag.getLabel(groupTag.id),
          isRoleGroup: true,
          isSelected,
          hasRoles,
          showRoles: hasRoles && (isSelected || hasSelectedChild || this.#expandedRoleGroups.has(groupTag.id)),
          roles,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));

    const ungroupedEntries = tag.getUngroupedRoles()
      .map(roleTag => ({
        id: roleTag.id,
        label: tag.getLabel(roleTag.id),
        isRoleGroup: false,
        isSelected: this.#selectedTags.has(roleTag.id),
        hasRoles: false,
        showRoles: false,
        roles: [],
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    return [...groupEntries, ...ungroupedEntries];
  }

  // build race tags with nested subraces for name mode
  #buildRaceTagsForName() {
    return tag.getRaces().map(t => {
      const isSelected = this.#selectedRaces.includes(t.id);
      const subraces = tag.getSubraces(t.id);

      return {
        id: t.id,
        label: tag.getLabel(t.id),
        isSelected,
        hasSubraces: subraces.length > 0,
        showSubraces: isSelected && subraces.length > 0,
        subraces: subraces.map(s => ({
          id: s.id,
          label: tag.getLabel(s.id),
          isSelected: this.#selectedSubraces.includes(s.id),
        })),
      };
    });
  }

  // build role groups + ungrouped roles for name mode
  #buildRoleTagsForName() {
    const groupEntries = tag.getRoleGroups()
      .map(groupTag => {
        const roles = tag.getRoles(groupTag.id)
          .map(r => ({
            id: r.id,
            label: tag.getLabel(r.id),
            isSelected: this.#selectedRoles.includes(r.id),
          }))
          .sort((a, b) => a.label.localeCompare(b.label));

        const isSelected = this.#selectedRoleGroups.includes(groupTag.id);
        const hasSelectedChild = roles.some(r => r.isSelected);
        const hasRoles = roles.length > 0;

        return {
          id: groupTag.id,
          label: tag.getLabel(groupTag.id),
          isRoleGroup: true,
          isSelected,
          hasRoles,
          showRoles: hasRoles && (isSelected || hasSelectedChild || this.#expandedRoleGroups.has(groupTag.id)),
          roles,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));

    const ungroupedEntries = tag.getUngroupedRoles()
      .map(roleTag => ({
        id: roleTag.id,
        label: tag.getLabel(roleTag.id),
        isRoleGroup: false,
        isSelected: this.#selectedRoles.includes(roleTag.id),
        hasRoles: false,
        showRoles: false,
        roles: [],
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    return [...groupEntries, ...ungroupedEntries];
  }
}