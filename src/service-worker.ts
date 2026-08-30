import { build, files, version } from '$service-worker';

declare const self: ServiceWorkerGlobalScope;
const serviceWorker = self;
const CACHE_PREFIX = 'book-tracker-';
const CACHE = `${CACHE_PREFIX}${version}`;
const APP_SHELL = '/';
const APP_FILES = files.filter((path) => !path.startsWith('/screenshots/'));
const PRECACHE_ASSETS = [...new Set([...build, ...APP_FILES, APP_SHELL])];

const BYPASS_PATHS = [
  '/api',
  '/__/auth',
  '/__/firebase',
  '/functions',
  '/firebase'
];

serviceWorker.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE_ASSETS)));
});

serviceWorker.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => serviceWorker.clients.claim())
  );
});

serviceWorker.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (
    request.method !== 'GET' ||
    url.origin !== serviceWorker.location.origin ||
    BYPASS_PATHS.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`))
  ) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(
        (response) => response,
        () =>
          caches
            .match(APP_SHELL)
            .then((cached) => cached ?? Response.error())
      )
    );
    return;
  }

  if (PRECACHE_ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached ?? fetch(request)));
  }
});
