/**
 * @fileoverview Promise pair for dialog flows: resolve at most once (avoids double-resolve on close).
 * @returns {{ promise: Promise<unknown>, resolve: (value?: unknown) => void }}
 */
export function createSingleResolvePromise() {
  let resolved = false;
  let resolveFn;

  const promise = new Promise((resolve) => {
    resolveFn = (value) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };
  });

  return { promise, resolve: resolveFn };
}