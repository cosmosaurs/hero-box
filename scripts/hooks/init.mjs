import { logger } from '../utils/index.mjs';

export function registerInitHooks() {
  registerDefaultNameHooks();
  logger.debug('Init hooks registered');
}

function registerDefaultNameHooks() {
  Hooks.on('cs-hero-box.preGenerateName', (nameData) => {
    if (nameData.context.race === 'dragonborn') {
      handleDragonbornName(nameData);
    }
  });
}

function handleDragonbornName(nameData) {
  const { parts } = nameData;
  const segments = [];

  if (parts.clan) segments.push(parts.clan);
  if (parts.firstName) segments.push(parts.firstName);

  if (nameData.useNickname && parts.nickname) {
    if (segments.length > 0) {
      segments.push(`«${parts.nickname}»`);
    } else {
      segments.push(parts.nickname);
    }
  }

  if (segments.length > 0) {
    nameData.result = segments.join(' ');
  }
}
