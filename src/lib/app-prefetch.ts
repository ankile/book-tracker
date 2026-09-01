import { preloadCode } from '$app/navigation';
import { ADMIN_UID } from '$lib/admin.ts';
import { Database } from '$lib/firebase/db.ts';
import type { Unsubscriber } from 'svelte/store';

const PRIVATE_ROUTES = ['/', '/finished', '/me', '/authors', '/isbns'];

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
  // The operator's two admin pages are slow to answer (whole-catalog scan,
  // per-account aggregates), so their code and answers are warmed in the
  // same idle slot; the pages then open on the cached answer. Everyone
  // else never loads the admin module.
  if (userId === ADMIN_UID) {
    void import('$lib/admin.ts').then(({ startAdminPrefetch }) => startAdminPrefetch());
  }

  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
