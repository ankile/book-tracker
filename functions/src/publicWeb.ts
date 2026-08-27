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
// Bounds cached bodies, not just entries: at ~100 KB per real profile this
// is ~10 MB against the 256 MiB default. 404s are ~22 bytes each.
const RESPONSE_CACHE_MAX_ENTRIES = 100;
const RESPONSE_CACHE_MAX_TRANSIENT_ENTRIES = 1000;
// Uncached responses each cost one or two Firestore reads plus a decode and
// render. 300 per minute per instance (2 instances) is far above real
// traffic and caps a rotating-name flood at ~0.9M reads/day worst case.
const MISS_BUDGET_PER_WINDOW = 300;
const MISS_BUDGET_WINDOW_MS = 60_000;

interface StoredDocument {
  id: string;
  value: unknown;
}

export interface PublicWebRepository {
  getProfile(_username: string): Promise<unknown | null>;
  getDiscovery(_username: string): Promise<unknown | null>;
  listDiscoveries(): Promise<StoredDocument[]>;
}

export interface PublicWebRequest {
  method: string;
  path: string;
}

export interface PublicWebResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
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
  now?: () => number;
}

export const MISS_BUDGET_EXHAUSTED = Symbol("publicweb miss budget exhausted");

export interface TtlCache<T> {
  get(_key: string, _load: () => Promise<T>): Promise<T> | typeof MISS_BUDGET_EXHAUSTED;
}

interface CacheEntry<T> {
  loadedAt: number;
  value: T;
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
  const retained = new Map<string, CacheEntry<T>>();
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
        if (kept !== undefined && kept.loadedAt + options.staleTtlMs > at) return touch(retained, key, kept);
        return MISS_BUDGET_EXHAUSTED;
      }
      misses += 1;
      const value = load().then((loaded) => {
        const entry = {loadedAt: at, value: loaded};
        if (retain(loaded)) {
          transient.delete(key);
          insert(retained, options.maxEntries, key, entry);
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
  async listDiscoveries() {
    const snapshot = await getFirestore().collection("profileDiscovery").get();
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

function jsonHeaders(): Record<string, string> {
  return {
    "Cache-Control": PROFILE_CACHE_CONTROL,
    "Content-Type": "application/json; charset=utf-8",
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
function sitemapEntry(
  document: StoredDocument,
  storedProfile: unknown | null,
): SitemapEntry | null {
  if (storedProfile === null || !profileIsPublic(storedProfile)) return null;
  let markerUid: string;
  let profile: PublicProfile;
  try {
    markerUid = decodeProfileDiscoveryMarker(document.value).uid;
    profile = decodePublicProfile(document.id, storedProfile);
  } catch (error) {
    logger.warn("publicweb.sitemap.skip", {
      username: document.id,
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  if (profile.uid !== markerUid) return null;
  return {username: document.id, updatedAt: profile.updatedAt.toDate()};
}

async function sitemapProfiles(
  repository: PublicWebRepository,
): Promise<SitemapEntry[]> {
  const discoveries = await repository.listDiscoveries();
  const entries = await Promise.all(discoveries.map(async (document) => {
    if (!USERNAME_PATTERN.test(document.id)) {
      logger.warn("publicweb.sitemap.skip", {
        username: document.id,
        reason: "invalid profile discovery id",
      });
      return null;
    }
    return sitemapEntry(document, await repository.getProfile(document.id));
  }));
  return entries.filter((entry): entry is SitemapEntry => entry !== null);
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
  if (storedProfile === null || !profileIsPublic(storedProfile)) {
    return {
      status: 404,
      headers: htmlHeaders(PROFILE_CACHE_CONTROL),
      body: request.method === "HEAD" ? "" : renderNotFoundDocument(shell),
    };
  }

  const profile: PublicProfile = decodePublicProfile(username, storedProfile);
  const storedDiscovery = await repository.getDiscovery(username);
  const searchable = storedDiscovery === null
    ? false
    : decodeProfileDiscoveryMarker(storedDiscovery).uid === profile.uid;
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
  if (username === null || storedProfile === null || !profileIsPublic(storedProfile)) {
    return {
      status: 404,
      headers: jsonHeaders(),
      body: request.method === "HEAD" ? "" : JSON.stringify({error: "not-found"}),
    };
  }
  const profile = decodePublicProfile(username, storedProfile);
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
    const profiles = await sitemapProfiles(repository);
    return {
      status: 200,
      headers: {
        "Cache-Control": SITEMAP_CACHE_CONTROL,
        "Content-Type": "application/xml; charset=utf-8",
      },
      body: request.method === "HEAD" ? "" : renderSitemap(profiles),
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
// cost no reads and bypass the cache; a rejected resolve propagates and is
// not memoised; 404s are memoised in the transient pool, so a repeated
// unknown path is free but a flood of them cannot evict profiles.
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
  retain: (response) => response.status === 200,
  maxEntries: RESPONSE_CACHE_MAX_ENTRIES,
  maxTransientEntries: RESPONSE_CACHE_MAX_TRANSIENT_ENTRIES,
  maxMissesPerWindow: MISS_BUDGET_PER_WINDOW,
  windowMs: MISS_BUDGET_WINDOW_MS,
});

// maxInstances bounds what a crawler or request flood can cost in
// invocations: two instances at the gen-2 default concurrency (80) is far
// above real traffic. Firestore reads and render work are bounded
// separately by the per-instance response cache and its miss budget. Raise
// deliberately if legitimate traffic ever queues — the trade is
// availability under a flood, not correctness.
export const publicweb = onRequest(
  {
    region: "europe-west1",
    timeoutSeconds: 30,
    maxInstances: 2,
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
