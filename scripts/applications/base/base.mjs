import { debounce } from '../../utils/dom.mjs';
import { UI } from '../../constants/ui.mjs';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// base class for all our app windows — handles common stuff like scroll/focus restoration
export class BaseApplication extends HandlebarsApplicationMixin(ApplicationV2) {
  #eventCleanup = [];
  #scrollPositions = new Map();
  #focusedElement = null;
  #selectionRange = null;

  // center the window on first render
  _onFirstRender(context, options) {
    super._onFirstRender(context, options);
    this.#centerWindow();
  }

  // save scroll and focus state before re-render
  _preRender(context, options) {
    this.#saveScrollPositions();
    this.#saveFocusState();
    return super._preRender(context, options);
  }

  // restore scroll and focus after re-render
  _onRender(context, options) {
    super._onRender(context, options);
    this.#restoreScrollPositions();
    this.#restoreFocusState();
  }

  // clean up event listeners when closing
  _onClose(options) {
    this.#cleanup();
    return super._onClose(options);
  }

  // position window in the center of the screen
  #centerWindow() {
    requestAnimationFrame(() => {
      const { width, height } = this.element.getBoundingClientRect();
      const left = Math.max(0, (window.innerWidth - width) / 2);
      const top = Math.max(0, (window.innerHeight - height) / 2);
      this.setPosition({ left, top });
    });
  }

  // remember scroll positions for elements with data-scroll-id
  #saveScrollPositions() {
    if (!this.element) return;

    for (const el of this.querySelectorAll('[data-scroll-id]')) {
      this.#scrollPositions.set(el.dataset.scrollId, el.scrollTop);
    }
  }

  // put scroll positions back after re-render
  #restoreScrollPositions() {
    if (!this.element) return;

    for (const el of this.querySelectorAll('[data-scroll-id]')) {
      const saved = this.#scrollPositions.get(el.dataset.scrollId);
      if (saved !== undefined) {
        el.scrollTop = saved;
      }
    }
  }

  // remember which input was focused and cursor position
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

  // restore focus and cursor position after re-render
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

  // remove all registered event listeners
  #cleanup() {
    for (const cleanup of this.#eventCleanup) {
      cleanup();
    }
    this.#eventCleanup = [];
    this.#scrollPositions.clear();
  }

  // shortcut for querySelector on this app's element
  querySelector(selector) {
    return this.element?.querySelector(selector) ?? null;
  }

  // shortcut for querySelectorAll that returns an array
  querySelectorAll(selector) {
    return this.element ? Array.from(this.element.querySelectorAll(selector)) : [];
  }

  // add an event listener that will be auto-cleaned on close
  addEvent(element, event, handler) {
    if (!element) return;
    element.addEventListener(event, handler);
    this.#eventCleanup.push(() => element.removeEventListener(event, handler));
  }

  // add a debounced event listener
  addDebouncedEvent(element, event, handler, wait = UI.DEBOUNCE_DELAY) {
    this.addEvent(element, event, debounce(handler, wait));
  }

  // manually save a scroll position (for virtual scroll etc)
  saveScrollPosition(id, value) {
    this.#scrollPositions.set(id, value);
  }

  // get a saved scroll position
  getScrollPosition(id) {
    return this.#scrollPositions.get(id);
  }
}

// form version of base app — just sets the tag to form
export class BaseFormApplication extends BaseApplication {
  static DEFAULT_OPTIONS = {
    tag: 'form',
    form: {
      closeOnSubmit: true,
    },
  };
}