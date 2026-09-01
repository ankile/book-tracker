import { preloadCode } from '$app/navigation';
import type { Unsubscriber } from 'svelte/store';
import { adminCatalogScan } from '$lib/firebase/adminCatalog.ts';
import { adminOverview, type AdminOverview } from '$lib/firebase/functions.ts';

// Two consoles with two data paths. /admin is the catalog: bibliographic
// data and catalog links, read live through Firestore listeners the rules
// grant the operator. /admin/users is the accounts and issues page: Auth
// metadata and the issue log, which only the Admin SDK can read, so it stays
// a callable that runs when the page is opened and never as a prefetch.
export const ADMIN_ROUTES = ['/admin', '/admin/users'];

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

// Called from the app prefetch once the signed-in account is the operator
// and the app's own stores have delivered: warms both routes' code and
// opens the catalog listeners, which then stay open for the session so the
// console is current whenever it is opened. Returns the listener release.
export function startAdminPrefetch(): Unsubscriber {
  void Promise.all(ADMIN_ROUTES.map((route) => preloadCode(route)));
  return adminCatalogScan.subscribe(() => {});
}
