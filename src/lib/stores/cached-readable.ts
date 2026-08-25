import { writable, type Readable, type Subscriber, type Unsubscriber } from 'svelte/store';

type Start<T> = (set: (value: T) => void) => Unsubscriber;

// A readable store that keeps its last value when nobody is listening.
// The underlying listener only runs while at least one component uses it.
export function cachedReadable<T>(initialValue: T, start: Start<T>): Readable<T> {
  const store = writable(initialValue);
  let subscriberCount = 0;
  let stop: Unsubscriber | null = null;

  return {
    subscribe(run: Subscriber<T>, invalidate?: () => void) {
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
