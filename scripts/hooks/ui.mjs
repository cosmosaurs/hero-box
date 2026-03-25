import { MODULE_ID } from '../constants/index.mjs';
import { logger } from '../utils/index.mjs';
import { derivePortraitUrl } from '../utils/filepicker.mjs';
import { getCreateDialogHookName } from '../utils/system.mjs';
import { actor } from '../services/actor.mjs';

let ActorConfigClass = null;

// lazy load the actor config to avoid circular imports
async function getActorConfig() {
  if (!ActorConfigClass) {
    const mod = await import('../applications/actor-config/actor-config.mjs');
    ActorConfigClass = mod.ActorConfig;
  }
  return ActorConfigClass;
}

// hook into various ui elements to add our buttons
export function registerUIHooks() {
  logger.debug('Registering UI hooks');

  const hookName = getCreateDialogHookName();

  Hooks.on(hookName, handleCreateActorDialog);
  Hooks.on('getHeaderControlsActorSheetV2', handleActorSheetHeaderControls);
  Hooks.on('renderTokenConfig', handleRenderTokenConfig);
}

// get the localized title of the create actor dialog so we can identify it
function getCreateActorDialogTitle() {
  return game.i18n.format('DOCUMENT.Create', {
    type: game.i18n.localize('DOCUMENT.Actor')
  });
}

// inject our "generate random" button into the create actor dialog
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

// add our dice button to the actor sheet header
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

// add the "freeze token" button to the token config dialog
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

// create a real linked actor from an unlinked token, preserving its rolled appearance
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

// open our config dialog and create/update the actor if submitted
async function openActorConfig(existingActor = null, folderId = null) {
  const Config = await getActorConfig();

  const result = await Config.open(existingActor, { folderId });

  if (result?.submitted) {
    await actor.createOrUpdate(result.data, existingActor, folderId);
  }
}

export { openActorConfig };