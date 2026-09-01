import { preloadCode } from '$app/navigation';
import {
  adminCatalogScan,
  adminOverview,
  type AdminOverview,
} from '$lib/firebase/functions.ts';
import type { AdminCatalogScanResponse } from '$lib/interfaces/catalog.ts';

// The operator's immutable auth UID — never the email, which is a
// claimable string while signups are open (functions/src/admin.ts enforces
// the same pair of checks on the server). Shipping it in the bundle hides
// nothing and is not meant to: the server gate is the one that matters.
export const ADMIN_UID = '1Cf0CaNfgnVSvTrF5dYjzRd9Xri2';

export const ADMIN_ROUTES = ['/admin', '/admin/catalog'];

// The two admin callables take 3–9 seconds each in production (whole-
// catalog scan; per-account aggregates plus the issue feed). Both answers
// are kept for the session so navigating back to a page shows the last
// answer at once while a fresh one loads behind it; the pages show the
// refresh state and offer an explicit reload. An in-flight request is
// shared, so a prefetch and a page mount never issue it twice.
interface Cached<T> {
  value: T | null;
  loadedAt: number | null;
  inflight: Promise<T> | null;
  error: unknown;
}

function cache<T>(load: () => Promise<T>): {
  read(): Cached<T>;
  fetch(force?: boolean): Promise<T>;
  clear(): void;
} {
  const state: Cached<T> = { value: null, loadedAt: null, inflight: null, error: null };
  return {
    read: () => state,
    fetch(force = false) {
      if (state.inflight !== null) return state.inflight;
      if (!force && state.value !== null) return Promise.resolve(state.value);
      const pending = load().then((value) => {
        state.value = value;
        state.loadedAt = Date.now();
        state.error = null;
        return value;
      }, (error: unknown) => {
        state.error = error;
        throw error;
      }).finally(() => {
        if (state.inflight === pending) state.inflight = null;
      });
      state.inflight = pending;
      return pending;
    },
    clear() {
      state.value = null;
      state.loadedAt = null;
      state.error = null;
    },
  };
}

export const overviewCache = cache<AdminOverview>(async () => (await adminOverview({})).data);

// First scan page only: continuation pages (the next hundred unmatched
// books) are appended by the catalog page itself and are not cached.
export const scanCache = cache<AdminCatalogScanResponse>(() => adminCatalogScan(null));

// Called from the app prefetch once the signed-in account is the operator:
// warms both routes' code and both answers so /admin and /admin/catalog
// open with data already on hand.
export function startAdminPrefetch(): void {
  void Promise.all(ADMIN_ROUTES.map((route) => preloadCode(route)));
  void overviewCache.fetch().catch(() => undefined);
  void scanCache.fetch().catch(() => undefined);
}
