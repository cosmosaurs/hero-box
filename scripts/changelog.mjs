/**
 * @fileoverview On version bump, fetches changelog markdown and shows a GM-only dialog.
 */

const moduleId = 'cs-hero-box';

const CHANGELOG_EN_URL = 'https://raw.githubusercontent.com/cosmosaurs/hero-box/refs/heads/main/CHANGELOG.en.md';
const CHANGELOG_RU_URL = 'https://raw.githubusercontent.com/cosmosaurs/hero-box/refs/heads/main/CHANGELOG.ru.md';

function isRussianLocale(lang) {
  return typeof lang === 'string' && lang.toLowerCase().startsWith('ru');
}

/** @returns {string[]} URLs/paths to try for changelog markdown. */
function getChangelogCandidates() {
  const lang = game.i18n?.lang ?? 'en';
  const ru = isRussianLocale(lang);

  if (ru) {
    return [
      CHANGELOG_RU_URL,
      `modules/${moduleId}/CHANGELOG.ru.md`,
    ];
  }

  return [
    CHANGELOG_EN_URL,
    `modules/${moduleId}/CHANGELOG.en.md`,
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
    } catch (e) {}
  }

  return null;
}

// register the version setting to track when we last showed the changelog
Hooks.once("init", async () => {
  game.settings.register(moduleId, "version", {
    name: "Version",
    type: String,
    default: "0",
    scope: "world",
    config: false,
    restricted: true
  });
});

// show the changelog popup if the module was updated
Hooks.once("ready", async () => {
  if (!game.user.isGM) return;

  try {
    let moduleVersion = game.modules.get(moduleId).version;
    moduleVersion = moduleVersion.split('.').slice(0, 3).join('.');
    let savedVersion = game.settings.get(moduleId, "version");
    savedVersion = savedVersion.split('.').slice(0, 3).join('.');

    if (savedVersion !== moduleVersion) {

      // try language-specific changelog first, then generic fallback
      const markdown = await fetchFirstAvailable(getChangelogCandidates(), { cache: "no-store" });

      if (!markdown) {
        console.error(`[${moduleId}] Не удалось загрузить CHANGELOG.md`);
        return;
      }

      // quick and dirty markdown to html conversion
      const htmlContent = markdown
        .replace(/^######\s(.+)$/gm, '<h6>$1</h6>')
        .replace(/^#####\s(.+)$/gm, '<h5>$1</h5>')
        .replace(/^####\s(.+)$/gm, '<h4>$1</h4>')
        .replace(/^###\s(.+)$/gm, '<h3>$1</h3>')
        .replace(/^##\s(.+)$/gm, '<h2>$1</h2>')
        .replace(/^#\s(.+)$/gm, '<h1>$1</h1>')
        .replace(/^\s*[-*+]\s(.+)$/gm, '<li>$1</li>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/~~(.+?)~~/g, '<del>$1</del>')
        .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank">$1</a>')
        .replace(/^---$/gm, '<hr>')
        .replace(/(?:\r?\n){2,}/g, '</p><p>')
        .replace(/<p><\/p>/g, '');

      const dialog = new foundry.applications.api.DialogV2({
        window: {
          title: game.i18n.localize(`${moduleId}.changelog.title`) || "Что нового",
          icon: "fa-solid fa-scroll",
        },
        content: `
            <div style="
              max-height: 600px; 
              max-width: 800px;
              overflow-y: auto; 
              padding: 15px;
              font-size: 0.875rem;
            ">
              ${htmlContent}
            </div>
        `,
        buttons: [{
          action: "noShow",
          label: game.i18n.localize(`${moduleId}.changelog.dismiss`) ||
            game.i18n.localize(`${moduleId}.changelog.doNotShow`) ||
            "Не показывать до следующего обновления",
          callback: () => {
            game.settings.set(moduleId, "version", game.modules.get(moduleId).version);
          }
        }]
      });

      dialog.render({ force: true });

    }
  } catch (error) {
    console.error(`[${moduleId}] Ошибка инициализации:`, error);
  }

});