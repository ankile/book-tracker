import { preloadCode } from '$app/navigation';
import { Database } from '$lib/firebase/db.ts';
import type { Unsubscriber } from 'svelte/store';

const PRIVATE_ROUTES = ['/', '/to-read', '/finished', '/me', '/authors', '/isbns'];

// Keep lightweight shared app data current across signed-in routes. History
// belongs to /me and the catalog belongs to the admin layout, so neither
// opens a listener merely because another signed-in page is visible.
export function startAppPrefetch(userId: string): Unsubscriber {
  const stores = [
    Database.getAllBooks(userId),
    Database.getAuthors(),
    Database.getUser(userId),
    Database.getMyProfile(userId),
  ];
  const unsubscribers = stores.map((store) => store.subscribe(() => {}));
  void Promise.all(PRIVATE_ROUTES.map((route) => preloadCode(route)));

  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
