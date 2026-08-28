import {readFileSync} from "node:fs";
import {join} from "node:path";
import {logger} from "firebase-functions";
import {onRequest} from "firebase-functions/v2/https";
import {getFirestore} from "firebase-admin/firestore";
import {
  decodeProfileDiscoveryMarker,
  decodePublicProfile,
  type PublicProfile,
  type PublicProfileLink,
  type PublicProfileRecords,
  type PublicProfileStats,
  type PublicProfileYear,
  type PublicProfileDay,
} from "./decoders";
import {
  renderNotFoundDocument,
  renderProfileDocument,
  renderSitemap,
} from "./publicProfileRenderer";
import {PUBLICWEB_RUNTIME_SERVICE_ACCOUNT} from "./runtime";

const USERNAME_PATTERN = /^[a-z0-9-]{3,30}$/;
const PROFILE_ROUTE = /^\/profiles\/([^/]+)$/;
const PROFILE_JSON_ROUTE = /^\/profiles\/([^/]+)\.json$/;

// Profiles are public by definition, so both hits and misses may sit on the
// Hosting CDN, and firebase.json carries the same value for /profiles/**.
// The CDN is a convenience, not the ceiling: the function has four
// directly reachable origin hostnames and every distinct query string or
// percent-encoding is a fresh CDN key. The response cache below is what
// bounds the origin's work (SEC-019, SEC-020): a repeat path costs nothing
// for RESPONSE_CACHE_TTL_MS, and a flood of *distinct* paths — the key
// space is attacker-chosen — is capped by the per-instance miss budget,
// after which the origin answers 503 without touching Firestore. 200s and
// 404s live in separately bounded pools, so the flood's 404s cannot evict
// real profiles, and while the budget is exhausted a memoised profile is
// served stale for up to RESPONSE_CACHE_STALE_MS instead of failing. Privacy lag for a profile
// flipped private composes across tiers: up to 60 s here (300 s while the
// origin is being flooded) + 300 s shared CDN + 60 s browser, with no
// purge path (SEC-031).
const PROFILE_CACHE_CONTROL = "public, max-age=60, s-maxage=300";
const SITEMAP_CACHE_CONTROL = "public, max-age=300, s-maxage=300";
const RESPONSE_CACHE_TTL_MS = 60_000;
const RESPONSE_CACHE_STALE_MS = 300_000;
// Bounds cached bodies, not just entries. Size from what firestore.rules
// lets a stranger store, not from today's data: a profile at the rules
// ceiling (days ≤ 4000, years ≤ 200, numbers unbounded) serialises to
// ~520 KB on the JSON route and ~275 KB as HTML (measured), so the
// retained pool is up to ~51 MB, and the transient pool holds 404s —
// ~22 bytes for JSON, ~6.5 KB rendered — at most ~7 MB more. In-flight
// requests hold raw + decoded + rendered copies (~1.4 MB each at the
// ceiling), which is why the handler caps concurrency below the gen-2
// default of 80. All against the 256 MiB default.
const RESPONSE_CACHE_MAX_ENTRIES = 100;
const RESPONSE_CACHE_MAX_TRANSIENT_ENTRIES = 1000;
// Uncached profile responses each cost one or two Firestore reads plus a
// decode and render. 300 per minute per instance (2 instances) is far
// above real traffic and caps a rotating-name flood at ~0.9M reads/day
// worst case. The sitemap is bounded separately below.
const MISS_BUDGET_PER_WINDOW = 300;
const MISS_BUDGET_WINDOW_MS = 60_000;
// The sitemap is the one request whose cost scales with data strangers can
// create (SEC-032): one miss, but a profile read per discovery marker. The
// scan is capped, oldest markers first — rules pin a marker's createdAt to
// the server clock, so a seeded collection can only append after the
// profiles that were there before it, never displace them; reads run in
// small batches so at most a batch of ~0.7 MB documents is in memory at
// once; the scan gives up after SITEMAP_SCAN_BUDGET_MS and serves what it
// has rather than time out (a timed-out load is never memoised and would
// be retried on every request) — a cut-short sitemap never replaces a
// fresh complete one and on its own is held for five minutes, not the
// hour, so the degraded worst case is ≈ 288 scans/day/instance; and the
// finished sitemap is pinned in its
// own memo slot for SITEMAP_MEMO_TTL_MS so attacker-owned profiles cannot
// evict it and force a rescan. The uptime check fetches the sitemap
// every 15 minutes through the CDN, so the memo TTL — not the check — sets
// the floor: one scan per instance per hour, ≤ ~50k reads/day across both
// instances at the cap. A sitemap can therefore lag a privacy change by
// up to an hour (+ stale allowance + CDN); profiles pages do not. Past the
// cap the sitemap is deterministically truncated (oldest markers win);
// past the time budget it is marked partial. Both say so in the log.
export const SITEMAP_MAX_PROFILES = 1_000;
export const SITEMAP_READ_CONCURRENCY = 25;
export const SITEMAP_SCAN_BUDGET_MS = 20_000;
const SITEMAP_MEMO_TTL_MS = 3_600_000;
const SITEMAP_PARTIAL_MEMO_TTL_MS = 300_000;

