/**
 * @fileoverview Injects create-actor dialog button, actor sheet control, token freeze, opens Actor Config.
 */

import { logger } from '../utils/index.mjs';
import { derivePortraitUrl } from '../utils/filepicker.mjs';
import { getCreateDialogHookName } from '../utils/system.mjs';
import { actor } from '../services/actor.mjs';

let ActorConfigClass = null;

/** Lazy-load and cache the `ActorConfig` application class. */
async function getActorConfig() {
  if (!ActorConfigClass) {
    const mod = await import('../applications/actor-config/actor-config.mjs');
    ActorConfigClass = mod.ActorConfig;
  }
  return ActorConfigClass;
}

/** Register create-dialog, actor-sheet, and token-config hooks. */
export function registerUIHooks() {
  logger.debug('Registering UI hooks');

  const hookName = getCreateDialogHookName();

  Hooks.on(hookName, handleCreateActorDialog);
  Hooks.on('getHeaderControlsActorSheetV2', handleActorSheetHeaderControls);
  Hooks.on('renderTokenConfig', handleRenderTokenConfig);
}

/** @returns {string} Localized native create-actor dialog title. */
function getCreateActorDialogTitle() {
  return game.i18n.format('DOCUMENT.Create', {
    type: game.i18n.localize('DOCUMENT.Actor')
  });
}

/** @param {Application} app @param {JQuery} html */
function handleCreateActorDialog(app, html) {
  if (app.options?.window?.title !== getCreateActorDialogTitle()) return;

  const text = game.i18n.localize('cs-hero-box.button.text');
  const tooltip = game.i18n.localize('cs-hero-box.button.tooltip');

  const customButton = $(`
    <button type="button" class="cs-hero-box-create-btn" data-tooltip="${tooltip}">
      <i class="fas fa-dice"></i>
      ${text}
    </button>
  `);

  $(html).find('.form-footer').append(customButton);

  customButton.on('click', async () => {
    const selectedFolderId = $(html).find('select[name="folder"]')?.[0]?.value || null;
    await openActorConfig(null, selectedFolderId);
    app.close();
  });
}

/** @param {ActorSheet} app @param {object[]} controls */
function handleActorSheetHeaderControls(app, controls) {
  if (controls.some(btn => btn.class === 'cs-hero-box')) return;

  controls.unshift({
    class: 'cs-hero-box',
    icon: 'fas fa-dice',
    label: game.i18n.localize('cs-hero-box.button.headerLabel'),
    onClick: async () => {
      await openActorConfig(app.actor);
    },
  });
}

/** @param {TokenConfig} app @param {JQuery} html */
function handleRenderTokenConfig(app, html, data) {
  const token = app.token;
  if (!token?.actor) return;

  const targetTab = $(html).find(".tab[data-tab='identity']");

  if (!targetTab.length) {
    logger.debug('Target tab not found for TokenConfig');
    return;
  }

  const title = game.i18n.localize('cs-hero-box.name');
  const btnText = game.i18n.localize('cs-hero-box.tokenConfig.freeze.button');
  const btnTooltip = game.i18n.localize('cs-hero-box.tokenConfig.freeze.tooltip');

  const buttonHtml = `
    <fieldset>
      <legend>${title}</legend>
      <button type="button" class="cs-hero-box-freeze-btn" data-tooltip="${btnTooltip}">
        <i class="fas fa-snowflake"></i>
        ${btnText}
      </button>
    </fieldset>
  `;

  const $button = $(buttonHtml);
  targetTab.append($button);

  $button.find('.cs-hero-box-freeze-btn').on('click', async () => {
    await freezeTokenAsActor(token);
  });
}

/**
 * Create a new linked `Actor` from the token’s current document state.
 * @param {TokenDocument} token
 */
async function freezeTokenAsActor(token) {
  try {
    const actorData = foundry.utils.duplicate(token.actor.system);
    const tokenData = foundry.utils.duplicate(token);

    delete tokenData._id;
    tokenData.actorLink = true;

    const portraitPath = derivePortraitUrl(token.texture.src);

    const newActor = await Actor.create({
      name: token.name,
      img: portraitPath,
      type: token.actor.type,
      system: actorData,
      prototypeToken: tokenData,
    });

    ui.notifications.info(
      game.i18n.format('cs-hero-box.tokenConfig.freeze.success', { name: newActor.name })
    );

    logger.info(`Created frozen actor: ${newActor.name}`);
  } catch (error) {
    logger.error('Failed to freeze token:', error);
    ui.notifications.error(game.i18n.localize('cs-hero-box.tokenConfig.freeze.error'));
  }
}

/**
 * Open Actor Config; on submit calls `actor.createOrUpdate`.
 * @param {Actor|null} [existingActor]
 * @param {string|null} [folderId]
 */
async function openActorConfig(existingActor = null, folderId = null) {
  const Config = await getActorConfig();

  const result = await Config.open(existingActor, { folderId });

  if (result?.submitted) {
    await actor.createOrUpdate(result.data, existingActor, folderId);
  }
}

export { openActorConfig };