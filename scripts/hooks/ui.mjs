**
 * @fileoverview Injects create-actor dialog button, actor sheet control, token freeze, opens Actor Config.
 */

import { MODULE_ID, FLAGS } from '../constants/index.mjs';
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

/**
 * Unwrap HTMLElement from ApplicationV2 or legacy jQuery hook payload.
 * @param {HTMLElement| object} html
 * @returns {HTMLElement|null}
 */
function resolveRootElement(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  return null;
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
    type: game.i18n.localize('DOCUMENT.Actor'),
  });
}

/** @param {object} app @param {HTMLElement|object} html */
function handleCreateActorDialog(app, html) {
  const isActorDialog = app.documentName
    ? app.documentName === 'Actor'
    : app.options?.window?.title === getCreateActorDialogTitle();

  if (!isActorDialog) return;

  const root = resolveRootElement(html);
  const footer = root?.querySelector('.form-footer');
  if (!footer || footer.querySelector('.cs-hero-box-create-btn')) return;

  const customButton = document.createElement('button');
  customButton.type = 'button';
  customButton.className = 'cs-hero-box-create-btn';
  customButton.dataset.tooltip = game.i18n.localize('cs-hero-box.button.tooltip');

  const icon = document.createElement('i');
  icon.className = 'fas fa-dice';
  customButton.append(icon, ' ', game.i18n.localize('cs-hero-box.button.text'));

  footer.appendChild(customButton);

  customButton.addEventListener('click', async () => {
    const folderSelect = root.querySelector('select[name="folder"]');
    const selectedFolderId = folderSelect?.value || null;
    await openActorConfig(null, selectedFolderId);
    app.close();
  });
}

/** @param {object} app @param {object[]} controls */
function handleActorSheetHeaderControls(app, controls) {
  if (controls.some(btn => btn.class === 'cs-hero-box')) return;

  controls.unshift({
    class: 'cs-hero-box',
    icon: 'fas fa-dice',
    label: game.i18n.localize('cs-hero-box.button.headerLabel'),
    onClick: async () => {
      await openActorConfig(app.actor ?? app.document);
    },
  });
}

/** @param {object} app @param {HTMLElement|object} html */
function handleRenderTokenConfig(app, html) {
  const token = app.token ?? app.document;
  if (!token?.actor) return;

  const root = resolveRootElement(html);
  if (!root || root.querySelector('.cs-hero-box-freeze-btn')) return;

  const targetTab = root.querySelector(".tab[data-tab='identity']");
  if (!targetTab) {
    logger.debug('Target tab not found for TokenConfig');
    return;
  }

  const fieldset = document.createElement('fieldset');
  const legend = document.createElement('legend');
  legend.textContent = game.i18n.localize('cs-hero-box.name');

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cs-hero-box-freeze-btn';
  button.dataset.tooltip = game.i18n.localize('cs-hero-box.tokenConfig.freeze.tooltip');

  const icon = document.createElement('i');
  icon.className = 'fas fa-snowflake';
  button.append(icon, ' ', game.i18n.localize('cs-hero-box.tokenConfig.freeze.button'));

  fieldset.append(legend, button);
  targetTab.appendChild(fieldset);

  button.addEventListener('click', async () => {
    await freezeTokenAsActor(token);
  });
}

/**
 * Create a new linked `Actor` from the token's full synthetic state and link the placed token.
 * @param {Token|TokenDocument|string} tokenOrId
 * @returns {Promise<Actor|null>}
 */
async function freezeTokenAsActor(tokenOrId) {
  let token = tokenOrId;
  if (token?.document?.documentName === 'Token') token = token.document;
  else if (typeof token === 'string') {
    token = canvas?.scene?.tokens?.get(token) ?? await fromUuid(token).catch(() => null);
  }

  if (!token?.actor) return null;

  try {
    const actorObj = foundry.utils.deepClone(token.actor.toObject());
    delete actorObj._id;
    if (actorObj._stats) {
      delete actorObj._stats.compendiumSource;
    }
    if (actorObj.flags?.core) {
      delete actorObj.flags.core.sourceId;
    }
    actorObj.flags = actorObj.flags ?? {};
    actorObj.flags[MODULE_ID] = actorObj.flags[MODULE_ID] ?? {};
    delete actorObj.flags[MODULE_ID][FLAGS.TOKEN_CRITERIA];
    delete actorObj.flags[MODULE_ID][FLAGS.PREV_FORM_VALUES];
    actorObj.flags[MODULE_ID][FLAGS.LOCAL_OVERRIDE] = true;

    const tokenData = foundry.utils.deepClone(token.toObject());
    delete tokenData._id;
    delete tokenData.actorId;
    delete tokenData.delta;
    delete tokenData.x;
    delete tokenData.y;
    delete tokenData.elevation;
    delete tokenData.rotation;
    delete tokenData.hidden;
    if (tokenData.flags?.[MODULE_ID]) {
      delete tokenData.flags[MODULE_ID][FLAGS.TOKEN_ROLLED];
      delete tokenData.flags[MODULE_ID][FLAGS.ROLLED_IMAGE_UUID];
    }
    tokenData.actorLink = true;

    const portraitPath = (!token.actorLink && token.delta?.img)
      ? token.delta.img
      : (derivePortraitUrl(token.texture?.src) || token.actor.img);

    const newActor = await Actor.create({
      ...actorObj,
      name: token.name,
      img: portraitPath,
      prototypeToken: tokenData,
    });

    if (newActor && token.parent?.documentName === 'Scene') {
      await token.update({
        actorId: newActor.id,
        actorLink: true,
      });
    }

    ui.notifications.info(
      game.i18n.format('cs-hero-box.tokenConfig.freeze.success', { name: newActor.name })
    );

    logger.info(`Created frozen actor: ${newActor.name}`);
    return newActor;
  } catch (error) {
    logger.error('Failed to freeze token:', error);
    ui.notifications.error(game.i18n.localize('cs-hero-box.tokenConfig.freeze.error'));
    return null;
  }
}

/**
 * Open Actor Config; on submit calls `actor.createOrUpdate`.
 * @param {Actor|null} [existingActor]
 * @param {string|null} [folderId]
 * @param {object} [options]
 * @returns {Promise<{ actor: Actor, isNew: boolean }|null>}
 */
async function openActorConfig(existingActor = null, folderId = null, options = {}) {
  const Config = await getActorConfig();

  const result = await Config.open(existingActor, { folderId, ...options });

  if (result?.submitted && options.apply !== false) {
    return actor.createOrUpdate(result.data, existingActor, folderId);
  }

  return null;
}

export { openActorConfig, freezeTokenAsActor };
