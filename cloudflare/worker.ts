// Cloudflare Pages worker for book.ankile.com (SEC-067, hardening-queue
// step 16). Replaces firebase.json's Hosting block: static assets come from
// the Pages bundle (env.ASSETS), /profiles/** and /sitemap.xml are proxied
// to the publicweb Cloud Run service, and every response carries the same
// header policy Hosting used to add. cloudflare/assemble.ts strips the types
// (node:module stripTypeScriptTypes) into .pages-dist/_worker.js; the unit
// tests import this file directly.

export const ORIGIN = 'https://publicweb-juiumzbyrq-ew.a.run.app';

export interface PagesEnv {
  ASSETS: {fetch(request: Request): Promise<Response>};
}

// The header policy Firebase Hosting used to add for every path (its former
// `**` block); firebase.json now only describes the retired redirect site.
export const BASE_HEADERS: Readonly<Record<string, string>> & {'Cache-Control': string} = {
  'Cache-Control': 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy':
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
};
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

// Firebase Auth's hosted email-action page (verify-email and password-reset
// links land there) exists only on the project's Hosting domains: Hosting is
// retired to a redirect, but the reserved /__/ paths keep working on it. The
// action URL configured in Auth is https://book.ankile.com/__/auth/action so
// the link a user sees in the email is our domain; this hop delivers it to
// the page, query string verbatim (mode, oobCode, apiKey, continueUrl, lang).
// 302 and no-store: an oobCode is single-use and must never sit in a cache.
export const AUTH_ACTION_ORIGIN = 'https://book-tracker-d8f24.web.app';
const AUTH_ACTION_PREFIX = '/__/auth/';

export function isAuthActionPath(pathname: string): boolean {
  return pathname.startsWith(AUTH_ACTION_PREFIX);
}
export const PROFILE_CACHE_CONTROL = 'public, max-age=60, s-maxage=300';
export const SITEMAP_CACHE_CONTROL = 'public, max-age=300, s-maxage=300';

// Request headers worth passing to the renderer. Nothing else crosses:
// no cookies, no authorization, no client IP.
const FORWARDED_REQUEST_HEADERS: readonly string[] = [
  'accept',
  'accept-encoding',
  'accept-language',
  'if-modified-since',
  'if-none-match',
  'user-agent',
];

const PROFILE_TRAILING_SLASH = /^\/profiles\/([^/]+)\/$/;

export function isRenderedPath(pathname: string): boolean {
  return pathname === '/sitemap.xml' || pathname.startsWith('/profiles/');
}

export function cacheControlFor(pathname: string): string {
  if (pathname === '/sitemap.xml') return SITEMAP_CACHE_CONTROL;
  if (pathname.startsWith('/profiles/')) return PROFILE_CACHE_CONTROL;
  if (pathname.startsWith('/_app/immutable/')) return IMMUTABLE_CACHE_CONTROL;
  return BASE_HEADERS['Cache-Control'];
}

// Pages answers an unknown path with the SPA shell (200 text/html). Hosting
// stamped that shell "immutable" under a stale /_app/immutable/ URL; here a
// shell is never immutable, whatever path produced it.
function servedTheShell(response: Response): boolean {
  const type = response.headers.get('Content-Type') ?? '';
  return type.startsWith('text/html');
}

function withPolicy(response: Response, pathname: string): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(BASE_HEADERS)) headers.set(name, value);
  const cacheControl = cacheControlFor(pathname);
  headers.set(
    'Cache-Control',
    cacheControl === IMMUTABLE_CACHE_CONTROL && servedTheShell(response) ? BASE_HEADERS['Cache-Control'] : cacheControl,
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function textResponse(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {'Content-Type': 'text/plain; charset=utf-8', ...extra},
  });
}

// Edge cache for rendered responses. Cloudflare only caches worker
// subrequests for static file extensions by default, so without this every
// profile request reaches Cloud Run (cf-cache-status DYNAMIC — the state
// the migration briefly shipped). These TTLs reproduce the s-maxage the
// old Hosting CDN honoured: a hot profile is served from the edge for five
// minutes with no renderer or Firestore work, a miss (404) for one minute,
// and an error is never cached. Firestore edits therefore take up to five
// minutes to show publicly, as before.
export const RENDERED_EDGE_CACHE = {
  cacheEverything: true,
  cacheTtlByStatus: {'200-299': 300, '404': 60, '500-599': 0},
} as const;

interface EdgeCachedRequestInit extends RequestInit {
  cf: typeof RENDERED_EDGE_CACHE;
}

// Fail closed: a renderer outage is a 503 with no caching, never the SPA
// shell (a crawler must not index the shell under a profile URL).
async function renderedResponse(request: Request, url: URL): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return textResponse(405, 'Method not allowed.\n', {Allow: 'GET, HEAD'});
  }
  // The renderer routes on the path alone and ignores the query string, so
  // it is dropped here: every ?cb=… variant of a profile URL shares one
  // edge cache entry, and cache-busting cannot force renderer work
  // (SEC-067's remaining billed-miss vector).
  const upstream = new URL(url.pathname, ORIGIN);
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const init: EdgeCachedRequestInit = {
    method: request.method,
    headers,
    redirect: 'manual',
    cf: RENDERED_EDGE_CACHE,
  };
  try {
    return await fetch(upstream, init);
  } catch {
    return textResponse(503, 'Profile renderer unavailable.\n', {'Retry-After': '30'});
  }
}

const worker = {
  async fetch(request: Request, env: PagesEnv): Promise<Response> {
    const url = new URL(request.url);
    if (isAuthActionPath(url.pathname)) {
      const target = new URL(url.pathname + url.search, AUTH_ACTION_ORIGIN);
      const hop = withPolicy(Response.redirect(target.toString(), 302), url.pathname);
      hop.headers.set('Cache-Control', 'no-store');
      return hop;
    }
    const trailing = PROFILE_TRAILING_SLASH.exec(url.pathname);
    if (trailing !== null) {
      const target = new URL(`/profiles/${trailing[1]}${url.search}`, url);
      return withPolicy(Response.redirect(target.toString(), 301), url.pathname);
    }
    const response = isRenderedPath(url.pathname)
      ? await renderedResponse(request, url)
      : await env.ASSETS.fetch(request);
    return withPolicy(response, url.pathname);
  },
};

export default worker;
