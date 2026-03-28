/**
 * @fileoverview ApplicationV2 base with scroll/focus preservation and debounced events.
 */

import { debounce } from '../../utils/dom.mjs';
import { UI } from '../../constants/ui.mjs';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class BaseApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  #eventCleanup = [];
  #scrollPositions = new Map();
  #focusedElement = null;
  #selectionRange = null;

  /** @param {object} context @param {object} options */
  _onFirstRender(context, options) {
    super._onFirstRender(context, options);
    this.#centerWindow();
  }

  /** @param {object} context @param {object} options */
  _preRender(context, options) {
    this.#saveScrollPositions();
    this.#saveFocusState();
    return super._preRender(context, options);
  }

  /** @param {object} context @param {object} options */
  _onRender(context, options) {
    super._onRender(context, options);
    this.#restoreScrollPositions();
    this.#restoreFocusState();
  }

  /** Remove debounced/listeners registered via `addEvent` / `addDebouncedEvent`. */
  _onClose(options) {
    this.#cleanup();
    return super._onClose(options);
  }

  /** Center the application window in the viewport. */
  #centerWindow() {
    requestAnimationFrame(() => {
      const { width, height } = this.element.getBoundingClientRect();
      const left = Math.max(0, (window.innerWidth - width) / 2);
      const top = Math.max(0, (window.innerHeight - height) / 2);
      this.setPosition({ left, top });
    });
  }

  /** Persist `scrollTop` for `[data-scroll-id]` elements. */
  #saveScrollPositions() {
    if (!this.element) return;

    for (const el of this.querySelectorAll('[data-scroll-id]')) {
      this.#scrollPositions.set(el.dataset.scrollId, el.scrollTop);
    }
  }

  /** Restore scroll positions after re-render. */
  #restoreScrollPositions() {
    if (!this.element) return;

    for (const el of this.querySelectorAll('[data-scroll-id]')) {
      const saved = this.#scrollPositions.get(el.dataset.scrollId);
      if (saved !== undefined) {
        el.scrollTop = saved;
      }
    }
  }

  /** Remember focused input and selection range. */
  #saveFocusState() {
    if (!this.element) return;

    const active = this.element.querySelector(':focus');
    if (active?.matches('input, textarea')) {
      this.#focusedElement = {
        name: active.name,
        tagName: active.tagName,
      };
      if (active.setSelectionRange) {
        this.#selectionRange = {
          start: active.selectionStart,
          end: active.selectionEnd,
        };
      }
    } else {
      this.#focusedElement = null;
      this.#selectionRange = null;
    }
  }

  /** Restore focus to the previously active field. */
  #restoreFocusState() {
    if (!this.element || !this.#focusedElement) return;

    const { name, tagName } = this.#focusedElement;
    const target = name ? this.querySelector(`${tagName}[name="${name}"]`) : null;

    if (target) {
      target.focus();
      if (this.#selectionRange && target.setSelectionRange) {
        try {
          target.setSelectionRange(this.#selectionRange.start, this.#selectionRange.end);
        } catch {}
      }
    }

    this.#focusedElement = null;
    this.#selectionRange = null;
  }

  /** Remove listeners registered via `addEvent`. */
  #cleanup() {
    for (const cleanup of this.#eventCleanup) {
      cleanup();
    }
    this.#eventCleanup = [];
    this.#scrollPositions.clear();
  }

  /** @param {string} selector */
  querySelector(selector) {
    return this.element?.querySelector(selector) ?? null;
  }

  /** @param {string} selector @returns {Element[]} */
  querySelectorAll(selector) {
    return this.element ? Array.from(this.element.querySelectorAll(selector)) : [];
  }

  /**
   * @param {EventTarget} element
   * @param {string} event
   * @param {EventListener} handler
   */
  addEvent(element, event, handler) {
    if (!element) return;
    element.addEventListener(event, handler);
    this.#eventCleanup.push(() => element.removeEventListener(event, handler));
  }

  /**
   * Like `addEvent` but debounced by `wait` ms.
   * @param {EventTarget} element
   * @param {string} event
   * @param {function(Event): void} handler
   * @param {number} [wait]
   */
  addDebouncedEvent(element, event, handler, wait = UI.DEBOUNCE_DELAY) {
    this.addEvent(element, event, debounce(handler, wait));
  }

  /** @param {string} id @param {number} value */
  saveScrollPosition(id, value) {
    this.#scrollPositions.set(id, value);
  }

  /** @param {string} id */
  getScrollPosition(id) {
    return this.#scrollPositions.get(id);
  }
}

/** Form-root variant of `BaseApplication`. */
export class BaseFormApplication extends BaseApplication {
  static DEFAULT_OPTIONS = {
    tag: 'form',
    form: {
      closeOnSubmit: true,
    },
  };
}