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
const {resolvePublicWebRequest} = require("../lib/publicWeb");

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

test("sitemap renderer is deterministic and XML-safe", () => {
  const sitemap = renderSitemap([
    {username: "z-reader", updatedAt: new Date("2026-08-25T00:00:00.000Z")},
    {username: "a-reader", updatedAt: new Date("2026-08-24T00:00:00.000Z")},
  ]);
  assert.ok(sitemap.indexOf("a-reader") < sitemap.indexOf("z-reader"));
  assert.match(sitemap, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
});
