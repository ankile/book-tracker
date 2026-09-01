import { preloadCode } from '$app/navigation';
import { ADMIN_UID } from '$lib/admin-uid.ts';
import { Database } from '$lib/firebase/db.ts';
import type { Readable, Unsubscriber } from 'svelte/store';

const PRIVATE_ROUTES = ['/', '/finished', '/me', '/authors', '/isbns'];

// Resolves once every store has delivered a first value (the stores start
// as undefined while loading, the getUser convention).
function whenLoaded(stores: readonly Readable<unknown>[]): Promise<void> {
  return Promise.all(stores.map((store) => new Promise<void>((resolve) => {
    const unsubscribe = store.subscribe((value) => {
      if (value === undefined) return;
      resolve();
      // The subscription may resolve synchronously, before unsubscribe is
      // assigned; release on the next tick either way.
      queueMicrotask(() => unsubscribe());
    });
  }))).then(() => undefined);
}

function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => resolve(), { timeout: 2000 });
    } else {
      window.setTimeout(resolve, 0);
    }
  });
}

// Keep every signed-in route's shared data current. Route components attach
// to these same stores, so navigation never creates a second listener.
export function startAppPrefetch(userId: string): Unsubscriber {
  const stores = [
    Database.getAllBooks(userId),
    Database.getAuthors(),
    Database.getUser(userId),
    Database.getMyProfile(userId),
    Database.getAllReadingSessions(userId),
  ];
  const unsubscribers: Unsubscriber[] = stores.map((store) => store.subscribe(() => {}));
  void Promise.all(PRIVATE_ROUTES.map((route) => preloadCode(route)));

  // The operator's catalog console is live Firestore listeners, opened
  // only after the app's own stores have all delivered and the tab is idle
  // again: the page the operator actually opened comes first, and the
  // listeners then stay open for the session (only changed documents cost
  // reads). Everyone else never loads the admin module.
  let cancelled = false;
  let stopAdmin: Unsubscriber | undefined;
  if (userId === ADMIN_UID) {
    void whenLoaded(stores)
      .then(whenIdle)
      .then(() => import('$lib/admin.ts'))
      .then(({ startAdminPrefetch }) => {
        if (cancelled) return;
        stopAdmin = startAdminPrefetch();
      });
  }

  return () => {
    cancelled = true;
    stopAdmin?.();
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
