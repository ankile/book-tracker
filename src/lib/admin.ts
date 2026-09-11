import { preloadCode } from '$app/navigation';
import { ADMIN_UID } from '$lib/admin-uid.ts';
import type { Unsubscriber } from 'svelte/store';
import { adminCatalogScan } from '$lib/firebase/adminCatalog.ts';
import { adminOverview, type AdminOverview } from '$lib/firebase/functions.ts';

// Two consoles with two data paths. /admin is the catalog (the overview
// and one page per work and per author): bibliographic data and catalog
// links, read live through Firestore listeners the rules grant the operator. /admin/users is the accounts and issues page: Auth
// metadata and the issue log, which only the Admin SDK can read, so it stays
// a callable that runs when the page is opened and never as a prefetch.
export const ADMIN_ROUTES = ['/admin', '/admin/works/*', '/admin/authors/*', '/admin/users'];

// The accounts callable takes 5–7 seconds in production (Auth user list
// plus per-account aggregates and the issue feed). Its answer is kept for
// the session so navigating back shows the last answer at once while a
// fresh one loads behind it; the page shows the refresh state and offers an
// explicit reload. An in-flight request is shared.
interface Cached<T> {
  value: T | null;
  loadedAt: number | null;
  inflight: Promise<T> | null;
}

function cache<T>(load: () => Promise<T>): {
  read(): Cached<T>;
  fetch(force?: boolean): Promise<T>;
} {
  const state: Cached<T> = { value: null, loadedAt: null, inflight: null };
  return {
    read: () => state,
    fetch(force = false) {
      if (state.inflight !== null) return state.inflight;
      if (!force && state.value !== null) return Promise.resolve(state.value);
      const pending = load().then((value) => {
        state.value = value;
        state.loadedAt = Date.now();
        return value;
      }).finally(() => {
        if (state.inflight === pending) state.inflight = null;
      });
      state.inflight = pending;
      return pending;
    },
  };
}

export const overviewCache = cache<AdminOverview>(async () => (await adminOverview({})).data);

// A scalar owner stays unchanged across catalog navigation and user-object
// refreshes. Account-only pages and denied routes do not own the catalog.
export function adminCatalogOwner(
  userId: string | undefined,
  routeId: string | null,
): string | undefined {
  return userId === ADMIN_UID && (
    routeId === '/admin' ||
    routeId === '/admin/works/[workId]' ||
    routeId === '/admin/authors/[authorId]'
  ) ? userId : undefined;
}

// The admin layout owns this subscription, keeping catalog listeners shared
// across its child pages and releasing them when the operator leaves admin.
// Route code can preload without starting the accounts callable.
export function startAdminPrefetch(userId: string | undefined): Unsubscriber {
  if (userId !== ADMIN_UID) return () => {};
  void Promise.all(ADMIN_ROUTES.map((route) => preloadCode(route)));
  return adminCatalogScan.subscribe(() => {});
}
