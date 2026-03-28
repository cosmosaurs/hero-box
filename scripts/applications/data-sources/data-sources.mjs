import { MODULE_ID, FLAGS, PATHS } from '../../constants/index.mjs';
import { journalHasModuleData } from '../../utils/source.mjs';
import { tagIndex, tag, source, nameGenerator } from '../../services/index.mjs';
import { BaseFormApplication } from '../base/base.mjs';

// settings dialog for managing which journals/compendiums the module pulls data from
export class DataSources extends BaseFormApplication {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-data-sources`,
    form: {
      handler: function(event, form, formData) {
        return this._onFormSubmit(event, form, formData);
      },
      closeOnSubmit: false,
    },
    window: {
      title: 'cs-hero-box.dataSources.title',
      resizable: false,
      minimizable: true,
    },
    position: {
      width: 550,
      height: 500,
    },
    actions: {
      addSource: function() { this._onAddSource(); },
      removeSource: function(event, target) { this._onRemoveSource(event, target); },
      toggleSource: function(event, target) { this._onToggleSource(event, target); },
      moveSource: function(event, target) { this._onMoveSource(event, target); },
      createWorldJournal: function() { this._onCreateWorldJournal(); },
      scanJournals: function() { this._onScanJournals(); },
    },
  };

  static PARTS = {
    form: {
      template: `${PATHS.TEMPLATES}/data-sources/data-sources.hbs`,
    },
    footer: {
      template: 'templates/generic/form-footer.hbs',
    },
  };

  #pendingReload = false;

  get title() {
    return game.i18n.localize('cs-hero-box.dataSources.title');
  }

  _prepareContext(options) {
    const allSources = source.getAllSources();
    const total = allSources.length;

    return {
      dataSources: allSources.map((s, index) => source.enrichSourceData(s, index, total)),
      buttons: [
        { type: 'submit', icon: 'fa-solid fa-save', label: 'Save' },
      ],
    };
  }

  // save and reload all services if sources changed
  async _onFormSubmit(event, form, formData) {
    const submitBtn = this.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    const needsReload = this.#pendingReload;
    this.#pendingReload = false;

    this.close();

    if (needsReload) {
      setTimeout(async () => {
        await tag.reload();
        await tagIndex.reindex();
        await nameGenerator.reload();

        this.#refreshDataManager();
        ui.notifications.info(game.i18n.localize('cs-hero-box.dataSources.saved'));
      }, 50);
    } else {
      ui.notifications.info(game.i18n.localize('cs-hero-box.dataSources.saved'));
    }

    return false;
  }

  // open dialog to pick a new source to add
  async _onAddSource() {
    const sourceId = await this.#selectSource();
    if (sourceId) {
      const added = await source.addSource(sourceId);
      if (added) {
        this.#pendingReload = true;
        this.render();
      }
    }
  }

  async _onRemoveSource(event, target) {
    const sourceId = target.dataset.sourceId;
    await source.removeSource(sourceId);
    this.#pendingReload = true;
    this.render();
  }

  async _onToggleSource(event, target) {
    const sourceId = target.dataset.sourceId;
    const enabled = target.checked;
    await source.setSourceEnabled(sourceId, enabled);
    this.#pendingReload = true;
    this.render();
  }

  async _onMoveSource(event, target) {
    const sourceId = target.dataset.sourceId;
    const direction = target.dataset.direction;
    const moved = await source.moveSource(sourceId, direction);
    if (moved) {
      this.#pendingReload = true;
      this.render();
    }
  }

  // create a fresh world journal to store data in
  async _onCreateWorldJournal() {
    const result = await foundry.applications.api.DialogV2.prompt({
      window: { title: game.i18n.localize('cs-hero-box.dataSources.createJournal.title') },
      content: `
        <div class="form-group">
          <label>${game.i18n.localize('cs-hero-box.dataSources.createJournal.nameLabel')}</label>
          <input type="text" name="name" value="CS HIAB Data" autofocus />
        </div>
      `,
      ok: {
        label: game.i18n.localize('cs-hero-box.dataSources.createJournal.button'),
        callback: (event, button) => button.form.elements.name.value,
      },
      rejectClose: false,
    });

    if (!result) return;

    const journal = await JournalEntry.create({
      name: result,
      flags: { [MODULE_ID]: { [FLAGS.IS_DATA_SOURCE]: true } },
    });

    await source.addSource(journal.uuid);
    this.#pendingReload = true;
    ui.notifications.info(game.i18n.format('cs-hero-box.dataSources.createJournal.success', { name: result }));
    this.render();
  }

  // scan world for journals that have our flags and auto-add them
  async _onScanJournals() {
    let found = 0;
    const allSources = source.getAllSources();
    const existingIds = new Set(allSources.map(s => s.id));

    for (const journal of game.journal) {
      const journalId = journal.uuid;
      if (existingIds.has(journalId)) continue;

      const hasData = journalHasModuleData(journal);
      if (hasData) {
        await source.addSource(journalId);
        existingIds.add(journalId);
        found++;
      }
    }

    for (const pack of game.packs) {
      if (pack.documentName !== 'JournalEntry') continue;

      const packId = `Compendium.${pack.collection}`;
      if (existingIds.has(packId)) continue;

      try {
        const hasData = await this.#compendiumHasModuleData(pack);
        if (hasData) {
          await source.addSource(packId);
          existingIds.add(packId);
          found++;
        }
      } catch (error) {
        console.warn(`Failed to scan compendium ${pack.collection}:`, error);
      }
    }

    if (found > 0) {
      ui.notifications.info(game.i18n.format('cs-hero-box.dataSources.autoDiscovered', { count: found }));
      this.#pendingReload = true;
      this.render();
    } else {
      ui.notifications.info(game.i18n.localize('cs-hero-box.dataSources.noNewJournals'));
    }
  }

  // check if any journal in a compendium has our module flags
  async #compendiumHasModuleData(pack) {
    try {
      const journals = await pack.getDocuments();
      for (const journal of journals) {
        if (journalHasModuleData(journal)) {
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  }

  // tell the data manager to refresh if it's open
  #refreshDataManager() {
    const targetId = `${MODULE_ID}-data-manager`;
    let openApp = null;

    if (foundry.applications?.instances) {
      for (const app of foundry.applications.instances.values()) {
        if (app.id === targetId) {
          openApp = app;
          break;
        }
      }
    }

    if (!openApp) {
      openApp = Object.values(ui.windows).find(w => w.id === targetId) ?? null;
    }

    if (openApp && typeof openApp.refreshAllTabs === 'function') {
      openApp.refreshAllTabs();
    }
  }

  // get compendiums that aren't already in our sources
  #getAvailableCompendiums() {
    const allSources = source.getAllSources();
    const existingIds = new Set(allSources.map(s => s.id));
    const result = [];

    for (const pack of game.packs) {
      if (pack.documentName !== 'JournalEntry') continue;

      const id = `Compendium.${pack.collection}`;
      if (existingIds.has(id)) continue;

      const packageType = pack.metadata?.packageType ?? 'world';
      const packageName = pack.metadata?.packageName ?? game.world.id;

      result.push({
        id,
        name: pack.title,
        packageType,
        packageName,
      });
    }

    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  // get world journals that aren't already in our sources
  #getAvailableWorldJournals() {
    const allSources = source.getAllSources();
    const existingIds = new Set(allSources.map(s => s.id));
    const result = [];

    for (const journal of game.journal) {
      const id = journal.uuid;
      if (existingIds.has(id)) continue;
      result.push({ id, name: journal.name });
    }

    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  // show a dialog to pick from available sources
  async #selectSource() {
    const compendiums = this.#getAvailableCompendiums();
    const journals = this.#getAvailableWorldJournals();

    if (!compendiums.length && !journals.length) {
      ui.notifications.warn(game.i18n.localize('cs-hero-box.dataSources.noAvailable'));
      return null;
    }

    const compendiumOptions = compendiums.map(c => {
      const prefix = c.packageType === 'module' ? `[Module: ${c.packageName}]` : '[World]';
      return `<option value="${c.id}">${prefix} ${c.name}</option>`;
    });

    const journalOptions = journals.map(j =>
      `<option value="${j.id}">[World Journal] ${j.name}</option>`
    );

    const options = [...compendiumOptions, ...journalOptions].join('');

    const result = await foundry.applications.api.DialogV2.prompt({
      window: { title: game.i18n.localize('cs-hero-box.dataSources.selectSource') },
      content: `
        <div class="form-group">
          <label>${game.i18n.localize('cs-hero-box.dataSources.source')}</label>
          <select name="source" autofocus>${options}</select>
        </div>
      `,
      ok: {
        label: game.i18n.localize('cs-hero-box.dataSources.addSource'),
        callback: (event, button) => button.form.elements.source.value,
      },
      rejectClose: false,
    });

    return result || null;
  }
}
