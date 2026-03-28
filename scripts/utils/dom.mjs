/**
 * @fileoverview DOM-oriented helpers.
 */

/**
 * Debounce: run `func` after `wait` ms of quiet.
 * @template {(...args: any[]) => void} F
 * @param {F} func
 * @param {number} wait
 * @returns {F}
 */
export function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}