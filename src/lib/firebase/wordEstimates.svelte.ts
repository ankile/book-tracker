// Word Counter estimates for the editions a page needs, as reactive state:
// re-read when the set of editions changes, and empty until the reads land.
// Call it while a component initialises, like any $effect.
import type { EditionWordEstimate } from '../interfaces/catalog.ts';
import { Database } from './db.ts';

export function wordEstimatesFor(editionIds: () => readonly string[]): {
  readonly current: ReadonlyMap<string, EditionWordEstimate>;
} {
  let current = $state<ReadonlyMap<string, EditionWordEstimate>>(new Map());
  // Joined, so a new books snapshot naming the same editions changes nothing.
  const key = $derived(editionIds().join('\n'));
  $effect(() => {
    const ids = key === '' ? [] : key.split('\n');
    let live = true;
    void Database.getWordEstimates(ids).then((estimates) => {
      if (live) current = estimates;
    });
    return () => {
      live = false;
    };
  });
  return {
    get current() {
      return current;
    },
  };
}
