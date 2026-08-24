import { writable } from 'svelte/store';

// A readable store that keeps its last value when nobody is listening.
// The underlying listener only runs while at least one component uses it.
export function cachedReadable(initialValue, start) {
  const store = writable(initialValue);
  let subscriberCount = 0;
  let stop = null;

  return {
    subscribe(run, invalidate) {
      const unsubscribe = store.subscribe(run, invalidate);
      subscriberCount += 1;

      if (subscriberCount === 1) {
        stop = start(store.set);
      }

      return () => {
        unsubscribe();
        subscriberCount -= 1;

        if (subscriberCount === 0) {
          stop?.();
          stop = null;
        }
      };
    },
  };
}
