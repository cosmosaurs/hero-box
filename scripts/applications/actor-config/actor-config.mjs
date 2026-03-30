/**
 * @fileoverview Hero Box actor wizard: random vs fixed token, tag or explicit image selection.
 */

import { MODULE_ID, FLAGS, TOKEN_MODE, SELECTION_MODE, PATHS, SETTINGS } from '../../constants/index.mjs';
import { GENDER_TAGS, AGE_TAGS } from '../../constants/tags.mjs';
import { logger, getFlag } from '../../utils/index.mjs';
import { tag, imagePicker } from '../../services/index.mjs';
import { getSetting, setSetting } from '../../settings.mjs';
import { BaseFormApplication } from '../base/base.mjs';

export class ActorConfig extends BaseFormApplication {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-actor-config`,
    form: {
      handler: function(event, form, formData) {
        return this._onFormSubmit(event, form, formData);
      },
      closeOnSubmit: false,
    },
    window: {
      title: 'cs-hero-box.form.title',
      resizable: false,
      minimizable: true,
    },
    position: {
      width: 450,
      height: 'auto',
    },
    actions: {
      generate: function() { this._onGenerate(); },
      clearSourceActor: function() { this._onClearSourceActor(); },
      pickImages: function() { this._onPickImages(); },
      clearImages: function() { this._onClearImages(); },
      removeImage: function(event, target) { this._onRemoveImage(event, target); },
      setSelectionMode: function(event, target) { this._onSetSelectionMode(event, target); },
    },
    dragDrop: [{ dragSelector: null, dropSelector: '[data-drop-zone]' }],
  };

  static PARTS = {
    form: {
      template: `${PATHS.TEMPLATES}/actor-config/actor-config.hbs`,
    },
    footer: {
      template: 'templates/generic/form-footer.hbs',
    },
  };

  #actor = null;
  #folderId = null;
  #result = null;
  #formState = {};
  #dragDrop = [];
  #raceTags = [];
  #roleTags = [];
  #selectionMode = SELECTION_MODE.TAG;
  #selectedImages = [];
  #initPromise = null;

  /** @param {Actor|null} [actor] */
  constructor(actor = null) {
    super();
    this.#actor = actor;
    this.#formState = this.#getInitialFormState();
    this.#dragDrop = this.#createDragDropHandlers();
    this.#initPromise = this.#initializeFromActor();
  }

  /**
   * @param {Actor|null} [actor]
   * @param {{ folderId?: string|null, initialSelectionMode?: string, initialImages?: object[] }} [options]
   * @returns {Promise<{ submitted: boolean, data: object|null }>}
   */
  static async open(actor = null, options = {}) {
    const { createSingleResolvePromise } = await import('../../utils/promise.mjs');
    const { promise, resolve } = createSingleResolvePromise();

    const app = new ActorConfig(actor);
    app.#folderId = options.folderId ?? null;

    if (options.initialSelectionMode === 'image') {
      app.#selectionMode = SELECTION_MODE.IMAGE;
    }
    if (options.initialImages?.length) {
      app.#selectedImages = [...options.initialImages];

      // if only one image, default to fixed mode
      if (options.initialImages.length === 1) {
        app.#formState.mode = TOKEN_MODE.FIXED;
      }
    }

    app.#result = { submitted: false, data: null };

    const originalClose = app.close.bind(app);
    app.close = async (opts = {}) => {
      await originalClose(opts);
      resolve(app.#result);
    };

    app.render(true);
    return promise;
  }

  /** @returns {string} */
  get title() {
    if (this.#actor) {
      return game.i18n.format('cs-hero-box.form.titleEdit', { name: this.#actor.name });
    }
    return game.i18n.localize('cs-hero-box.form.title');
  }

  /** @returns {Promise<void>} */
  async close(options = {}) {
    this.#formState = this.#getInitialFormState();
    this.#selectionMode = SELECTION_MODE.TAG;
    this.#selectedImages = [];
    return super.close(options);
  }

  /** @param {object} context @param {object} options */
  _onRender(context, options) {
    super._onRender(context, options);
    this.#dragDrop.forEach(d => d.bind(this.element));
    this.#bindRaceCheckboxes();
    this.#bindSubraceAutoSelect();
    this.#bindDropZoneEvents();
    this.#bindNicknameSliders();
    this.#bindRaceSearch();
    this.#bindAccordions();
    this.#bindGenderButtons();
    this.#bindModeButtons();
  }

  /** CSS `dragover` class on the source-actor drop zone. */
  #bindDropZoneEvents() {
    const dropZone = this.querySelector('[data-drop-zone]');
    if (!dropZone) return;

    this.addEvent(dropZone, 'dragenter', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });

    this.addEvent(dropZone, 'dragleave', (e) => {
      const rect = dropZone.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
        dropZone.classList.remove('dragover');
      }
    });

    this.addEvent(dropZone, 'drop', () => dropZone.classList.remove('dragover'));
    this.addEvent(dropZone, 'dragover', (e) => e.preventDefault());
  }

  #bindAccordions() {
    let expandedSections = null;
    try {
      expandedSections = getSetting(SETTINGS.COLLAPSED_ACTOR_CONFIG);
    } catch {}

    const sections = this.querySelectorAll('.cs-hero-box-form__section:not(.cs-hero-box-form__section--static)');
    for (const section of sections) {
      const header = section.querySelector('.cs-hero-box-form__section-header');
      if (!header) continue;

      const sectionId = section.dataset.sectionId;

      if (Array.isArray(expandedSections)) {
        section.classList.toggle('collapsed', !expandedSections.includes(sectionId));
      } else {
        section.classList.add('collapsed');
      }

      this.addEvent(header, 'click', (e) => {
        if (e.target.closest('input, button, label')) return;
        e.preventDefault();
        section.classList.toggle('collapsed');
        this.#saveAccordionState();
      });
    }
  }

  #bindGenderButtons() {
    const buttons = this.querySelectorAll('.cs-hero-box-form__gender-btn');
    const hiddenInput = this.querySelector('input[name="selectedGender"]');
    for (const btn of buttons) {
      this.addEvent(btn, 'click', () => {
        buttons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const value = btn.dataset.gender;
        if (hiddenInput) hiddenInput.value = value;
        this.#formState.gender = value === 'any' ? [] : [value];
      });
    }
  }

  #bindModeButtons() {
    const buttons = this.querySelectorAll('.cs-hero-box-form__segment-btn[data-mode-value]');
    const hiddenInput = this.querySelector('input[name="selectedMode"]');
    for (const btn of buttons) {
      this.addEvent(btn, 'click', () => {
        buttons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const value = btn.dataset.modeValue;
        if (hiddenInput) hiddenInput.value = value;
        this.#formState.mode = value;
      });
    }
  }

  #bindRaceCheckboxes() {
    const raceCheckboxes = this.querySelectorAll('input[data-race-id]');
    for (const checkbox of raceCheckboxes) {
      this.addEvent(checkbox, 'change', (e) => {
        const raceId = e.target.dataset.raceId;
        const subraceContainer = this.querySelector(`[data-subrace-parent="${raceId}"]`);
        if (subraceContainer) {
          subraceContainer.style.display = e.target.checked ? '' : 'none';
          if (!e.target.checked) {
            subraceContainer.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
          }
        }
      });
    }
  }

  #bindSubraceAutoSelect() {
    const subraceCheckboxes = this.querySelectorAll('input[data-parent-race]');
    for (const cb of subraceCheckboxes) {
      this.addEvent(cb, 'change', (e) => {
        if (!e.target.checked) return;
        const parentRaceId = e.target.dataset.parentRace;
        const raceCheckbox = this.querySelector(`input[data-race-id="${parentRaceId}"]`);
        if (raceCheckbox && !raceCheckbox.checked) {
          raceCheckbox.checked = true;
          raceCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    }
  }

  #bindNicknameSliders() {
    this.#bindSliderPair('nicknameChance', 'nicknameChanceNum', 'nicknameChance');
    this.#bindSliderPair('nicknameOnlyChance', 'nicknameOnlyChanceNum', 'nicknameOnlyChance');
    this.#bindSliderPair('noLastNameChance', 'noLastNameChanceNum', 'noLastNameChance');
  }

  #bindSliderPair(rangeName, numberName, stateKey) {
    const range = this.querySelector(`input[name="${rangeName}"][type="range"]`);
    const number = this.querySelector(`input[name="${numberName}"]`);
    if (range && number) {
      this.addEvent(range, 'input', (e) => {
        number.value = e.target.value;
        this.#formState[stateKey] = parseInt(e.target.value) || 0;
      });
      this.addEvent(number, 'input', (e) => {
        let val = Math.max(0, Math.min(100, parseInt(e.target.value) || 0));
        range.value = val;
        this.#formState[stateKey] = val;
      });
    }
  }

  #bindRaceSearch() {
    const searchInput = this.querySelector('.cs-hero-box-form__race-search');
    if (!searchInput) return;

    this.addEvent(searchInput, 'input', (e) => {
      const query = e.target.value.toLowerCase().trim();
      this.#formState.raceSearchQuery = query;
      const raceItems = this.querySelectorAll('.cs-hero-box-form__race-item');

      for (const item of raceItems) {
        const raceLabel = item.querySelector('.cs-hero-box-form__checkbox span')?.textContent?.toLowerCase() ?? '';
        const subraceContainer = item.querySelector('.cs-hero-box-form__subraces');
        let subraceMatch = false;
        let matchingSubraceCount = 0;

        if (subraceContainer) {
          const subraceLabels = subraceContainer.querySelectorAll('.cs-hero-box-form__checkbox--subrace');
          for (const subraceEl of subraceLabels) {
            const subraceText = subraceEl.querySelector('span')?.textContent?.toLowerCase() ?? '';
            if (query && subraceText.includes(query)) {
              subraceMatch = true;
              matchingSubraceCount++;
              subraceEl.style.display = '';
            } else if (query) {
              subraceEl.style.display = 'none';
            } else {
              subraceEl.style.display = '';
            }
          }
        }

        const raceMatch = raceLabel.includes(query) || !query;

        if (raceMatch || subraceMatch) {
          item.style.display = '';
          if (subraceContainer) {
            if (subraceMatch && !raceMatch) {
              subraceContainer.style.display = '';
            } else if (!query) {
              const raceCheckbox = item.querySelector('input[data-race-id]');
              if (raceCheckbox && !raceCheckbox.checked) {
                subraceContainer.style.display = 'none';
              } else {
                subraceContainer.style.display = '';
              }
              subraceContainer.querySelectorAll('.cs-hero-box-form__checkbox--subrace').forEach(el => {
                el.style.display = '';
              });
            }
          }
        } else {
          item.style.display = 'none';
        }
      }
    });
  }

  /** @returns {Promise<object>} */
  async _prepareContext(options) {
    if (this.#initPromise) {
      await this.#initPromise;
      this.#initPromise = null;
    }

    this.#loadTagsIfNeeded();
    const state = this.#formState;

    const raceTags = this.#raceTags.map(t => {
      const isSelected = state.race.includes(t.id);
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
          isSelected: state.subrace[t.id]?.includes(s.id) ?? false,
        })),
      };
    }).sort((a, b) => a.label.localeCompare(b.label));

    const isTagMode = this.#selectionMode === SELECTION_MODE.TAG;
    const isImageMode = this.#selectionMode === SELECTION_MODE.IMAGE;

    const otherTagsList = tag.getOther();

    const selectedGender = state.gender.length === 1 ? state.gender[0] : 'any';
    let selectedGenderLabel = '';
    if (selectedGender !== 'any') {
      selectedGenderLabel = tag.getLabel(selectedGender);
    }

    const genderOptions = [
      { value: 'm', label: tag.getLabel('m'), isSelected: selectedGender === 'm' },
      { value: 'any', label: game.i18n.localize('cs-hero-box.form.labels.genderAny'), isSelected: selectedGender === 'any' },
      { value: 'f', label: tag.getLabel('f'), isSelected: selectedGender === 'f' },
    ];

    return {
      selectionMode: this.#selectionMode,
      isTagMode,
      isImageMode,
      raceTags,
      raceSearchQuery: state.raceSearchQuery ?? '',
      genderOptions,
      selectedGender,
      selectedGenderLabel,
      ageTags: this.#buildCheckboxOptions('age', AGE_TAGS, state.age),
      roleTags: this.#roleTags.map(t => ({
        id: t.id,
        label: tag.getLabel(t.id),
        isSelected: state.role.includes(t.id),
      })),
      otherTags: otherTagsList.map(t => ({
        id: t.id,
        label: tag.getLabel(t.id),
        isSelected: (state.other ?? []).includes(t.id),
      })),
      selectedRaceCount: state.race.length || 0,
      selectedAgeCount: state.age.length || 0,
      selectedRoleCount: state.role.length || 0,
      selectedOtherCount: (state.other ?? []).length || 0,
      nicknameChance: state.nicknameChance ?? 50,
      nicknameOnlyChance: state.nicknameOnlyChance ?? 0,
      noLastNameChance: state.noLastNameChance ?? 0,
      modeOptions: [
        {
          id: TOKEN_MODE.RANDOM,
          label: game.i18n.localize('cs-hero-box.mode.random'),
          tooltip: game.i18n.localize('cs-hero-box.mode.randomTooltip'),
          isChecked: state.mode === TOKEN_MODE.RANDOM,
        },
        {
          id: TOKEN_MODE.FIXED,
          label: game.i18n.localize('cs-hero-box.mode.fixed'),
          tooltip: game.i18n.localize('cs-hero-box.mode.fixedTooltip'),
          isChecked: state.mode === TOKEN_MODE.FIXED,
        },
      ],
      selectedModeValue: state.mode,
      sourceActor: state.sourceActor,
      selectedImages: this.#selectedImages,
      hasSelectedImages: this.#selectedImages.length > 0,
      buttons: [
        {
          type: 'button',
          icon: 'fa-solid fa-wand-magic-sparkles',
          label: this.#actor ? 'cs-hero-box.form.btn.update' : 'cs-hero-box.form.btn.generate',
          action: 'generate'
        },
      ],
    };
  }

  /** Persist checkbox/radio state from DOM (form submit path). */
  _onFormSubmit(event, form, formData) {
    this.#syncFormState();
  }

  /** Submit wizard: set `#result` and close. */
  _onGenerate() {
    this.#syncFormState();
    this.#result = {
      submitted: true,
      data: this.#buildOutput(),
    };
    this.close();
  }

  /** Clear linked source actor from form state. */
  _onClearSourceActor() {
    this.#formState.sourceActor = null;
    this.render();
  }

  /** @returns {Promise<void>} */
  async _onPickImages() {
    const { DataManager } = await import('../data-manager/data-manager.mjs');

    const selected = await DataManager.pick({
      initialFilters: {},
    });

    if (!selected?.length) return;

    const existingUuids = new Set(this.#selectedImages.map(img => img.uuid));

    for (const uuid of selected) {
      if (existingUuids.has(uuid)) continue;

      const imageData = await imagePicker.getByUuid(uuid);
      if (imageData) {
        this.#selectedImages.push({
          uuid,
          url: imageData.portraitUrl || imageData.tokenUrl,
          name: (imageData.portraitUrl || imageData.tokenUrl).split('/').pop(),
        });
      }
    }

    this.render();
  }

  /** Remove all picked images from image-selection mode. */
  _onClearImages() {
    this.#selectedImages = [];
    this.render();
  }

  /** Remove one image from `#selectedImages` by page uuid. */
  _onRemoveImage(event, target) {
    const uuid = target.dataset.uuid;
    this.#selectedImages = this.#selectedImages.filter(img => img.uuid !== uuid);
    this.render();
  }

  /** Switch between tag-based and explicit-image selection. */
  _onSetSelectionMode(event, target) {
    const mode = target.dataset.mode;
    if (mode && mode !== this.#selectionMode) {
      this.#selectionMode = mode;
      this.render();
    }
  }

  /** @returns {Promise<void>} */
  async #initializeFromActor() {
    if (!this.#actor) return;

    const criteria = getFlag(this.#actor, FLAGS.TOKEN_CRITERIA);
    if (!criteria) return;

    if (criteria.selectionMode === 'image') {
      this.#selectionMode = SELECTION_MODE.IMAGE;

      const imageUuids = criteria.selectedImageUuids ?? [];
      if (imageUuids.length > 0) {
        for (const uuid of imageUuids) {
          const imageData = await imagePicker.getByUuid(uuid);
          if (imageData) {
            this.#selectedImages.push({
              uuid,
              url: imageData.portraitUrl || imageData.tokenUrl,
              name: (imageData.portraitUrl || imageData.tokenUrl).split('/').pop(),
            });
          }
        }
      }
    } else {
      this.#selectionMode = SELECTION_MODE.TAG;
    }
  }

  #syncFormState() {
    if (!this.element) return;

    this.#formState.race = [];
    for (const cb of this.querySelectorAll('input[name^="race."]')) {
      if (cb.checked) {
        this.#formState.race.push(cb.name.replace('race.', ''));
      }
    }

    const validSubraces = new Set();
    for (const raceId of this.#formState.race) {
      tag.getSubraces(raceId).forEach(s => validSubraces.add(s.id));
    }

    this.#formState.subrace = {};
    for (const cb of this.querySelectorAll('input[name^="subrace."]')) {
      const parts = cb.name.replace('subrace.', '').split('.');
      const raceId = parts[0];
      const subraceId = parts[1];

      if (cb.checked && validSubraces.has(subraceId)) {
        if (!this.#formState.subrace[raceId]) {
          this.#formState.subrace[raceId] = [];
        }
        this.#formState.subrace[raceId].push(subraceId);
      }
    }

    const genderHidden = this.querySelector('input[name="selectedGender"]');
    const genderVal = genderHidden?.value ?? 'any';
    this.#formState.gender = genderVal === 'any' ? [] : [genderVal];

    this.#formState.age = [];
    for (const cb of this.querySelectorAll('input[name^="age."]')) {
      if (cb.checked) {
        this.#formState.age.push(cb.name.replace('age.', ''));
      }
    }

    this.#formState.role = [];
    for (const cb of this.querySelectorAll('input[name^="role."]')) {
      if (cb.checked) {
        this.#formState.role.push(cb.name.replace('role.', ''));
      }
    }

    this.#formState.other = [];
    for (const cb of this.querySelectorAll('input[name^="other."]')) {
      if (cb.checked) this.#formState.other.push(cb.name.replace('other.', ''));
    }

    const modeHidden = this.querySelector('input[name="selectedMode"]');
    if (modeHidden) this.#formState.mode = modeHidden.value;

    const nc = this.querySelector('input[name="nicknameChance"]');
    if (nc) this.#formState.nicknameChance = parseInt(nc.value) || 0;
    const noc = this.querySelector('input[name="nicknameOnlyChance"]');
    if (noc) this.#formState.nicknameOnlyChance = parseInt(noc.value) || 0;
    const nlc = this.querySelector('input[name="noLastNameChance"]');
    if (nlc) this.#formState.noLastNameChance = parseInt(nlc.value) || 0;
  }

  /**
   * @param {string} name
   * @param {Record<string, string>} values
   * @param {string[]} selectedValues
   */
  #buildCheckboxOptions(name, values, selectedValues) {
    return Object.entries(values).map(([key, id]) => ({
      id,
      label: tag.getLabel(id),
      isSelected: selectedValues.includes(id),
    }));
  }

  /** Populate `#raceTags` and `#roleTags` once. */
  #loadTagsIfNeeded() {
    if (!this.#raceTags.length) {
      this.#raceTags = tag.getRaces();
      this.#roleTags = tag.getRoles();
    }
  }

  /**
   * @param {boolean} [reset]
   * @returns {object}
   */
  #getInitialFormState(reset = false) {
    if (this.#actor && !reset) {
      const saved = getFlag(this.#actor, FLAGS.PREV_FORM_VALUES);
      if (saved) return this.#normalizeFormState(saved);
    }

    let nicknameChance = 50;
    let nicknameOnlyChance = 0;
    let noLastNameChance = 0;
    try {
      nicknameChance = getSetting(SETTINGS.NICKNAME_CHANCE) ?? 50;
      nicknameOnlyChance = getSetting(SETTINGS.NICKNAME_ONLY_CHANCE) ?? 0;
      noLastNameChance = getSetting(SETTINGS.NO_LAST_NAME_CHANCE) ?? 0;
    } catch {}

    return {
      race: [],
      subrace: {},
      gender: [],
      age: [],
      role: [],
      other: [],
      mode: TOKEN_MODE.RANDOM,
      sourceActor: null,
      raceSearchQuery: '',
      nicknameChance,
      nicknameOnlyChance,
      noLastNameChance,
    };
  }

  /** @param {object} saved @returns {object} */
  #normalizeFormState(saved) {
    return {
      race: saved.race ?? [],
      subrace: saved.subrace ?? {},
      gender: saved.gender ?? [],
      age: saved.age ?? [],
      role: saved.role ?? [],
      other: saved.other ?? [],
      mode: saved.mode ?? TOKEN_MODE.RANDOM,
      sourceActor: saved.sourceActor ?? null,
      raceSearchQuery: saved.raceSearchQuery ?? '',
      nicknameChance: saved.nicknameChance ?? 50,
      nicknameOnlyChance: saved.nicknameOnlyChance ?? 0,
      noLastNameChance: saved.noLastNameChance ?? 0,
    };
  }

  /** Payload for `actor.createOrUpdate` / token criteria flags. */
  #buildOutput() {
    const isImageMode = this.#selectionMode === SELECTION_MODE.IMAGE;
    const nc = this.#formState.nicknameChance ?? 50;
    const noc = this.#formState.nicknameOnlyChance ?? 0;
    const nlc = this.#formState.noLastNameChance ?? 0;

    try {
      setSetting(SETTINGS.NICKNAME_CHANCE, nc);
      setSetting(SETTINGS.NICKNAME_ONLY_CHANCE, noc);
      setSetting(SETTINGS.NO_LAST_NAME_CHANCE, nlc);
    } catch {}

    return {
      selectionMode: this.#selectionMode,
      race: isImageMode ? [] : this.#formState.race,
      subrace: isImageMode ? {} : this.#formState.subrace,
      gender: isImageMode ? [] : this.#formState.gender,
      age: isImageMode ? [] : this.#formState.age,
      role: isImageMode ? [] : this.#formState.role,
      other: isImageMode ? [] : (this.#formState.other ?? []),
      mode: this.#formState.mode,
      sourceActor: this.#formState.sourceActor,
      selectedImageUuids: isImageMode ? this.#selectedImages.map(img => img.uuid) : [],
      nicknameChance: nc,
      nicknameOnlyChance: noc,
      noLastNameChance: nlc,
    };
  }

  /** @returns {DragDrop[]} */
  #createDragDropHandlers() {
    return this.options.dragDrop.map(config => {
      return new DragDrop({
        ...config,
        permissions: { drop: () => true },
        callbacks: {
          drop: (event) => this.#onDropActor(event),
          dragover: (event) => this.#onDragOver(event),
        },
      });
    });
  }

  /** @param {DragEvent} event */
  #onDragOver(event) {
    const dropZone = event.target.closest('[data-drop-zone]');
    if (dropZone) {
      dropZone.classList.add('dragover');
    }
  }

  /** @param {DragEvent} event @returns {Promise<void>} */
  async #onDropActor(event) {
    event.preventDefault();

    const dropZone = event.target.closest('[data-drop-zone]');
    if (dropZone) {
      dropZone.classList.remove('dragover');
    }

    let data;
    try {
      data = JSON.parse(event.dataTransfer.getData('text/plain'));
    } catch {
      logger.warn('Failed to parse drop data');
      return;
    }

    if (data.type !== 'Actor') {
      ui.notifications.warn(game.i18n.localize('cs-hero-box.form.sourceActor.wrongType'));
      return;
    }

    try {
      const actorDoc = await fromUuid(data.uuid);
      if (!actorDoc) {
        logger.warn('Actor not found:', data.uuid);
        return;
      }

      this.#formState.sourceActor = {
        uuid: actorDoc.uuid,
        name: actorDoc.name,
        img: actorDoc.img,
      };

      this.render();
    } catch (error) {
      logger.error('Failed to process dropped actor:', error);
    }
  }

  #getAccordionId(legend) {
    const span = legend.querySelector('span');
    return span?.textContent?.trim() ?? '';
  }

  #saveAccordionState() {
    const expanded = [];
    const sections = this.querySelectorAll('.cs-hero-box-form__section:not(.cs-hero-box-form__section--static)');
    for (const section of sections) {
      if (!section.classList.contains('collapsed')) {
        expanded.push(section.dataset.sectionId);
      }
    }
    try {
      setSetting(SETTINGS.COLLAPSED_ACTOR_CONFIG, expanded);
    } catch {}
  }
}