interface StoredDocument {
  id: string;
  value: unknown;
}

export interface PublicWebRepository {
  getProfile(_username: string): Promise<unknown | null>;
  getDiscovery(_username: string): Promise<unknown | null>;
  listDiscoveries(_limit: number): Promise<StoredDocument[]>;
}

export interface PublicWebRequest {
  method: string;
  path: string;
}

export interface PublicWebResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  // A 200 that does not carry everything it should (a sitemap cut short by
  // its time budget). Never retained; for the pinned sitemap key it is a
  // degraded value — see TtlCacheOptions.pinnedDegradedTtlMs.
  partial?: boolean;
}

// The wire shape of /profiles/<username>.json, consumed by the SPA route.
// Deliberately narrower than the stored document: `uid` is the owner's
// Firebase identity and has no business on a public endpoint, and `public`
// is implied — private profiles are not served here at all.
export interface PublicProfileView {
  username: string;
  givenName: string;
  familyName: string;
  links: PublicProfileLink[];
  stats: PublicProfileStats;
  records: PublicProfileRecords | null;
  years: PublicProfileYear[];
  days: PublicProfileDay[];
  updatedAt: string;
}

export function publicProfileView(profile: PublicProfile): PublicProfileView {
  return {
    username: profile.username,
    givenName: profile.givenName,
    familyName: profile.familyName,
    links: profile.links,
    stats: profile.stats,
    records: profile.records,
    years: profile.years,
    days: profile.days,
    updatedAt: profile.updatedAt.toDate().toISOString(),
  };
}

export interface TtlCacheOptions<T> {
  ttlMs: number;
  // Lifetime of a retained entry past which it is dropped even for stale
  // service; must exceed ttlMs.
  staleTtlMs: number;
  maxEntries: number;
  maxTransientEntries: number;
  maxMissesPerWindow: number;
  windowMs: number;
  // Which loaded values are retained (memoised for staleTtlMs, counted
  // against maxEntries); the rest are transient — memoised for ttlMs only,
  // in their own pool bounded by maxTransientEntries. Defaults to retaining
  // everything.
  retain?: (_value: T) => boolean;
  // Keys whose retained values live outside the LRU, uncapped and fresh for
  // pinnedTtlMs (default ttlMs), with the same stale allowance past that as
  // ordinary retained entries. For the few expensive, well-known keys that
  // a flood of cheap 200s must not be able to evict. Defaults to none.
  pin?: (_key: string) => boolean;
  pinnedTtlMs?: number;
  // A pinned key whose load is not retained (a degraded value, such as a
  // sitemap cut short by its time budget) never displaces a fresh retained
  // value; on its own it is held for pinnedDegradedTtlMs (default ttlMs)
  // so a run of degraded loads costs one reload per that interval, not one
  // per request.
  pinnedDegradedTtlMs?: number;
  now?: () => number;
}

