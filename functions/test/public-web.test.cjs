require("./setup.cjs");

const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const test = require("node:test");
const {Timestamp} = require("firebase-admin/firestore");

const {
  renderNotFoundDocument,
  renderProfileDocument,
  renderSitemap,
} = require("../lib/publicProfileRenderer");
const {
  MISS_BUDGET_EXHAUSTED,
  SITEMAP_MAX_PROFILES,
  SITEMAP_READ_CONCURRENCY,
  SITEMAP_SCAN_BUDGET_MS,
  cachedPublicWebResponse,
  createTtlCache,
  resolvePublicWebRequest,
} = require("../lib/publicWeb");

const shell = readFileSync(
  join(__dirname, "..", "assets", "profile-shell.html"),
  "utf8",
);

function profile(username = "ada-lovelace", overrides = {}) {
  return {
    username,
    uid: "owner",
    public: true,
    givenName: "Ada",
    familyName: "Lovelace",
    links: [{type: "homepage", value: "https://example.com/?x=1&y=2"}],
    stats: {
      totalBooks: 12,
      finishedBooks: 10,
      readingBooks: 2,
      totalTimeReadHours: 80,
      totalPagesRead: 3200,
      booksPerYear: 8.5,
      avgTimePerBook: 480,
      authors: 9,
    },
    years: [{year: 2026, count: 10, hours: 80, pages: 3200}],
    days: [{day: "2026-08-20", pagesRead: 120, timeRead: 95, sessions: 1}],
    updatedAt: Timestamp.fromDate(new Date("2026-08-24T12:00:00.000Z")),
    ...overrides,
  };
}

function storedProfile(overrides = {}) {
  const {username: _username, ...stored} = profile("ada-lovelace", overrides);
  return {...stored, records: null};
}

function repository({profiles = {}, discoveries = {}} = {}) {
  return {
    getProfile: async (username) => profiles[username] ?? null,
    getDiscovery: async (username) => discoveries[username] ?? null,
    listDiscoveries: async () => Object.entries(discoveries).map(([id, value]) => ({
      id,
      value,
    })),
  };
}

const marker = {
  uid: "owner",
  createdAt: Timestamp.fromDate(new Date("2026-08-25T12:00:00.000Z")),
};

