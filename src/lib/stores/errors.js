import { writable } from 'svelte/store';

// Global list of user-facing errors, rendered by ErrorBanner. Named addError
// rather than reportError to avoid shadowing window.reportError.
let nextId = 0;
const store = writable([]);

export const errors = { subscribe: store.subscribe };

export function addError(message) {
  console.error(message);
  // Dedup by exact message: a reconnect flush of several queued writes
  // against one deleted book should produce one banner entry, not five.
  store.update((list) =>
    list.some((e) => e.message === message) ? list : [...list, { id: nextId++, message }]
  );
}

export function dismissError(id) {
  store.update((list) => list.filter((e) => e.id !== id));
}

// Errors belong to the session that produced them; a sign-out or account
// switch must not leave one user's book titles on another user's screen.
export function clearErrors() {
  store.set([]);
}
