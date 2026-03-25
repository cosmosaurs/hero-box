// creates a promise that can only be resolved once,
// prevents the double-resolve bug in app open/close flows
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