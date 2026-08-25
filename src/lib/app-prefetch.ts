import { preloadCode } from '$app/navigation';
import { Database } from '$lib/firebase/db.ts';
import type { Unsubscriber } from 'svelte/store';

const PRIVATE_ROUTES = ['/', '/finished', '/me', '/authors', '/isbns'];

// Keep every signed-in route's shared data current. Route components attach
// to these same stores, so navigation never creates a second listener.
export function startAppPrefetch(userId: string): Unsubscriber {
  const stores = [
    Database.getAllBooks(userId),
    Database.getAuthors(userId),
    Database.getUser(userId),
    Database.getMyProfile(userId),
    Database.getAllReadingSessions(userId),
  ];
  const unsubscribers: Unsubscriber[] = stores.map((store) => store.subscribe(() => {}));
  void Promise.all(PRIVATE_ROUTES.map((route) => preloadCode(route)));

  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
