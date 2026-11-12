**
 * @fileoverview Hero Box actor wizard: random vs fixed token, tag or explicit image selection.
 */

import { MODULE_ID, FLAGS, TOKEN_MODE, SELECTION_MODE, PATHS, SETTINGS } from '../../constants/index.mjs';
import { AGE_TAGS } from '../../constants/tags.mjs';
import { logger } from '../../utils/index.mjs';
import { tag, imagePicker, actor as actorService } from '../../services/index.mjs';
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
      width: 500,
      height: 'auto',
    },
        actions: {
          generate: function() { this._onGenerate(); },
          clearSourceActor: function() { this._onClearSourceActor(); },
          pickImages: function() { this._onPickImages(); },
          clearImages: function() { this._onClearImages(); },
          removeImage: function(event, target) { this._onRemoveImage(event, target); },
          setSelectionMode: function(event, target) { this._onSetSelectionMode(event, target); },
          clearRandomCriteria: function() { this._onClearRandomCriteria(); },
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
  #roleGroupExpandOverrides = new Map();
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

    app.render({ force: true });
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
    this.#roleGroupExpandOverrides.clear();
    this.#selectionMode = SELECTION_MODE.TAG;
    this.#selectedImages = [];
    return super.close(options);
  }

  /** @param {object} context @param {object} options */
  _onRender(context, options) {
    super._onRender(context, options);
    this.#dragDrop.forEach(d => d.bind(this.element));
    this.#bindTriStateChips();
    this.#bindRoleGroupExpandButtons();
    this.#bindDropZoneEvents();
    this.#bindNicknameSliders();
    this.#bindRaceSearch();
    this.#bindAccordions();
    this.#bindGenderButtons();
    this.#bindModeButtons();
  }

  #shouldShowRoleGroupChildren(groupId, groupState, hasChildSelection) {
    if (this.#roleGroupExpandOverrides.has(groupId)) {
      return this.#roleGroupExpandOverrides.get(groupId);
    }
    return groupState === 'include' || hasChildSelection;
  }

  #bindRoleGroupExpandButtons() {
    for (const btn of this.querySelectorAll('[data-role-group-expand]')) {
      this.addEvent(btn, 'click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const groupId = btn.dataset.roleGroupExpand;
        const container = this.querySelector(`[data-role-group-parent="${groupId}"]`);
        if (!container) return;

        const isNowOpen = container.style.display === 'none';
        container.style.display = isNowOpen ? '' : 'none';
        btn.classList.toggle('expanded', isNowOpen);
        this.#roleGroupExpandOverrides.set(groupId, isNowOpen);
      });
    }
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
    this.#bindHierarchySearch({
      sectionId: 'race',
      stateKey: 'raceSearchQuery',
      parentSelector: '.cs-hero-box-form__tri-chip--race',
      childSelector: '.cs-hero-box-form__tri-chip--subrace',
    });
    this.#bindHierarchySearch({
      sectionId: 'role',
      stateKey: 'roleSearchQuery',
      parentSelector: '.cs-hero-box-form__tri-chip--race',
      childSelector: '.cs-hero-box-form__tri-chip--subrace',
    });
  }

  #bindHierarchySearch({ sectionId, stateKey, parentSelector, childSelector }) {
    const section = this.querySelector(`[data-section-id="${sectionId}"]`);
    const searchInput = section?.querySelector('.cs-hero-box-form__race-search');
    if (!searchInput) return;

    const applyFilter = (rawQuery) => {
      const query = (rawQuery ?? '').toLowerCase().trim();
      this.#formState[stateKey] = query;
      const items = section.querySelectorAll('.cs-hero-box-form__race-item');

      for (const item of items) {
        const parentChip = item.querySelector(parentSelector);
        const parentLabel = parentChip?.textContent?.toLowerCase() ?? '';
        const childContainer = item.querySelector('.cs-hero-box-form__subraces');
        let childMatch = false;
        let hasActiveChild = false;

        if (childContainer) {
          const childChips = childContainer.querySelectorAll(childSelector);
          for (const childEl of childChips) {
            if (childEl.dataset.state && childEl.dataset.state !== 'none') {
              hasActiveChild = true;
            }
            const childText = childEl.textContent?.toLowerCase() ?? '';
            if (query && childText.includes(query)) {
              childMatch = true;
              childEl.style.display = '';
            } else if (query) {
              childEl.style.display = 'none';
            } else {
              childEl.style.display = '';
            }
          }
        }

        const parentMatch = !query || parentLabel.includes(query);
        const expandBtn = item.querySelector('.cs-hero-box-form__group-expand-btn');
        const groupId = parentChip?.dataset?.group === 'roleGroup' ? parentChip.dataset.tagId : null;
        const shouldExpandDefault = groupId
          ? this.#shouldShowRoleGroupChildren(groupId, parentChip?.dataset.state ?? 'none', hasActiveChild)
          : (parentChip?.dataset.state === 'include' || hasActiveChild);

        if (parentMatch || childMatch) {
          item.style.display = '';
          if (childContainer) {
            let isExpanded = false;
            if (query) {
              if (childMatch) {
                childContainer.style.display = '';
                isExpanded = true;
              } else {
                childContainer.style.display = shouldExpandDefault ? '' : 'none';
                isExpanded = shouldExpandDefault;
                if (shouldExpandDefault) {
                  childContainer.querySelectorAll(childSelector).forEach(el => {
                    el.style.display = '';
                  });
                }
              }
            } else {
              childContainer.style.display = shouldExpandDefault ? '' : 'none';
              isExpanded = shouldExpandDefault;
              childContainer.querySelectorAll(childSelector).forEach(el => {
                el.style.display = '';
              });
            }
            expandBtn?.classList.toggle('expanded', isExpanded);
          }
        } else {
          item.style.display = 'none';
        }
      }
    };

    if (this.#formState[stateKey]) {
      applyFilter(this.#formState[stateKey]);
    }

    this.addEvent(searchInput, 'input', (e) => applyFilter(e.target.value));
  }

  /** @returns {Promise<object>} */
  async _prepareContext(options) {
    if (this.#initPromise) {
      await this.#initPromise;
      this.#initPromise = null;
    }

    this.#loadTagsIfNeeded();
    const state = this.#formState;

    const { tagIndex } = await import('../../services/index.mjs');
    const stats = tagIndex.getStats();
    const tagCounts = stats.tagCounts;

    const raceTags = this.#raceTags
      .filter(t => (tagCounts.get(t.id) ?? 0) > 0)
      .map(t => {
        const raceState = this.#getTagState(t.id, state.race, state.raceExclude);
        const isIncluded = raceState === 'include';
        const subraces = tag.getSubraces(t.id).filter(s => (tagCounts.get(s.id) ?? 0) > 0);
        return {
          id: t.id,
          label: tag.getLabel(t.id),
          tagState: raceState,
          hasSubraces: subraces.length > 0,
          showSubraces: isIncluded && subraces.length > 0,
          subraces: subraces.map(s => ({
            id: s.id,
            label: tag.getLabel(s.id),
            tagState: this.#getTagState(s.id, state.subrace?.[t.id] ?? [], state.subraceExclude ?? []),
          })),
        };
      }).sort((a, b) => a.label.localeCompare(b.label));

    const isTagMode = this.#selectionMode === SELECTION_MODE.TAG;
    const isImageMode = this.#selectionMode === SELECTION_MODE.IMAGE;

    const otherTagsList = tag.getOther().filter(t => (tagCounts.get(t.id) ?? 0) > 0);

    const selectedGender = state.gender.length === 1 ? state.gender[0] : 'any';

    const genderOptions = [
      { value: 'm', label: tag.getLabel('m'), isSelected: selectedGender === 'm' },
      { value: 'any', label: game.i18n.localize('cs-hero-box.form.labels.genderAny'), isSelected: selectedGender === 'any' },
      { value: 'f', label: tag.getLabel('f'), isSelected: selectedGender === 'f' },
    ];

    const ageIcons = { c: 'fa-baby', t: 'fa-child', y: 'fa-person', a: 'fa-regular fa-person', o: 'fa-person-cane' };
    const ageTags = Object.entries(AGE_TAGS).map(([key, id]) => ({
      id,
      label: tag.getLabel(id),
      icon: ageIcons[id] ?? 'fa-user',
      tagState: this.#getTagState(id, state.age, state.ageExclude),
    }));

    const roleGroupItems = tag.getRoleGroups()
      .map(g => {
        const groupState = this.#getTagState(g.id, state.roleGroup, state.roleGroupExclude);
        const roles = tag.getRoles(g.id)
          .filter(r => (tagCounts.get(r.id) ?? 0) > 0)
          .map(r => ({
            id: r.id,
            label: tag.getLabel(r.id),
            tagState: this.#getTagState(r.id, state.role, state.roleExclude),
          }))
          .sort((a, b) => a.label.localeCompare(b.label));

        if ((tagCounts.get(g.id) ?? 0) === 0 && roles.length === 0) {
          return null;
        }

        const hasChildSelection = roles.some(r => r.tagState !== 'none');
        const hasRoles = roles.length > 0;
        return {
          id: g.id,
          label: tag.getLabel(g.id),
          isRoleGroup: true,
          tagState: groupState,
          hasRoles,
          showRoles: hasRoles && this.#shouldShowRoleGroupChildren(g.id, groupState, hasChildSelection),
          roles,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.label.localeCompare(b.label));

    const ungroupedRoleItems = tag.getUngroupedRoles()
      .filter(r => (tagCounts.get(r.id) ?? 0) > 0)
      .map(r => ({
        id: r.id,
        label: tag.getLabel(r.id),
        isRoleGroup: false,
        tagState: this.#getTagState(r.id, state.role, state.roleExclude),
        hasRoles: false,
        showRoles: false,
        roles: [],
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const roleTagsFiltered = [...roleGroupItems, ...ungroupedRoleItems];

    const otherTagsMapped = otherTagsList.map(t => ({
      id: t.id,
      label: tag.getLabel(t.id),
      tagState: this.#getTagState(t.id, state.other, state.otherExclude),
    }));

    const selectedRaceCount = (state.race?.length ?? 0) + (state.raceExclude?.length ?? 0);
    const selectedAgeCount = (state.age?.length ?? 0) + (state.ageExclude?.length ?? 0);
    const subraceIncludeCount = Object.values(state.subrace ?? {}).reduce((acc, arr) => acc + arr.length, 0);
    const subraceExcludeCount = state.subraceExclude?.length ?? 0;
    const roleGroupCount = (state.roleGroup?.length ?? 0) + (state.roleGroupExclude?.length ?? 0);

    const hasRandomCriteria = this.#actor
      ? !!actorService.getEffectiveCriteria(this.#actor)
      : false;

    return {
      selectionMode: this.#selectionMode,
      isTagMode,
      isImageMode,
      raceTags,
      raceSearchQuery: state.raceSearchQuery ?? '',
      roleSearchQuery: state.roleSearchQuery ?? '',
      genderOptions,
      selectedGender,
      ageTags,
      roleTags: roleTagsFiltered,
      otherTags: otherTagsMapped,
      selectedRaceCount: selectedRaceCount + subraceIncludeCount + subraceExcludeCount,
      selectedAgeCount,
      selectedRoleCount: roleGroupCount + (state.role?.length ?? 0) + (state.roleExclude?.length ?? 0),
      selectedOtherCount: (state.other?.length ?? 0) + (state.otherExclude?.length ?? 0),
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
      isEditing: !!this.#actor,
      hasRandomCriteria,
      buttons: [
        {
          type: 'button',
          icon: 'fa-solid fa-user',
          label: this.#actor ? 'cs-hero-box.form.btn.update' : 'cs-hero-box.form.btn.generate',
          action: 'generate',
          cssClass: 'cs-hero-box-form__generate-btn',
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

    const criteria = actorService.getEffectiveCriteria(this.#actor);
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

    const state = this.#formState;

    state.race = [];
    state.raceExclude = [];
    state.subraceExclude = [];

    for (const chip of this.querySelectorAll('.cs-hero-box-form__tri-chip[data-group="race"]')) {
      const tagId = chip.dataset.tagId;
      const chipState = chip.dataset.state ?? 'none';
      if (chipState === 'include') state.race.push(tagId);
      else if (chipState === 'exclude') state.raceExclude.push(tagId);
    }

    const validSubraces = new Set();
    for (const raceId of state.race) {
      tag.getSubraces(raceId).forEach(s => validSubraces.add(s.id));
    }

    state.subrace = {};
    for (const chip of this.querySelectorAll('.cs-hero-box-form__tri-chip[data-group="subrace"]')) {
      const tagId = chip.dataset.tagId;
      const chipState = chip.dataset.state ?? 'none';
      if (!validSubraces.has(tagId)) continue;

      const parentEl = chip.closest('[data-subrace-parent]');
      const parentRaceId = parentEl?.dataset?.subraceParent;

      if (chipState === 'include' && parentRaceId) {
        if (!state.subrace[parentRaceId]) state.subrace[parentRaceId] = [];
        state.subrace[parentRaceId].push(tagId);
      } else if (chipState === 'exclude') {
        state.subraceExclude.push(tagId);
      }
    }

    const genderHidden = this.querySelector('input[name="selectedGender"]');
    const genderVal = genderHidden?.value ?? 'any';
    state.gender = genderVal === 'any' ? [] : [genderVal];

    state.age = [];
    state.ageExclude = [];
    for (const chip of this.querySelectorAll('.cs-hero-box-form__tri-chip[data-group="age"]')) {
      const tagId = chip.dataset.tagId;
      const chipState = chip.dataset.state ?? 'none';
      if (chipState === 'include') state.age.push(tagId);
      else if (chipState === 'exclude') state.ageExclude.push(tagId);
    }

    state.roleGroup = [];
    state.roleGroupExclude = [];
    for (const chip of this.querySelectorAll('.cs-hero-box-form__tri-chip[data-group="roleGroup"]')) {
      const tagId = chip.dataset.tagId;
      const chipState = chip.dataset.state ?? 'none';
      if (chipState === 'include') state.roleGroup.push(tagId);
      else if (chipState === 'exclude') state.roleGroupExclude.push(tagId);
    }

    state.role = [];
    state.roleExclude = [];
    for (const chip of this.querySelectorAll('.cs-hero-box-form__tri-chip[data-group="role"]')) {
      const tagId = chip.dataset.tagId;
      const chipState = chip.dataset.state ?? 'none';
      if (chipState === 'include') state.role.push(tagId);
      else if (chipState === 'exclude') state.roleExclude.push(tagId);
    }

    state.other = [];
    state.otherExclude = [];
    for (const chip of this.querySelectorAll('.cs-hero-box-form__tri-chip[data-group="other"]')) {
      const tagId = chip.dataset.tagId;
      const chipState = chip.dataset.state ?? 'none';
      if (chipState === 'include') state.other.push(tagId);
      else if (chipState === 'exclude') state.otherExclude.push(tagId);
    }

    const modeHidden = this.querySelector('input[name="selectedMode"]');
    if (modeHidden) state.mode = modeHidden.value;

    const nc = this.querySelector('input[name="nicknameChance"]');
    if (nc) state.nicknameChance = parseInt(nc.value) || 0;
    const noc = this.querySelector('input[name="nicknameOnlyChance"]');
    if (noc) state.nicknameOnlyChance = parseInt(noc.value) || 0;
    const nlc = this.querySelector('input[name="noLastNameChance"]');
    if (nlc) state.noLastNameChance = parseInt(nlc.value) || 0;
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
      const saved = actorService.getEffectiveFormValues(this.#actor);
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
      raceExclude: [],
      subrace: {},
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
      mode: TOKEN_MODE.RANDOM,
      sourceActor: null,
      raceSearchQuery: '',
      roleSearchQuery: '',
      nicknameChance,
      nicknameOnlyChance,
      noLastNameChance,
    };
  }

  /** @param {object} saved @returns {object} */
  #normalizeFormState(saved) {
    return {
      race: saved.race ?? [],
      raceExclude: saved.raceExclude ?? [],
      subrace: saved.subrace ?? {},
      subraceExclude: saved.subraceExclude ?? [],
      gender: saved.gender ?? [],
      age: saved.age ?? [],
      ageExclude: saved.ageExclude ?? [],
      roleGroup: saved.roleGroup ?? [],
      roleGroupExclude: saved.roleGroupExclude ?? [],
      role: saved.role ?? [],
      roleExclude: saved.roleExclude ?? [],
      other: saved.other ?? [],
      otherExclude: saved.otherExclude ?? [],
      mode: saved.mode ?? TOKEN_MODE.RANDOM,
      sourceActor: saved.sourceActor ?? null,
      raceSearchQuery: saved.raceSearchQuery ?? '',
      roleSearchQuery: saved.roleSearchQuery ?? '',
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
      raceExclude: isImageMode ? [] : (this.#formState.raceExclude ?? []),
      subrace: isImageMode ? {} : this.#formState.subrace,
      subraceExclude: isImageMode ? [] : (this.#formState.subraceExclude ?? []),
      gender: isImageMode ? [] : this.#formState.gender,
      age: isImageMode ? [] : this.#formState.age,
      ageExclude: isImageMode ? [] : (this.#formState.ageExclude ?? []),
      roleGroup: isImageMode ? [] : (this.#formState.roleGroup ?? []),
      roleGroupExclude: isImageMode ? [] : (this.#formState.roleGroupExclude ?? []),
      role: isImageMode ? [] : this.#formState.role,
      roleExclude: isImageMode ? [] : (this.#formState.roleExclude ?? []),
      other: isImageMode ? [] : (this.#formState.other ?? []),
      otherExclude: isImageMode ? [] : (this.#formState.otherExclude ?? []),
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
    const DragDropImpl = foundry.applications?.ux?.DragDrop?.implementation ?? globalThis.DragDrop;
    return this.options.dragDrop.map(config => {
      return new DragDropImpl({
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

      this.#syncFormState();

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

  #getTagState(tagId, includeList, excludeList) {
    if ((includeList ?? []).includes(tagId)) return 'include';
    if ((excludeList ?? []).includes(tagId)) return 'exclude';
    return 'none';
  }

  #bindTriStateChips() {
    const chips = this.querySelectorAll('.cs-hero-box-form__tri-chip');
    for (const chip of chips) {
      this.addEvent(chip, 'click', (e) => {
        e.preventDefault();
        const current = chip.dataset.state ?? 'none';
        const next = current === 'none' ? 'include' : current === 'include' ? 'exclude' : 'none';
        chip.dataset.state = next;

        const tagId = chip.dataset.tagId;
        const group = chip.dataset.group;

        if (group === 'race') {
          this.#formState.race = this.#formState.race.filter(id => id !== tagId);
          this.#formState.raceExclude = (this.#formState.raceExclude ?? []).filter(id => id !== tagId);
          if (next === 'include') this.#formState.race.push(tagId);
          else if (next === 'exclude') this.#formState.raceExclude.push(tagId);

          const subraceContainer = this.querySelector(`[data-subrace-parent="${tagId}"]`);
          if (subraceContainer) {
            subraceContainer.style.display = next === 'include' ? '' : 'none';
            if (next !== 'include') {
              for (const sub of subraceContainer.querySelectorAll('.cs-hero-box-form__tri-chip')) {
                sub.dataset.state = 'none';
                const subId = sub.dataset.tagId;
                if (this.#formState.subrace) {
                  for (const raceId of Object.keys(this.#formState.subrace)) {
                    this.#formState.subrace[raceId] = (this.#formState.subrace[raceId] ?? []).filter(id => id !== subId);
                  }
                }
                this.#formState.subraceExclude = (this.#formState.subraceExclude ?? []).filter(id => id !== subId);
              }
            }
          }

          this.#updateBadge('race');
          return;
        }

        if (group === 'subrace') {
          if (this.#formState.subrace) {
            for (const raceId of Object.keys(this.#formState.subrace)) {
              this.#formState.subrace[raceId] = (this.#formState.subrace[raceId] ?? []).filter(id => id !== tagId);
            }
          }
          this.#formState.subraceExclude = (this.#formState.subraceExclude ?? []).filter(id => id !== tagId);

          if (next === 'include') {
            const parentEl = chip.closest('[data-subrace-parent]');
            const parentRaceId = parentEl?.dataset?.subraceParent;
            if (parentRaceId) {
              if (!this.#formState.subrace) this.#formState.subrace = {};
              if (!this.#formState.subrace[parentRaceId]) this.#formState.subrace[parentRaceId] = [];
              this.#formState.subrace[parentRaceId].push(tagId);
            }
          } else if (next === 'exclude') {
            if (!this.#formState.subraceExclude) this.#formState.subraceExclude = [];
            this.#formState.subraceExclude.push(tagId);
          }

          this.#updateBadge('race');
          return;
        }

        if (group === 'roleGroup') {
          this.#formState.roleGroup = (this.#formState.roleGroup ?? []).filter(id => id !== tagId);
          this.#formState.roleGroupExclude = (this.#formState.roleGroupExclude ?? []).filter(id => id !== tagId);
          if (next === 'include') this.#formState.roleGroup.push(tagId);
          else if (next === 'exclude') this.#formState.roleGroupExclude.push(tagId);

          const roleGroupContainer = this.querySelector(`[data-role-group-parent="${tagId}"]`);
          const expandBtn = this.querySelector(`[data-role-group-expand="${tagId}"]`);
          if (roleGroupContainer) {
            if (next === 'include') {
              roleGroupContainer.style.display = '';
              expandBtn?.classList.add('expanded');
              this.#roleGroupExpandOverrides.set(tagId, true);
            } else if (next === 'exclude') {
              for (const sub of roleGroupContainer.querySelectorAll('.cs-hero-box-form__tri-chip')) {
                if (sub.dataset.state === 'include') {
                  sub.dataset.state = 'none';
                  const subId = sub.dataset.tagId;
                  this.#formState.role = (this.#formState.role ?? []).filter(id => id !== subId);
                }
              }
              roleGroupContainer.style.display = 'none';
              expandBtn?.classList.remove('expanded');
              this.#roleGroupExpandOverrides.set(tagId, false);
            } else {
              const hasActiveChild = Array.from(roleGroupContainer.querySelectorAll('.cs-hero-box-form__tri-chip'))
                .some(sub => sub.dataset.state && sub.dataset.state !== 'none');
              if (!hasActiveChild) {
                roleGroupContainer.style.display = 'none';
                expandBtn?.classList.remove('expanded');
                this.#roleGroupExpandOverrides.delete(tagId);
              }
            }
          }

          this.#updateBadge('role');
          return;
        }

        if (group === 'role') {
          this.#formState.role = (this.#formState.role ?? []).filter(id => id !== tagId);
          this.#formState.roleExclude = (this.#formState.roleExclude ?? []).filter(id => id !== tagId);
          if (next === 'include') this.#formState.role.push(tagId);
          else if (next === 'exclude') this.#formState.roleExclude.push(tagId);

          this.#updateBadge('role');
          return;
        }

        const includeKey = group;
        const excludeKey = `${group}Exclude`;
        this.#formState[includeKey] = (this.#formState[includeKey] ?? []).filter(id => id !== tagId);
        this.#formState[excludeKey] = (this.#formState[excludeKey] ?? []).filter(id => id !== tagId);
        if (next === 'include') this.#formState[includeKey].push(tagId);
        else if (next === 'exclude') this.#formState[excludeKey].push(tagId);

        this.#updateBadge(group);
      });
    }
  }

  

  #updateBadge(group) {
    let count = 0;
    let sectionId = group;

    if (group === 'race') {
      count = (this.#formState.race?.length ?? 0)
        + (this.#formState.raceExclude?.length ?? 0)
        + Object.values(this.#formState.subrace ?? {}).reduce((acc, arr) => acc + arr.length, 0)
        + (this.#formState.subraceExclude?.length ?? 0);
      sectionId = 'race';
    } else if (group === 'age') {
      count = (this.#formState.age?.length ?? 0) + (this.#formState.ageExclude?.length ?? 0);
      sectionId = 'age';
    } else if (group === 'role' || group === 'roleGroup') {
      count = (this.#formState.roleGroup?.length ?? 0)
        + (this.#formState.roleGroupExclude?.length ?? 0)
        + (this.#formState.role?.length ?? 0)
        + (this.#formState.roleExclude?.length ?? 0);
      sectionId = 'role';
    } else if (group === 'other') {
      count = (this.#formState.other?.length ?? 0) + (this.#formState.otherExclude?.length ?? 0);
      sectionId = 'other';
    }

    const section = this.querySelector(`[data-section-id="${sectionId}"]`);
    if (!section) return;

    const header = section.querySelector('.cs-hero-box-form__section-header h4');
    if (!header) return;

    let badge = header.querySelector('.cs-hero-box-form__badge');

    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'cs-hero-box-form__badge';
        header.appendChild(badge);
      }
      badge.textContent = count;
    } else {
      badge?.remove();
    }
  }

  async _onClearRandomCriteria() {
    if (!this.#actor) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize('cs-hero-box.form.clearRandom.title') },
      content: `<p>${game.i18n.localize('cs-hero-box.form.clearRandom.content')}</p>`,
      yes: { default: true },
      no: { default: false },
    });

    if (!confirmed) return;

    await this.#actor.unsetFlag(MODULE_ID, FLAGS.TOKEN_CRITERIA);
    await this.#actor.unsetFlag(MODULE_ID, FLAGS.PREV_FORM_VALUES);
    if (!this.#actor.pack) {
      await this.#actor.setFlag(MODULE_ID, FLAGS.LOCAL_OVERRIDE, true);
    }

    ui.notifications.info(game.i18n.localize('cs-hero-box.form.clearRandom.success'));
    this.close();
  }


}
