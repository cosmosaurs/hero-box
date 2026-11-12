**
 * @fileoverview On version bump, fetches changelog markdown and shows a GM-only dialog.
 */

import { MODULE_ID } from './constants/index.mjs';
import { logger } from './utils/index.mjs';

const CHANGELOG_EN_URL = 'https://raw.githubusercontent.com/cosmosaurs/hero-box/refs/heads/main/CHANGELOG.en.md';
const CHANGELOG_RU_URL = 'https://raw.githubusercontent.com/cosmosaurs/hero-box/refs/heads/main/CHANGELOG.ru.md';

function isRussianLocale(lang) {
  return typeof lang === 'string' && lang.toLowerCase().startsWith('ru');
}

/**
 * Localize a key if it exists in i18n, otherwise return fallback.
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function localizeOrFallback(key, fallback) {
  return game.i18n?.has(key) ? game.i18n.localize(key) : fallback;
}

/** @returns {string[]} URLs/paths to try for changelog markdown. */
function getChangelogCandidates() {
  const lang = game.i18n?.lang ?? 'en';
  if (isRussianLocale(lang)) {
    return [
      CHANGELOG_RU_URL,
      `modules/${MODULE_ID}/CHANGELOG.ru.md`,
    ];
  }

  return [
    CHANGELOG_EN_URL,
    `modules/${MODULE_ID}/CHANGELOG.en.md`,
  ];
}

/**
 * @param {string[]} paths
 * @param {RequestInit} [options]
 * @returns {Promise<string|null>}
 */
async function fetchFirstAvailable(paths, options = undefined) {
  for (const path of paths) {
    try {
      const response = await fetch(path, options);
      if (response.ok) {
        return await response.text();
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Safe inline Markdown formatting on already HTML-escaped text.
 * @param {string} escapedText
 * @returns {string}
 */
function formatInlineMarkdown(escapedText) {
  return escapedText
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

/**
 * Safely convert basic Markdown to sanitized HTML without raw HTML injection.
 * @param {string} markdown
 * @returns {string}
 */
function renderMarkdownSafe(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inList = false;

  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      closeList();
      continue;
    }

    const escaped = foundry.utils.escapeHTML(trimmed);

    if (escaped === '---') {
      closeList();
      out.push('<hr>');
      continue;
    }

    const headingMatch = escaped.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1].length;
      out.push(`<h${level}>${formatInlineMarkdown(headingMatch[2])}</h${level}>`);
      continue;
    }

    const listMatch = escaped.match(/^[-*+]\s+(.+)$/);
    if (listMatch) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${formatInlineMarkdown(listMatch[1])}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${formatInlineMarkdown(escaped)}</p>`);
  }

  closeList();
  return out.join('\n');
}

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, 'version', {
    name: 'Version',
    type: String,
    default: '0',
    scope: 'world',
    config: false,
    restricted: true,
  });
});

Hooks.once('ready', async () => {
  if (!game.user.isGM) return;

  try {
    const rawModuleVersion = game.modules.get(MODULE_ID)?.version ?? '0';
    const moduleVersion = rawModuleVersion.split('.').slice(0, 3).join('.');
    const savedVersion = String(game.settings.get(MODULE_ID, 'version') ?? '0')
      .split('.')
      .slice(0, 3)
      .join('.');

    if (savedVersion === moduleVersion) return;

    const markdown = await fetchFirstAvailable(getChangelogCandidates(), { cache: 'no-store' });
    if (!markdown) {
      logger.warn('Failed to load CHANGELOG.md');
      return;
    }

    const htmlContent = renderMarkdownSafe(markdown);
    const title = localizeOrFallback(`${MODULE_ID}.changelog.title`, 'Hero in a Box Update');
    const dismissLabel = localizeOrFallback(
      `${MODULE_ID}.changelog.dismiss`,
      localizeOrFallback(`${MODULE_ID}.changelog.doNotShow`, "Don't show for this version")
    );

    const dialog = new foundry.applications.api.DialogV2({
      window: {
        title,
        icon: 'fa-solid fa-scroll',
      },
      content: `
        <div style="max-height: 600px; max-width: 800px; overflow-y: auto; padding: 15px; font-size: 0.875rem;">
          ${htmlContent}
        </div>
      `,
      buttons: [{
        action: 'noShow',
        label: dismissLabel,
        callback: () => {
          game.settings.set(MODULE_ID, 'version', rawModuleVersion);
        },
      }],
    });

    dialog.render({ force: true });
  } catch (error) {
    logger.error('Failed to display changelog:', error);
  }
});