export const MISS_BUDGET_EXHAUSTED = Symbol("publicweb miss budget exhausted");

export interface TtlCache<T> {
  get(_key: string, _load: () => Promise<T>): Promise<T> | typeof MISS_BUDGET_EXHAUSTED;
}

interface CacheEntry<T> {
  loadedAt: number;
  value: T;
  degraded?: boolean;
}

// Per-instance memo. An entry is fresh for ttlMs; a hit refreshes recency
// and the least recently used key of the same pool is evicted past that
// pool's cap. Concurrent callers for one key share the in-flight promise,
// and a load only enters a pool once it resolves, so pending and rejected
// loads never occupy or evict a slot. Loads are metered: once
// maxMissesPerWindow uncached loads have started in the current window the
// cache stops loading and reports MISS_BUDGET_EXHAUSTED, which is the
// ceiling on what a flood of distinct keys can cost this instance — unless
// the key has a retained entry younger than staleTtlMs, which is served
// stale rather than refused. A key that reloads as transient drops its
// retained entry, so a value the cache has seen replaced is never revived.
export function createTtlCache<T>(options: TtlCacheOptions<T>): TtlCache<T> {
  if (options.staleTtlMs <= options.ttlMs) throw new Error("staleTtlMs must exceed ttlMs");
  const now = options.now ?? Date.now;
  const retain = options.retain ?? (() => true);
  const pin = options.pin ?? (() => false);
  const pinnedTtlMs = options.pinnedTtlMs ?? options.ttlMs;
  const pinnedDegradedTtlMs = options.pinnedDegradedTtlMs ?? options.ttlMs;
  const pinnedFreshMs = (entry: CacheEntry<T>): number =>
    entry.degraded === true ? pinnedDegradedTtlMs : pinnedTtlMs;
  const staleAllowanceMs = options.staleTtlMs - options.ttlMs;
  const retained = new Map<string, CacheEntry<T>>();
  const pinned = new Map<string, CacheEntry<T>>();
  const transient = new Map<string, CacheEntry<T>>();
  const inflight = new Map<string, Promise<T>>();
  let windowStart = now();
  let misses = 0;

  const touch = (pool: Map<string, CacheEntry<T>>, key: string, entry: CacheEntry<T>): Promise<T> => {
    pool.delete(key);
    pool.set(key, entry);
    return Promise.resolve(entry.value);
  };
  const insert = (pool: Map<string, CacheEntry<T>>, cap: number, key: string, entry: CacheEntry<T>): void => {
    pool.delete(key);
    pool.set(key, entry);
    for (const oldest of pool.keys()) {
      if (pool.size <= cap) break;
      pool.delete(oldest);
    }
  };

  return {
    get(key, load) {
      const at = now();
      const held = pinned.get(key);
      if (held !== undefined && held.loadedAt + pinnedFreshMs(held) > at) return Promise.resolve(held.value);
      const kept = retained.get(key);
      if (kept !== undefined && kept.loadedAt + options.ttlMs > at) return touch(retained, key, kept);
      const passing = transient.get(key);
      if (passing !== undefined && passing.loadedAt + options.ttlMs > at) return touch(transient, key, passing);
      const pending = inflight.get(key);
      if (pending !== undefined) return pending;
      if (at - windowStart >= options.windowMs) {
        windowStart = at;
        misses = 0;
      }
      if (misses >= options.maxMissesPerWindow) {
        if (held !== undefined && held.loadedAt + pinnedFreshMs(held) + staleAllowanceMs > at) {
          return Promise.resolve(held.value);
        }
        if (kept !== undefined && kept.loadedAt + options.staleTtlMs > at) return touch(retained, key, kept);
        return MISS_BUDGET_EXHAUSTED;
      }
      misses += 1;
      const value = load().then((loaded) => {
        const entry = {loadedAt: at, value: loaded};
        if (retain(loaded)) {
          transient.delete(key);
          if (pin(key)) pinned.set(key, entry);
          else insert(retained, options.maxEntries, key, entry);
        } else if (pin(key)) {
          const current = pinned.get(key);
          if (current === undefined || current.degraded === true || current.loadedAt + pinnedTtlMs <= at) {
            pinned.set(key, {...entry, degraded: true});
          }
        } else {
          retained.delete(key);
          insert(transient, options.maxTransientEntries, key, entry);
        }
        return loaded;
      }).finally(() => inflight.delete(key));
      inflight.set(key, value);
      return value;
    },
  };
}

