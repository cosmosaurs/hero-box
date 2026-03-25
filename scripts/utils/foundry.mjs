import { MODULE_ID } from '../constants/index.mjs';

// shortcut to grab a module flag from any document
export function getFlag(document, flagKey) {
  return document.getFlag(MODULE_ID, flagKey);
}

// fromUuid that won't blow up if the uuid is garbage
export async function safeFromUuid(uuid) {
  try {
    return await fromUuid(uuid);
  } catch {
    return null;
  }
}