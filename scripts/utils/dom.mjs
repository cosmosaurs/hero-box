**
 * @fileoverview DOM-oriented helpers.
 */

/**
 * Debounce: run `func` after `wait` ms of quiet. Exposes `.cancel()` to abort pending execution.
 * @template {(...args: any[]) => void} F
 * @param {F} func
 * @param {number} wait
 * @returns {F & { cancel: () => void }}
 */
export function debounce(func, wait) {
  let timeout = null;

  function executedFunction(...args) {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => {
      timeout = null;
      func(...args);
    }, wait);
  }

  executedFunction.cancel = () => {
    if (timeout !== null) {
      clearTimeout(timeout);
      timeout = null;
    }
  };

  return executedFunction;
}