const firestoreRepository: PublicWebRepository = {
  async getProfile(username) {
    const snapshot = await getFirestore().collection("profiles").doc(username).get();
    return snapshot.exists ? snapshot.data() ?? null : null;
  },
  async getDiscovery(username) {
    const snapshot = await getFirestore().collection("profileDiscovery").doc(username).get();
    return snapshot.exists ? snapshot.data() ?? null : null;
  },
  async listDiscoveries(limit) {
    const snapshot = await getFirestore().collection("profileDiscovery")
      .orderBy("createdAt").limit(limit).get();
    return snapshot.docs.map((document) => ({
      id: document.id,
      value: document.data(),
    }));
  },
};

function htmlHeaders(cacheControl: string): Record<string, string> {
  return {
    "Cache-Control": cacheControl,
    "Content-Type": "text/html; charset=utf-8",
  };
}

// The JSON projection is for the SPA, never for crawlers: the HTML page
// carries the owner's search opt-in as a robots meta tag, and the JSON
// twin (which holds strictly more data) must not be indexable regardless.
function jsonHeaders(): Record<string, string> {
  return {
    "Cache-Control": PROFILE_CACHE_CONTROL,
    "Content-Type": "application/json; charset=utf-8",
    "X-Robots-Tag": "noindex",
  };
}

function profileIsPublic(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    !Array.isArray(value) && "public" in value && value.public === true;
}

interface SitemapEntry {
  username: string;
  updatedAt: Date;
}

// One malformed discovery marker or profile document must cost only its own
// sitemap row, not the whole sitemap: rules bound the shapes but do not
// validate every nested value (SEC-009), and the sitemap is the one place
// a single bad document is rendered alongside everyone else's. Firestore
// read failures still propagate — those are infrastructure, not data.
interface SitemapSkip {
  username: string;
  reason: string;
}

