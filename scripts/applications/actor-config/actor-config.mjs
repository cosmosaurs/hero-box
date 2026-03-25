import { MODULE_ID, FLAGS, TOKEN_MODE, SELECTION_MODE, PATHS } from '../../constants/index.mjs';
import { GENDER_TAGS, AGE_TAGS } from '../../constants/tags.mjs';
import { logger, getFlag } from '../../utils/index.mjs';
import { tag, imagePicker } from '../../services/index.mjs';
import { BaseFormApplication } from '../base/base.mjs';

// the main dialog for creating/editing random actors
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

  constructor(actor = null) {
    super();
    this.#actor = actor;
    this.#formState = this.#getInitialFormState();
    this.#dragDrop = this.#createDragDropHandlers();
    this.#initPromise = this.#initializeFromActor();
  }

  // open the dialog and return a promise with the result
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

  get title() {
    if (this.#actor) {
      return game.i18n.format('cs-hero-box.form.titleEdit', { name: this.#actor.name });
    }
    return game.i18n.localize('cs-hero-box.form.title');
  }

  // reset state when closing
  async close(options = {}) {
    this.#formState = this.#getInitialFormState();
    this.#selectionMode = SELECTION_MODE.TAG;
    this.#selectedImages = [];
    return super.close(options);
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this.#dragDrop.forEach(d => d.bind(this.element));
    this.#bindRaceCheckboxes();
    this.#bindDropZoneEvents();
  }

  // add visual feedback for drag and drop
  #bindDropZoneEvents() {
    const dropZone = this.querySelector('[data-drop-zone]');
    if (!dropZone) return;

    this.addEvent(dropZone, 'dragenter', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });

    this.addEvent(dropZone, 'dragleave', (e) => {
      const rect = dropZone.getBoundingClientRect();
      const x = e.clientX;
      const y = e.clientY;

      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
        dropZone.classList.remove('dragover');
      }
    });

    this.addEvent(dropZone, 'drop', () => {
      dropZone.classList.remove('dragover');
    });

    this.addEvent(dropZone, 'dragover', (e) => {
      e.preventDefault();
    });
  }

  async _prepareContext(options) {
    // wait for actor data to load if editing
    if (this.#initPromise) {
      await this.#initPromise;
      this.#initPromise = null;
    }

    this.#loadTagsIfNeeded();
    const state = this.#formState;

    // build race tags with nested subraces
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

    return {
      selectionMode: this.#selectionMode,
      isTagMode,
      isImageMode,
      raceTags,
      genderTags: this.#buildCheckboxOptions('gender', GENDER_TAGS, state.gender),
      ageTags: this.#buildCheckboxOptions('age', AGE_TAGS, state.age),
      roleTags: this.#roleTags.map(t => ({
        id: t.id,
        label: tag.getLabel(t.id),
        isSelected: state.role.includes(t.id),
      })),
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

  // sync form state when user interacts with checkboxes
  _onFormSubmit(event, form, formData) {
    this.#syncFormState();
  }

  // user clicked the generate button — pack up the data and close
  _onGenerate() {
    this.#result = {
      submitted: true,
      data: this.#buildOutput(),
    };
    this.close();
  }

  _onClearSourceActor() {
    this.#formState.sourceActor = null;
    this.render();
  }

  // open the image picker dialog
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

  _onClearImages() {
    this.#selectedImages = [];
    this.render();
  }

  _onRemoveImage(event, target) {
    const uuid = target.dataset.uuid;
    this.#selectedImages = this.#selectedImages.filter(img => img.uuid !== uuid);
    this.render();
  }

  _onSetSelectionMode(event, target) {
    const mode = target.dataset.mode;
    if (mode && mode !== this.#selectionMode) {
      this.#selectionMode = mode;
      this.render();
    }
  }

  // load existing criteria if editing an actor
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

  // show/hide subraces when race checkboxes change
  #bindRaceCheckboxes() {
    const raceCheckboxes = this.querySelectorAll('input[data-race-id]');

    for (const checkbox of raceCheckboxes) {
      this.addEvent(checkbox, 'change', () => {
        this.#syncFormState();
        this.render();
      });
    }
  }

  // read all checkbox states into our form state object
  #syncFormState() {
    if (!this.element) return;

    this.#formState.race = [];
    for (const cb of this.querySelectorAll('input[name^="race."]')) {
      if (cb.checked) {
        this.#formState.race.push(cb.name.replace('race.', ''));
      }
    }

    // only keep subraces for selected races
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

    this.#formState.gender = [];
    for (const cb of this.querySelectorAll('input[name^="gender."]')) {
      if (cb.checked) {
        this.#formState.gender.push(cb.name.replace('gender.', ''));
      }
    }

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

    for (const radio of this.querySelectorAll('input[name="mode"]')) {
      if (radio.checked) {
        this.#formState.mode = radio.value === '0' ? TOKEN_MODE.RANDOM : TOKEN_MODE.FIXED;
      }
    }
  }

  // convert tag constants to checkbox template data
  #buildCheckboxOptions(name, values, selectedValues) {
    return Object.entries(values).map(([key, id]) => ({
      id,
      label: tag.getLabel(id),
      isSelected: selectedValues.includes(id),
    }));
  }

  // lazy load tags on first render
  #loadTagsIfNeeded() {
    if (!this.#raceTags.length) {
      this.#raceTags = tag.getRaces();
      this.#roleTags = tag.getRoles();
    }
  }

  // get initial form state, loading from actor if editing
  #getInitialFormState(reset = false) {
    if (this.#actor && !reset) {
      const saved = getFlag(this.#actor, FLAGS.PREV_FORM_VALUES);
      if (saved) return this.#normalizeFormState(saved);
    }

    return {
      race: [],
      subrace: {},
      gender: [],
      age: [],
      role: [],
      mode: TOKEN_MODE.RANDOM,
      sourceActor: null,
    };
  }

  // ensure all expected fields exist
  #normalizeFormState(saved) {
    return {
      race: saved.race ?? [],
      subrace: saved.subrace ?? {},
      gender: saved.gender ?? [],
      age: saved.age ?? [],
      role: saved.role ?? [],
      mode: saved.mode ?? TOKEN_MODE.RANDOM,
      sourceActor: saved.sourceActor ?? null,
    };
  }

  // pack up the form state for the actor service
  #buildOutput() {
    const isImageMode = this.#selectionMode === SELECTION_MODE.IMAGE;

    return {
      selectionMode: this.#selectionMode,
      race: isImageMode ? [] : this.#formState.race,
      subrace: isImageMode ? {} : this.#formState.subrace,
      gender: isImageMode ? [] : this.#formState.gender,
      age: isImageMode ? [] : this.#formState.age,
      role: isImageMode ? [] : this.#formState.role,
      mode: this.#formState.mode,
      sourceActor: this.#formState.sourceActor,
      selectedImageUuids: isImageMode ? this.#selectedImages.map(img => img.uuid) : [],
    };
  }

  // set up drag and drop handlers for the source actor drop zone
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

  #onDragOver(event) {
    const dropZone = event.target.closest('[data-drop-zone]');
    if (dropZone) {
      dropZone.classList.add('dragover');
    }
  }

  // handle dropping an actor onto the source actor zone
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
}