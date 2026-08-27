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

const USERNAME_PATTERN = /^[a-z0-9-]{3,30}$/;
const PROFILE_ROUTE = /^\/profiles\/([^/]+)$/;
const PROFILE_JSON_ROUTE = /^\/profiles\/([^/]+)\.json$/;

// Profiles are public by definition, so both hits and misses may sit on the
// Hosting CDN, and firebase.json carries the same value for /profiles/**.
// The CDN is a convenience, not the ceiling: the function's origin URL is
// reachable directly and every distinct query string is a fresh CDN key, so
// the in-process read cache below is what actually bounds Firestore reads
// per username (SEC-019, SEC-020).
const PROFILE_CACHE_CONTROL = "public, max-age=60, s-maxage=300";
const SITEMAP_CACHE_CONTROL = "public, max-age=300, s-maxage=300";
const READ_CACHE_TTL_MS = 60_000;
const READ_CACHE_MAX_ENTRIES = 1000;

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

export interface ReadCacheOptions {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}

// Per-instance memo of repository reads. Entries are keyed per document and
// expire after ttlMs; a rejected read is evicted immediately so a transient
// Firestore failure is never served for a minute. Concurrent callers for the
// same key share one in-flight promise. Size is bounded by evicting the
// least recently inserted key so a username flood cannot grow memory.
export function cachedRepository(
  repository: PublicWebRepository,
  options: ReadCacheOptions,
): PublicWebRepository {
  const now = options.now ?? Date.now;
  const entries = new Map<string, {expiresAt: number; value: Promise<unknown>}>();

  function read<T>(key: string, load: () => Promise<T>): Promise<T> {
    const at = now();
    const cached = entries.get(key);
    if (cached !== undefined && cached.expiresAt > at) {
      return cached.value as Promise<T>;
    }
    const value = load();
    entries.delete(key);
    entries.set(key, {expiresAt: at + options.ttlMs, value});
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    for (const oldest of entries.keys()) {
      if (entries.size <= options.maxEntries) break;
      entries.delete(oldest);
    }
    return value;
  }

  return {
    getProfile: (username) =>
      read(`profile:${username}`, () => repository.getProfile(username)),
    getDiscovery: (username) =>
      read(`discovery:${username}`, () => repository.getDiscovery(username)),
    listDiscoveries: () =>
      read("discoveries", () => repository.listDiscoveries()),
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

async function profileResponse(
  request: PublicWebRequest,
  repository: PublicWebRepository,
  shell: string,
  username: string,
): Promise<PublicWebResponse> {
  const [storedProfile, storedDiscovery] = await Promise.all([
    repository.getProfile(username),
    repository.getDiscovery(username),
  ]);
  if (storedProfile === null || !profileIsPublic(storedProfile)) {
    return {
      status: 404,
      headers: htmlHeaders(PROFILE_CACHE_CONTROL),
      body: request.method === "HEAD" ? "" : renderNotFoundDocument(shell),
    };
  }

  const profile: PublicProfile = decodePublicProfile(username, storedProfile);
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
      body: request.method === "HEAD" ? "" : "{\"error\":\"not-found\"}\n",
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

let cachedShell: string | null = null;

function profileShell(): string {
  cachedShell ??= readFileSync(join(__dirname, "../assets/profile-shell.html"), "utf8");
  return cachedShell;
}

const liveRepository = cachedRepository(firestoreRepository, {
  ttlMs: READ_CACHE_TTL_MS,
  maxEntries: READ_CACHE_MAX_ENTRIES,
});

// maxInstances bounds what a crawler or request flood can cost in
// invocations: two instances at the gen-2 default concurrency (80) is far
// above real traffic. Firestore reads are bounded separately by the
// per-instance read cache. Raise deliberately if legitimate traffic ever
// queues — the trade is availability under a flood, not correctness.
export const publicweb = onRequest(
  {
    region: "europe-west1",
    timeoutSeconds: 30,
    maxInstances: 2,
  },
  async (request, response) => {
    const result = await resolvePublicWebRequest(
      {method: request.method, path: request.path},
      liveRepository,
      profileShell(),
    );
    response.status(result.status);
    for (const [name, value] of Object.entries(result.headers)) {
      response.set(name, value);
    }
    response.send(result.body);
  },
);