function sitemapEntry(
  document: StoredDocument,
  storedProfile: unknown | null,
  skipped: SitemapSkip[],
): SitemapEntry | null {
  if (storedProfile === null || !profileIsPublic(storedProfile)) return null;
  let markerUid: string;
  let profile: PublicProfile;
  try {
    markerUid = decodeProfileDiscoveryMarker(document.value).uid;
    profile = decodePublicProfile(document.id, storedProfile);
  } catch (error) {
    skipped.push({
      username: document.id,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (profile.uid !== markerUid) return null;
  return {username: document.id, updatedAt: profile.updatedAt.toDate()};
}

interface SitemapScan {
  entries: SitemapEntry[];
  complete: boolean;
}

async function sitemapProfiles(
  repository: PublicWebRepository,
): Promise<SitemapScan> {
  const startedAt = Date.now();
  const discoveries = await repository.listDiscoveries(SITEMAP_MAX_PROFILES);
  if (discoveries.length >= SITEMAP_MAX_PROFILES) {
    logger.warn("publicweb.sitemap.truncated", {limit: SITEMAP_MAX_PROFILES});
  }
  const entries: SitemapEntry[] = [];
  let complete = true;
  // Skips are attacker-seedable data, so they are reported once per scan,
  // not once per document.
  const skipped: SitemapSkip[] = [];
  for (let start = 0; start < discoveries.length; start += SITEMAP_READ_CONCURRENCY) {
    if (Date.now() - startedAt > SITEMAP_SCAN_BUDGET_MS) {
      logger.warn("publicweb.sitemap.truncated", {
        budgetMs: SITEMAP_SCAN_BUDGET_MS, scanned: start, of: discoveries.length,
      });
      complete = false;
      break;
    }
    const batch = discoveries.slice(start, start + SITEMAP_READ_CONCURRENCY);
    const resolved = await Promise.all(batch.map(async (document) => {
      if (!USERNAME_PATTERN.test(document.id)) {
        skipped.push({username: document.id, reason: "invalid profile discovery id"});
        return null;
      }
      return sitemapEntry(document, await repository.getProfile(document.id), skipped);
    }));
    for (const entry of resolved) if (entry !== null) entries.push(entry);
  }
  if (skipped.length > 0) {
    logger.warn("publicweb.sitemap.skip", {skipped: skipped.length, sample: skipped.slice(0, 5)});
  }
  return {entries, complete};
}

// The marker is the owner's own document too (rules pin its shape, so a
// malformed one is not reachable today); a profile whose marker fails to
// decode is simply not searchable, never a throw.
function decodeMarkerUid(username: string, stored: unknown): string | null {
  try {
    return decodeProfileDiscoveryMarker(stored).uid;
  } catch (error) {
    logger.warn("publicweb.marker.skip", {
      username,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// A public profile that fails to decode is the owner's own malformed data
// (rules bound shapes, not every nested value — SEC-009/SEC-032). It must
// be an ordinary, memoised 404, not a 500: a rejected load is metered but
// never memoised, so a throwing profile would let one repeated URL spend
// the whole miss budget with no key rotation at all.
function decodeStoredProfile(username: string, stored: unknown): PublicProfile | null {
  try {
    return decodePublicProfile(username, stored);
  } catch (error) {
    logger.warn("publicweb.profile.skip", {
      username,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// Profile first, discovery marker only for a public profile: an unknown
// name — the common case under a flood — costs one read, not two.
async function profileResponse(
  request: PublicWebRequest,
  repository: PublicWebRepository,
  shell: string,
  username: string,
): Promise<PublicWebResponse> {
  const storedProfile = await repository.getProfile(username);
  const profile = storedProfile === null || !profileIsPublic(storedProfile)
    ? null
    : decodeStoredProfile(username, storedProfile);
  if (profile === null) {
    return {
      status: 404,
      headers: htmlHeaders(PROFILE_CACHE_CONTROL),
      body: request.method === "HEAD" ? "" : renderNotFoundDocument(shell),
    };
  }

  const storedDiscovery = await repository.getDiscovery(username);
  const searchable = storedDiscovery === null
    ? false
    : decodeMarkerUid(username, storedDiscovery) === profile.uid;
  return {
    status: 200,
    headers: htmlHeaders(PROFILE_CACHE_CONTROL),
    body: request.method === "HEAD" ? "" :
      renderProfileDocument(shell, profile, searchable),
  };
}

// The SPA's data source for public profiles. Same visibility rule and the
// same cache headers as the HTML page; a missing, private, or malformed
// username is one indistinguishable 404 so username existence never leaks.
async function profileJsonResponse(
  request: PublicWebRequest,
  repository: PublicWebRepository,
  username: string | null,
): Promise<PublicWebResponse> {
  const storedProfile = username === null ? null : await repository.getProfile(username);
  const profile = username === null || storedProfile === null || !profileIsPublic(storedProfile)
    ? null
    : decodeStoredProfile(username, storedProfile);
  if (profile === null) {
    return {
      status: 404,
      headers: jsonHeaders(),
      body: request.method === "HEAD" ? "" : JSON.stringify({error: "not-found"}),
    };
  }
  return {
    status: 200,
    headers: jsonHeaders(),
    body: request.method === "HEAD" ? "" : JSON.stringify(publicProfileView(profile)),
  };
}

export async function resolvePublicWebRequest(
  request: PublicWebRequest,
  repository: PublicWebRepository,
  shell: string,
): Promise<PublicWebResponse> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return {
      status: 405,
      headers: {
        Allow: "GET, HEAD",
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: "Method not allowed.\n",
    };
  }

  if (request.path === "/sitemap.xml") {
    const scan = await sitemapProfiles(repository);
    return {
      status: 200,
      headers: {
        "Cache-Control": SITEMAP_CACHE_CONTROL,
        "Content-Type": "application/xml; charset=utf-8",
      },
      body: request.method === "HEAD" ? "" : renderSitemap(scan.entries),
      ...(scan.complete ? {} : {partial: true}),
    };
  }

  const jsonMatch = PROFILE_JSON_ROUTE.exec(request.path);
  if (jsonMatch !== null) {
    const username = USERNAME_PATTERN.test(jsonMatch[1]) ? jsonMatch[1] : null;
    return profileJsonResponse(request, repository, username);
  }

  const match = PROFILE_ROUTE.exec(request.path);
  if (match === null || !USERNAME_PATTERN.test(match[1])) {
    return {
      status: 404,
      headers: htmlHeaders(PROFILE_CACHE_CONTROL),
      body: request.method === "HEAD" ? "" : renderNotFoundDocument(shell),
    };
  }
  return profileResponse(request, repository, shell, match[1]);
}

// Finished responses are what get cached: decode, render, and serialise
// once per path per TTL. HEAD shares GET's entry and drops the body; 405s
// cost no reads and bypass the cache; a rejected resolve (a Firestore
// failure — malformed data is a 404, never a throw) propagates and is not
// memoised; 404s are memoised in the transient pool, so a repeated unknown
// path is free but a flood of them cannot evict profiles.
export async function cachedPublicWebResponse(
  request: PublicWebRequest,
  repository: PublicWebRepository,
  shell: string,
  cache: TtlCache<PublicWebResponse>,
): Promise<PublicWebResponse> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return resolvePublicWebRequest(request, repository, shell);
  }
  const cached = cache.get(
    request.path,
    () => resolvePublicWebRequest({method: "GET", path: request.path}, repository, shell),
  );
  if (cached === MISS_BUDGET_EXHAUSTED) {
    return {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": "60",
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: "Temporarily unavailable.\n",
    };
  }
  const response = await cached;
  return request.method === "HEAD" ? {...response, body: ""} : response;
}

let cachedShell: string | null = null;

function profileShell(): string {
  cachedShell ??= readFileSync(join(__dirname, "../assets/profile-shell.html"), "utf8");
  return cachedShell;
}

const responseCache = createTtlCache<PublicWebResponse>({
  ttlMs: RESPONSE_CACHE_TTL_MS,
  staleTtlMs: RESPONSE_CACHE_STALE_MS,
  retain: (response) => response.status === 200 && response.partial !== true,
  maxEntries: RESPONSE_CACHE_MAX_ENTRIES,
  maxTransientEntries: RESPONSE_CACHE_MAX_TRANSIENT_ENTRIES,
  maxMissesPerWindow: MISS_BUDGET_PER_WINDOW,
  windowMs: MISS_BUDGET_WINDOW_MS,
  pin: (path) => path === "/sitemap.xml",
  pinnedTtlMs: SITEMAP_MEMO_TTL_MS,
  pinnedDegradedTtlMs: SITEMAP_PARTIAL_MEMO_TTL_MS,
});

// maxInstances bounds what a crawler or request flood can cost in
// invocations, and concurrency bounds what in-flight requests can hold in
// memory: sixteen ceiling-sized profiles in flight is ~22 MB, eighty (the
// gen-2 default) would exceed the 256 MiB instance together with the
// caches. Two instances × 16 is still far above real traffic because
// repeats are memo hits. Firestore reads and render work are bounded
// separately by the per-instance response cache and its miss budget. Raise
// deliberately if legitimate traffic ever queues — the trade is
// availability under a flood, not correctness.
export const publicweb = onRequest(
  {
    region: "europe-west1",
    timeoutSeconds: 30,
    maxInstances: 2,
    concurrency: 16,
    serviceAccount: PUBLICWEB_RUNTIME_SERVICE_ACCOUNT,
  },
  async (request, response) => {
    const result = await cachedPublicWebResponse(
      {method: request.method, path: request.path},
      firestoreRepository,
      profileShell(),
      responseCache,
    );
    response.status(result.status);
    for (const [name, value] of Object.entries(result.headers)) {
      response.set(name, value);
    }
    response.send(result.body);
  },
);