test("renders a complete, escaped, indexable profile document", () => {
  const html = renderProfileDocument(shell, profile("ada-lovelace", {
    givenName: "Ada </script><script>",
  }), true);

  assert.match(html, /Ada &lt;\/script&gt;&lt;script&gt; Lovelace&#39;s reading profile \| Book Tracker/);
  assert.doesNotMatch(html, /Ada <\/script><script>/);
  assert.match(html, /name="robots" content="index,follow,max-image-preview:large"/);
  assert.match(html, /rel="canonical" href="https:\/\/book\.ankile\.com\/profiles\/ada-lovelace"/);
  assert.match(html, /property="og:title"/);
  assert.match(html, /property="og:image" content="https:\/\/book\.ankile\.com\/social\/profile-card\.png"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  const structuredData = JSON.parse(
    html.match(/<script data-server-profile-meta type="application\/ld\+json">([^<]+)<\/script>/)[1],
  );
  assert.equal(structuredData["@type"], "ProfilePage");
  assert.equal(structuredData.mainEntity["@type"], "Person");
  assert.equal(structuredData.mainEntity.name, "Ada </script><script> Lovelace");
  assert.equal(structuredData.mainEntity.alternateName, "@ada-lovelace");
  assert.deepEqual(structuredData.mainEntity.sameAs, ["https://example.com/?x=1&y=2"]);
  assert.match(html, /Books read/);
  assert.match(html, /3,200/);
  assert.match(html, /href="https:\/\/example\.com\/\?x=1&amp;y=2"/);
  assert.match(html, /_app\/immutable\/entry\/start\.[A-Za-z0-9_-]+\.js/);
  assert.match(html, /document\.documentElement\.classList\.add\('js'\)/);
  assert.match(html, /html\.js #profile-snapshot-slot:not\(:empty\)/);
});

test("renders public unlisted profiles with noindex", () => {
  const html = renderProfileDocument(shell, profile(), false);
  assert.match(html, /name="robots" content="noindex,follow"/);
  assert.match(html, /<h1>Ada Lovelace<\/h1>/);
});

test("renders unavailable profiles without leaking a username", () => {
  const html = renderNotFoundDocument(shell);
  assert.match(html, /name="robots" content="noindex,nofollow"/);
  assert.match(html, /This profile was not found\./);
  assert.doesNotMatch(html, /ada-lovelace/);
});

test("request resolver enforces public and discovery state", async () => {
  const publicProfile = storedProfile();
  const searchable = repository({
    profiles: {"ada-lovelace": publicProfile},
    discoveries: {"ada-lovelace": marker},
  });
  const listed = await resolvePublicWebRequest(
    {method: "GET", path: "/profiles/ada-lovelace"},
    searchable,
    shell,
  );
  assert.equal(listed.status, 200);
  assert.equal(listed.headers["Cache-Control"], "public, max-age=60, s-maxage=300");
  assert.match(listed.body, /index,follow/);

  const unlisted = await resolvePublicWebRequest(
    {method: "GET", path: "/profiles/ada-lovelace"},
    repository({profiles: {"ada-lovelace": publicProfile}}),
    shell,
  );
  assert.equal(unlisted.status, 200);
  assert.match(unlisted.body, /noindex,follow/);

  for (const hidden of [
    repository(),
    repository({profiles: {"ada-lovelace": {...publicProfile, public: false}}}),
  ]) {
    const response = await resolvePublicWebRequest(
      {method: "GET", path: "/profiles/ada-lovelace"},
      hidden,
      shell,
    );
    assert.equal(response.status, 404);
    assert.equal(response.headers["Cache-Control"], "public, max-age=60, s-maxage=300");
    assert.match(response.body, /noindex,nofollow/);
    assert.doesNotMatch(response.body, /ada-lovelace/);
  }
});

test("request resolver validates routes and HEAD without a response body", async () => {
  const profiles = repository({profiles: {"ada-lovelace": storedProfile()}});
  const head = await resolvePublicWebRequest(
    {method: "HEAD", path: "/profiles/ada-lovelace"},
    profiles,
    shell,
  );
  assert.equal(head.status, 200);
  assert.equal(head.body, "");

  const invalid = await resolvePublicWebRequest(
    {method: "GET", path: "/profiles/Bad%20Slug"},
    profiles,
    shell,
  );
  assert.equal(invalid.status, 404);
  assert.equal(invalid.headers["Cache-Control"], "public, max-age=60, s-maxage=300");

  const method = await resolvePublicWebRequest(
    {method: "POST", path: "/profiles/ada-lovelace"},
    profiles,
    shell,
  );
  assert.equal(method.status, 405);
  assert.equal(method.headers.Allow, "GET, HEAD");
  assert.equal(method.headers["Cache-Control"], "no-store");
});

test("profile JSON projection serves public profiles without the owner uid", async () => {
  const records = {
    momentum: {recentPagesPerDay: 40, lifetimePagesPerDay: 25, ratio: 1.6},
    superlatives: {
      biggestDay: {day: "2026-08-20", pages: 120},
      longestSession: {minutes: 95},
      medianSessionMinutes: 30,
      fastestFinish: {days: 3, pageCount: 300},
    },
  };
  const repo = repository({profiles: {"ada-lovelace": {...storedProfile(), records}}});
  const response = await resolvePublicWebRequest(
    {method: "GET", path: "/profiles/ada-lovelace.json"},
    repo,
    shell,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(response.headers["Cache-Control"], "public, max-age=60, s-maxage=300");
  const body = JSON.parse(response.body);
  assert.deepEqual(Object.keys(body).sort(), [
    "days", "familyName", "givenName", "links", "records", "stats",
    "updatedAt", "username", "years",
  ]);
  assert.equal(body.username, "ada-lovelace");
  assert.equal(body.updatedAt, "2026-08-24T12:00:00.000Z");
  assert.deepEqual(body.records, records);
  assert.deepEqual(body.links, [{type: "homepage", value: "https://example.com/?x=1&y=2"}]);
  assert.doesNotMatch(response.body, /owner/);

  const head = await resolvePublicWebRequest(
    {method: "HEAD", path: "/profiles/ada-lovelace.json"},
    repo,
    shell,
  );
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
});

test("profile JSON projection answers missing, private, and invalid names identically", async () => {
  const cases = [
    [repository(), "/profiles/ada-lovelace.json"],
    [repository({profiles: {"ada-lovelace": storedProfile({public: false})}}), "/profiles/ada-lovelace.json"],
    [repository({profiles: {"ada-lovelace": storedProfile()}}), "/profiles/Ada-Lovelace.json"],
    [repository({profiles: {"ada-lovelace": storedProfile()}}), "/profiles/ada-lovelace.json.json"],
  ];
  for (const [repo, path] of cases) {
    const response = await resolvePublicWebRequest({method: "GET", path}, repo, shell);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers["Content-Type"], "application/json; charset=utf-8");
    assert.equal(response.headers["Cache-Control"], "public, max-age=60, s-maxage=300");
    assert.deepEqual(JSON.parse(response.body), {error: "not-found"});
  }
  const method = await resolvePublicWebRequest(
    {method: "POST", path: "/profiles/ada-lovelace.json"},
    repository(),
    shell,
  );
  assert.equal(method.status, 405);
});

test("an unknown or private profile costs one read, a public one two", async () => {
  const calls = {profile: 0, discovery: 0};
  const counting = (profiles) => ({
    getProfile: async (username) => {
      calls.profile += 1;
      return profiles[username] ?? null;
    },
    getDiscovery: async () => {
      calls.discovery += 1;
      return marker;
    },
    listDiscoveries: async () => [],
  });
  await resolvePublicWebRequest(
    {method: "GET", path: "/profiles/nobody-here"},
    counting({}),
    shell,
  );
  await resolvePublicWebRequest(
    {method: "GET", path: "/profiles/ada-lovelace"},
    counting({"ada-lovelace": storedProfile({public: false})}),
    shell,
  );
  assert.deepEqual(calls, {profile: 2, discovery: 0});
  await resolvePublicWebRequest(
    {method: "GET", path: "/profiles/ada-lovelace"},
    counting({"ada-lovelace": storedProfile()}),
    shell,
  );
  assert.deepEqual(calls, {profile: 3, discovery: 1});
});

test("ttl cache shares in-flight loads, expires, evicts LRU, drops failures, and meters misses", async () => {
  let clock = 1_000;
  const cache = createTtlCache({
    ttlMs: 60_000, staleTtlMs: 300_000, maxEntries: 2, maxTransientEntries: 2, maxMissesPerWindow: 4, windowMs: 60_000, now: () => clock,
  });
  let loads = 0;
  const load = (value) => async () => {
    loads += 1;
    return value;
  };

  const a1 = cache.get("a", load("a"));
  const a2 = cache.get("a", load("a"));
  assert.equal(a1, a2);
  assert.equal(await a1, "a");
  assert.equal(loads, 1);

  clock += 59_999;
  assert.equal(await cache.get("a", load("a")), "a");
  assert.equal(loads, 1);
  clock += 1;
  assert.equal(await cache.get("a", load("a")), "a");
  assert.equal(loads, 2);

  // maxEntries 2: touching "a" makes "b" the least recently used, so a
  // third key evicts "b", not "a".
  await cache.get("b", load("b"));
  await cache.get("a", load("a"));
  await cache.get("c", load("c"));
  assert.equal(loads, 4);
  assert.equal(await cache.get("a", load("a")), "a");
  assert.equal(loads, 4);
  assert.equal(await cache.get("b", load("b")), "b");
  assert.equal(loads, 5);
  // The window budget is 4 loads (a again, b, c, b again); a fifth distinct
  // key is refused without loading.
  assert.equal(cache.get("d", load("d")), MISS_BUDGET_EXHAUSTED);
  assert.equal(loads, 5);
  // Cached keys still serve while the budget is exhausted.
  assert.equal(await cache.get("b", load("b")), "b");
  assert.equal(loads, 5);

  clock += 60_000;
  assert.equal(await cache.get("d", load("d")), "d");
  assert.equal(loads, 6);

  // A rejected load propagates and leaves nothing behind: the next call
  // loads again.
  await assert.rejects(
    cache.get("broken", async () => {
      loads += 1;
      throw new Error("firestore unavailable");
    }),
    /firestore unavailable/,
  );
  assert.equal(await cache.get("broken", load("repaired")), "repaired");
  assert.equal(loads, 8);
});

test("ttl cache pools transient values apart, serves retained ones stale, and drops replaced entries", async () => {
  assert.throws(
    () => createTtlCache({ttlMs: 60_000, staleTtlMs: 60_000, maxEntries: 1, maxTransientEntries: 1, maxMissesPerWindow: 1, windowMs: 1}),
    /staleTtlMs must exceed ttlMs/,
  );
  let clock = 1_000;
  const cache = createTtlCache({
    ttlMs: 60_000,
    staleTtlMs: 300_000,
    maxEntries: 2,
    maxTransientEntries: 2,
    maxMissesPerWindow: 3,
    windowMs: 30_000,
    retain: (value) => value !== "miss",
    now: () => clock,
  });
  let loads = 0;
  const load = (value) => async () => {
    loads += 1;
    return value;
  };

  await cache.get("a", load("a"));
  await cache.get("b", load("b"));
  assert.equal(await cache.get("x", load("miss")), "miss");
  assert.equal(loads, 3);
  // Budget spent; a transient repeat is still free.
  assert.equal(cache.get("y", load("y")), MISS_BUDGET_EXHAUSTED);
  assert.equal(await cache.get("x", load("miss")), "miss");
  assert.equal(await cache.get("a", load("a")), "a");
  assert.equal(loads, 3);

  // New window, "a" and "b" past ttlMs. Three transient loads spend the
  // budget and overflow the transient pool (cap 2) — without touching the
  // retained pool, so "a" and "b" are served stale rather than refused.
  clock += 60_000;
  for (const key of ["x2", "y2", "z2"]) assert.equal(await cache.get(key, load("miss")), "miss");
  assert.equal(loads, 6);
  assert.equal(await cache.get("a", load("a")), "a");
  assert.equal(await cache.get("b", load("b")), "b");
  assert.equal(cache.get("x2", load("miss")), MISS_BUDGET_EXHAUSTED);
  assert.equal(await cache.get("y2", load("miss")), "miss");
  assert.equal(loads, 6);

  // "a" reloads as transient: the retained entry is dropped, not kept for
  // stale service.
  clock += 30_000;
  assert.equal(await cache.get("a", load("miss")), "miss");
  assert.equal(await cache.get("p", load("miss")), "miss");
  assert.equal(await cache.get("a", load("a")), "miss");
  // Touching "a" made "p" the transient pool's LRU, so "q" evicts "p".
  assert.equal(await cache.get("q", load("miss")), "miss");
  assert.equal(loads, 9);
  assert.equal(await cache.get("a", load("a")), "miss");
  assert.equal(cache.get("p", load("miss")), MISS_BUDGET_EXHAUSTED);
  assert.equal(loads, 9);
  clock += 60_000;
  for (const key of ["r", "s", "t"]) assert.equal(await cache.get(key, load("miss")), "miss");
  assert.equal(loads, 12);
  assert.equal(cache.get("a", load("a")), MISS_BUDGET_EXHAUSTED);
  assert.equal(await cache.get("b", load("b")), "b");
  assert.equal(loads, 12);

  // 300 s after its load "b" is past staleTtlMs and refused like any key.
  clock += 150_000;
  for (const key of ["u", "v", "w"]) assert.equal(await cache.get(key, load("miss")), "miss");
  assert.equal(loads, 15);
  assert.equal(cache.get("b", load("b")), MISS_BUDGET_EXHAUSTED);
});

test("cached responses serve repeats without reads, share HEAD with GET, and 503 past the budget", async () => {
  let clock = 1_000;
  const cache = createTtlCache({
    ttlMs: 60_000,
    staleTtlMs: 300_000,
    maxEntries: 100,
    maxTransientEntries: 100,
    maxMissesPerWindow: 2,
    windowMs: 60_000,
    retain: (response) => response.status === 200,
    now: () => clock,
  });
  let reads = 0;
  const repo = {
    getProfile: async (username) => {
      reads += 1;
      return username === "ada-lovelace" ? storedProfile() : null;
    },
    getDiscovery: async () => null,
    listDiscoveries: async () => [],
  };
  const get = (path, method = "GET") =>
    cachedPublicWebResponse({method, path}, repo, shell, cache);

  const first = await get("/profiles/ada-lovelace.json");
  const second = await get("/profiles/ada-lovelace.json");
  assert.equal(first.status, 200);
  assert.equal(second.body, first.body);
  assert.equal(reads, 1);
  const head = await get("/profiles/ada-lovelace.json", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  assert.equal(head.headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(reads, 1);

  const miss = await get("/profiles/nobody-here.json");
  assert.equal(miss.status, 404);
  assert.equal(reads, 2);
  // Budget spent: a repeated 404 is memoised, a new name is refused.
  assert.equal((await get("/profiles/nobody-here.json")).status, 404);
  const refused = await get("/profiles/another-name.json");
  assert.equal(refused.status, 503);
  assert.equal(refused.headers["Cache-Control"], "no-store");
  assert.equal(refused.headers["Retry-After"], "60");
  assert.equal(reads, 2);
  assert.equal((await get("/profiles/ada-lovelace.json")).status, 200);
  // 405 never consults the cache or Firestore.
  const method = await get("/profiles/ada-lovelace.json", "POST");
  assert.equal(method.status, 405);
  assert.equal(reads, 2);

  // Next window: two unknown names spend the budget again; the profile,
  // now past its minute, is served stale instead of refused.
  clock += 60_000;
  assert.equal((await get("/profiles/another-name.json")).status, 404);
  assert.equal((await get("/profiles/third-name.json")).status, 404);
  assert.equal(reads, 4);
  assert.equal((await get("/profiles/fourth-name.json")).status, 503);
  assert.equal((await get("/profiles/ada-lovelace.json")).status, 200);
  assert.equal((await get("/profiles/ada-lovelace", "HEAD")).status, 503);
  assert.equal(reads, 4);

  // Budget back: the stale profile refreshes with a read.
  clock += 60_000;
  assert.equal((await get("/profiles/ada-lovelace.json")).status, 200);
  assert.equal(reads, 5);
});

test("sitemap includes only public profiles with matching discovery owners", async () => {
  const result = await resolvePublicWebRequest(
    {method: "GET", path: "/sitemap.xml"},
    repository({
      profiles: {
        "ada-lovelace": storedProfile(),
        "grace-hopper": storedProfile({
          uid: "grace",
          givenName: "Grace",
          familyName: "Hopper",
        }),
        "private-reader": storedProfile({public: false}),
      },
      discoveries: {
        "ada-lovelace": marker,
        "grace-hopper": marker,
        "missing-reader": marker,
        "private-reader": marker,
      },
    }),
    shell,
  );

  assert.equal(result.status, 200);
  assert.equal(result.headers["Content-Type"], "application/xml; charset=utf-8");
  assert.match(result.body, /profiles\/ada-lovelace/);
  assert.doesNotMatch(result.body, /grace-hopper|missing-reader|private-reader/);
  assert.match(result.body, /<lastmod>2026-08-24T12:00:00\.000Z<\/lastmod>/);
});

test("sitemap skips a malformed profile or marker instead of failing", async () => {
  const result = await resolvePublicWebRequest(
    {method: "GET", path: "/sitemap.xml"},
    repository({
      profiles: {
        "ada-lovelace": storedProfile(),
        "broken-profile": storedProfile({uid: "broken", updatedAt: "not a timestamp"}),
        "broken-marker": storedProfile({uid: "marked"}),
        "Bad Slug": storedProfile({uid: "slug"}),
      },
      discoveries: {
        "ada-lovelace": marker,
        "broken-profile": {...marker, uid: "broken"},
        "broken-marker": {uid: 42},
        "Bad Slug": {...marker, uid: "slug"},
      },
    }),
    shell,
  );

  assert.equal(result.status, 200);
  assert.match(result.body, /profiles\/ada-lovelace/);
  assert.doesNotMatch(result.body, /broken-profile|broken-marker|Bad Slug/);
});

test("a public profile that fails to decode is a memoised 404 on both routes, not a 500", async () => {
  const calls = {profile: 0};
  const broken = {
    getProfile: async () => {
      calls.profile += 1;
      return storedProfile({days: [{day: "2026-08-20", pagesRead: "junk"}]});
    },
    getDiscovery: async () => marker,
    listDiscoveries: async () => [],
  };
  const html = await resolvePublicWebRequest(
    {method: "GET", path: "/profiles/ada-lovelace"}, broken, shell,
  );
  assert.equal(html.status, 404);
  assert.equal(html.headers["Cache-Control"], "public, max-age=60, s-maxage=300");
  assert.match(html.body, /<!doctype html>/i);
  const json = await resolvePublicWebRequest(
    {method: "GET", path: "/profiles/ada-lovelace.json"}, broken, shell,
  );
  assert.equal(json.status, 404);
  assert.deepEqual(JSON.parse(json.body), {error: "not-found"});
  assert.equal(calls.profile, 2);

  // Through the cache the 404 is transient-pooled: a repeated hostile URL
  // costs no read and no budget after the first miss.
  const cache = createTtlCache({
    ttlMs: 60_000, staleTtlMs: 300_000, maxEntries: 2, maxTransientEntries: 2,
    maxMissesPerWindow: 3, windowMs: 60_000, retain: (r) => r.status === 200,
  });
  for (let i = 0; i < 10; i += 1) {
    const result = await cachedPublicWebResponse(
      {method: "GET", path: "/profiles/ada-lovelace.json"}, broken, shell, cache,
    );
    assert.equal(result.status, 404);
  }
  assert.equal(calls.profile, 3);
});

test("sitemap bounds its scan and reads profiles in batches, never all at once", async () => {
  let requestedLimit = null;
  let inflight = 0;
  let peak = 0;
  const count = SITEMAP_READ_CONCURRENCY * 3 + 7;
  const discoveries = Object.fromEntries(
    Array.from({length: count}, (_, i) => [`user-${String(i).padStart(4, "0")}`, {...marker, uid: `u${i}`}]),
  );
  const batched = {
    getProfile: async (username) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await new Promise((resolve) => setImmediate(resolve));
      inflight -= 1;
      return storedProfile({uid: `u${username.slice(5).replace(/^0+/, "") || "0"}`});
    },
    getDiscovery: async () => null,
    listDiscoveries: async (limit) => {
      requestedLimit = limit;
      return Object.entries(discoveries).slice(0, limit).map(([id, value]) => ({id, value}));
    },
  };
  const result = await resolvePublicWebRequest({method: "GET", path: "/sitemap.xml"}, batched, shell);
  assert.equal(result.status, 200);
  assert.equal(requestedLimit, SITEMAP_MAX_PROFILES);
  assert.equal(peak, SITEMAP_READ_CONCURRENCY);
  assert.equal((result.body.match(/<loc>/g) ?? []).length, count);
});

test("a pinned key survives a flood of retained 200s, stays fresh for its own ttl, and is served stale past the budget", async () => {
  let clock = 0;
  const loads = {s: 0, other: 0};
  const cache = createTtlCache({
    ttlMs: 60_000, staleTtlMs: 300_000, maxEntries: 2, maxTransientEntries: 2,
    maxMissesPerWindow: 500, windowMs: 60_000, retain: () => true,
    pin: (key) => key === "s", pinnedTtlMs: 300_000, now: () => clock,
  });
  const load = (key) => () => {
    if (key === "s") loads.s += 1; else loads.other += 1;
    return Promise.resolve(`${key}@${clock}`);
  };
  assert.equal(await cache.get("s", load("s")), "s@0");
  for (let i = 0; i < 100; i += 1) await cache.get(`p${i}`, load("p"));
  assert.equal(loads.other, 100);
  assert.equal(await cache.get("s", load("s")), "s@0");
  clock = 200_000;
  assert.equal(await cache.get("s", load("s")), "s@0");
  assert.equal(loads.s, 1);
  clock = 300_001;
  assert.equal(await cache.get("s", load("s")), "s@300001");
  assert.equal(loads.s, 2);
  // Budget exhausted in a later window: served stale within the allowance.
  clock = 660_000;
  for (let i = 0; i < 500; i += 1) await cache.get(`q${i}`, load("q"));
  assert.equal(cache.get("q-extra", load("q")), MISS_BUDGET_EXHAUSTED);
  assert.equal(await cache.get("s", load("s")), "s@300001");
  // Past the pinned allowance (300 s fresh + 240 s stale) in a window whose
  // budget is spent again, the pinned key is refused like any other.
  clock = 900_002;
  for (let i = 0; i < 500; i += 1) await cache.get(`r${i}`, load("r"));
  assert.equal(cache.get("s", load("s")), MISS_BUDGET_EXHAUSTED);
});

test("a public profile with a malformed discovery marker renders unlisted instead of failing", async () => {
  const result = await resolvePublicWebRequest(
    {method: "GET", path: "/profiles/ada-lovelace"},
    repository({profiles: {"ada-lovelace": storedProfile()}, discoveries: {"ada-lovelace": {uid: 42}}}),
    shell,
  );
  assert.equal(result.status, 200);
  assert.match(result.body, /name="robots" content="noindex/);
});

test("sitemap stops scanning past its time budget and serves what it has", async (t) => {
  let clock = 1_000_000;
  t.mock.method(Date, "now", () => clock);
  const count = SITEMAP_READ_CONCURRENCY * 4;
  const discoveries = Object.fromEntries(
    Array.from({length: count}, (_, i) => [`user-${String(i).padStart(4, "0")}`, {...marker, uid: `u${i}`}]),
  );
  let reads = 0;
  const slow = {
    getProfile: async (username) => {
      reads += 1;
      // Each batch of reads pushes the clock forward; the third batch crosses the budget.
      if (reads % SITEMAP_READ_CONCURRENCY === 0) clock += SITEMAP_SCAN_BUDGET_MS / 2 + 1;
      return storedProfile({uid: `u${username.slice(5).replace(/^0+/, "") || "0"}`});
    },
    getDiscovery: async () => null,
    listDiscoveries: async (limit) => Object.entries(discoveries).slice(0, limit).map(([id, value]) => ({id, value})),
  };
  const result = await resolvePublicWebRequest({method: "GET", path: "/sitemap.xml"}, slow, shell);
  assert.equal(result.status, 200);
  assert.equal(result.partial, true);
  assert.equal(reads, SITEMAP_READ_CONCURRENCY * 2);
  assert.equal((result.body.match(/<loc>/g) ?? []).length, SITEMAP_READ_CONCURRENCY * 2);
  // A cut-short sitemap is not pinned for the hour: through the cache the
  // next request past the short memo rescans.
  const cache = createTtlCache({
    ttlMs: 60_000, staleTtlMs: 300_000, maxEntries: 2, maxTransientEntries: 2,
    maxMissesPerWindow: 10, windowMs: 60_000,
    retain: (r) => r.status === 200 && r.partial !== true,
    pin: (key) => key === "/sitemap.xml", pinnedTtlMs: 3_600_000, now: () => clock,
  });
  await cachedPublicWebResponse({method: "GET", path: "/sitemap.xml"}, slow, shell, cache);
  const readsAfterFirst = reads;
  clock += 61_000;
  await cachedPublicWebResponse({method: "GET", path: "/sitemap.xml"}, slow, shell, cache);
  assert.ok(reads > readsAfterFirst);
  const complete = await resolvePublicWebRequest(
    {method: "GET", path: "/sitemap.xml"}, repository({profiles: {"ada-lovelace": storedProfile()}, discoveries: {"ada-lovelace": marker}}), shell,
  );
  assert.equal(complete.partial, undefined);
});

test("profile JSON is never indexable and rejects a fractional year like the client does", async () => {
  const ok = await resolvePublicWebRequest(
    {method: "GET", path: "/profiles/ada-lovelace.json"},
    repository({profiles: {"ada-lovelace": storedProfile()}, discoveries: {"ada-lovelace": marker}}),
    shell,
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.headers["X-Robots-Tag"], "noindex");
  const missing = await resolvePublicWebRequest(
    {method: "GET", path: "/profiles/nobody.json"}, repository(), shell,
  );
  assert.equal(missing.headers["X-Robots-Tag"], "noindex");
  // Decoder parity with src/lib/firebase/decoders.ts: a value the client
  // rejects must not be served as a 200, or every signed-in viewer's
  // browser reports the stranger's defect as its own.
  const fractional = await resolvePublicWebRequest(
    {method: "GET", path: "/profiles/ada-lovelace.json"},
    repository({profiles: {"ada-lovelace": storedProfile({years: [{year: 2024.5, count: 1, hours: 1, pages: 1}]})}}),
    shell,
  );
  assert.equal(fractional.status, 404);
});

test("sitemap renderer is deterministic and XML-safe", () => {
  const sitemap = renderSitemap([
    {username: "z-reader", updatedAt: new Date("2026-08-25T00:00:00.000Z")},
    {username: "a-reader", updatedAt: new Date("2026-08-24T00:00:00.000Z")},
  ]);
  assert.ok(sitemap.indexOf("a-reader") < sitemap.indexOf("z-reader"));
  assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
});
