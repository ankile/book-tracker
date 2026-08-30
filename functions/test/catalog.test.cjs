require("./setup.cjs");

const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const test = require("node:test");
const {FieldPath, getFirestore, Timestamp} = require("firebase-admin/firestore");
const {logger} = require("firebase-functions");

const deployed = require("../lib");
const catalog = require("../lib/catalog");
const {sharedWorkOwnerId} = require("../lib/catalogProjection");
const db = getFirestore();
const authContext = {auth: {uid: "owner", token: {email_verified: true}}};
const liveUserCollection = () => ({
  doc: () => ({get: async () => ({exists: true, get: () => undefined})}),
});
const activeAuthor = (canonicalName) => ({
  canonicalName,
  alternateNames: [],
  nameKeys: [canonicalName.toLowerCase()],
  sortName: canonicalName,
  kind: "person",
  status: "active",
  mergedFrom: [],
});

test("the Functions title normalizer agrees with the shared client fixture", () => {
  const fixtures = JSON.parse(readFileSync(join(
    __dirname,
    "..",
    "..",
    "test-fixtures",
    "catalog-normalization.json",
  ), "utf8"));
  for (const fixture of fixtures) {
    assert.equal(catalog.normalizeCatalogTitle(fixture.input), fixture.output);
  }
});

test("reading summaries use the reader timezone and the 3 AM boundary", () => {
  const event = (type, createdAt, pagesRead, timeRead = 0) => ({
    type,
    createdAt: Timestamp.fromDate(new Date(createdAt)),
    pagesRead,
    timeRead,
  });
  const result = catalog.summarizeReadingAttempt(
    {finished: true, pageCount: 300, editionId: "edition"},
    [
      event("update", "2024-03-10T09:30:00.000Z", 0),
      event("reading", "2024-03-10T10:30:00.000Z", 30, 30),
      event("reading", "2024-03-10T22:00:00.000Z", 45, 30),
      event("update", "2024-03-11T08:30:00.000Z", 0),
    ],
    "America/Los_Angeles",
  );
  assert.deepEqual(result, {
    status: "finished",
    pageCount: 300,
    firstProgressAt: "2024-03-09",
    firstReadAt: "2024-03-10",
    finishedAt: "2024-03-10",
    calendarDays: 2,
    activeDays: 1,
    trackedMinutes: 60,
    sessionCount: 2,
    qualifiedPagesPerHour: 75,
    percentPerHour: 25,
    trackingCoverage: 0.25,
  });
});

test("reading summary dates preserve four-digit years below 1000", () => {
  const event = (createdAt, pagesRead) => ({
    type: "reading",
    createdAt: Timestamp.fromDate(new Date(createdAt)),
    pagesRead,
    timeRead: 60,
  });
  const result = catalog.summarizeReadingAttempt(
    {finished: true, pageCount: 100, editionId: null},
    [event("0001-01-01T04:00:00.000Z", 50), event("0001-01-02T04:00:00.000Z", 50)],
    "UTC",
  );
  assert.equal(result.firstReadAt, "0001-01-01");
  assert.equal(result.finishedAt, "0001-01-02");
  assert.equal(result.calendarDays, 2);
});

test("an oversized first attempt does not crowd out the next owner", async () => {
  let queries = 0;
  const books = Array.from({length: 2}, (_, index) => ({
    snapshot: {
      ref: {
        path: `users/reader-${index}/books/book-${index}`,
        collection: () => ({limit: (limit) => ({get: async () => {
          queries += 1;
          assert.equal(limit, 201);
          if (index === 0) return {size: limit, docs: Array(limit).fill({})};
          const update = {
            get: (field) => ({
              type: "reading",
              createdAt: Timestamp.fromDate(new Date("2026-08-20T18:00:00.000Z")),
              pagesRead: 50,
              timeRead: 60,
              owner: {path: `users/reader-${index}`},
              book: {path: `users/reader-${index}/books/book-${index}`},
            })[field],
          };
          return {size: 1, docs: [update]};
        }})}),
      },
    },
    identity: {uid: `reader-${index}`, finished: true, pageCount: 300, editionId: null},
    shared: {
      username: `reader-${index}`,
      displayName: `Reader ${index}`,
      timeZone: "UTC",
    },
  }));
  const result = await catalog.summarizeReaderBooks(books, "work");
  assert.equal(queries, 2);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].username, "reader-1");
  assert.equal(result.incomplete, true);
  assert.equal(result.omittedAttempts, 1);
});

test("a full ten-owner page with maximum valid histories fits the read budget", async () => {
  const books = Array.from({length: 50}, (_, index) => ({
    snapshot: {
      ref: {
        path: `users/reader-${Math.floor(index / 5)}/books/book-${index}`,
        collection: () => ({limit: (limit) => ({get: async () => {
          assert.equal(limit, 201);
          const update = {
            get: (field) => ({
              type: "reading",
              createdAt: Timestamp.fromDate(new Date("2026-08-20T18:00:00.000Z")),
              pagesRead: 1,
              timeRead: 5,
              owner: {path: `users/reader-${Math.floor(index / 5)}`},
              book: {path: `users/reader-${Math.floor(index / 5)}/books/book-${index}`},
            })[field],
          };
          return {size: 200, docs: Array(200).fill(update)};
        }})}),
      },
    },
    identity: {
      uid: `reader-${Math.floor(index / 5)}`,
      finished: true,
      pageCount: 300,
      editionId: null,
    },
    shared: {
      username: `reader-${String(Math.floor(index / 5)).padStart(2, "0")}`,
      displayName: `Reader ${Math.floor(index / 5)}`,
      timeZone: "UTC",
    },
  }));
  const result = await catalog.summarizeReaderBooks(books, "work");
  assert.equal(result.attempts.length, 50);
  assert.equal(result.incomplete, false);
  assert.equal(result.omittedAttempts, 0);
});

test("catalog callables reject anonymous and malformed requests before Firestore", async (t) => {
  let touched = false;
  t.mock.method(db, "doc", () => {
    touched = true;
    return {};
  });
  await assert.rejects(
    deployed.catalog.search.run({title: "Book"}, {auth: undefined}),
    (error) => error.code === "unauthenticated",
  );
  await assert.rejects(
    deployed.catalog.ensureauthors.run({authors: [{
      canonicalName: "Author", sortName: "Author", kind: "person",
    }]}, {auth: undefined}),
    (error) => error.code === "unauthenticated",
  );
  await assert.rejects(
    deployed.catalog.search.run({title: "Book", uid: "other"}, authContext),
    (error) => error.code === "invalid-argument",
  );
  await assert.rejects(
    deployed.catalog.workreaders.run({workId: "work/other"}, authContext),
    (error) => error.code === "invalid-argument",
  );
  assert.equal(touched, false);
});

test("catalog search has a separate bounded hourly quota", async (t) => {
  const quotaRef = {path: "users/owner/functionQuotas/catalogSearch"};
  const quota = {windowStartedAt: Timestamp.now(), count: 60};
  t.mock.method(db, "doc", (path) => {
    assert.equal(path, quotaRef.path);
    return quotaRef;
  });
  t.mock.method(db, "collection", (name) => {
    assert.equal(name, "users");
    return liveUserCollection();
  });
  t.mock.method(db, "runTransaction", async (handler) => handler({
    get: async () => ({data: () => quota}),
    update: () => undefined,
  }));
  await assert.rejects(
    deployed.catalog.search.run({title: "Book", authorNames: ["Author"]}, authContext),
    (error) => error.code === "resource-exhausted",
  );
});

test("title search has a global hourly spend breaker", async (t) => {
  const paths = [];
  t.mock.method(db, "doc", (path) => ({path}));
  t.mock.method(db, "collection", (name) => {
    assert.equal(name, "users");
    return liveUserCollection();
  });
  t.mock.method(db, "runTransaction", async (handler) => handler({
    get: async (reference) => {
      paths.push(reference.path);
      return {
        data: () => reference.path === "functionGlobalQuotas/catalogSearch" ? {
          windowStartedAt: Timestamp.now(), count: 100,
        } : undefined,
      };
    },
    set: () => undefined,
    update: () => undefined,
  }));
  await assert.rejects(
    deployed.catalog.search.run({title: "Book", authorNames: ["Author"]}, authContext),
    (error) => error.code === "resource-exhausted",
  );
  assert.deepEqual(paths, [
    "users/owner/functionQuotas/catalogSearch",
    "functionGlobalQuotas/catalogSearch",
  ]);
});

test("catalog callables reject deleted accounts before quotas or catalog reads", async (t) => {
  let catalogTouched = false;
  t.mock.method(db, "collection", (name) => {
    if (name === "users") {
      return {doc: () => ({get: async () => ({exists: true, get: () => Timestamp.now()})})};
    }
    catalogTouched = true;
    return {};
  });
  await assert.rejects(
    deployed.catalog.ensureauthors.run({authors: [{
      canonicalName: "Author", sortName: "Author", kind: "person",
    }]}, authContext),
    (error) => error.code === "failed-precondition",
  );
  await assert.rejects(
    deployed.catalog.search.run({title: "Book", authorNames: ["Author"]}, authContext),
    (error) => error.code === "failed-precondition",
  );
  await assert.rejects(
    deployed.catalog.workreaders.run({workId: "work"}, authContext),
    (error) => error.code === "failed-precondition",
  );
  assert.equal(catalogTouched, false);
});

test("ordinary users resolve existing shared authors and create only missing catalog rows", async (t) => {
  const rows = new Map([["catalogAuthors/le-guin", {
    ...activeAuthor("Ursula K. Le Guin"), nameKeys: ["ursula k le guin"],
  }]]);
  const ref = (path) => ({path, id: path.slice(path.lastIndexOf("/") + 1)});
  const snap = (reference) => ({
    exists: rows.has(reference.path), id: reference.id, ref: reference,
    data: () => rows.get(reference.path),
    get: (field) => rows.get(reference.path)?.[field],
  });
  let transactionCount = 0;
  const quotaWrites = [];
  t.mock.method(db, "doc", (path) => ref(path));
  t.mock.method(db, "collection", (name) => {
    if (name === "users") {
      return {doc: () => ({get: async () => ({exists: true, get: () => undefined})})};
    }
    assert.equal(name, "catalogAuthors");
    const query = {
      where: (field, operator, keys) => {
        assert.deepEqual([field, operator], ["nameKeys", "array-contains-any"]);
        query.keys = keys;
        return query;
      },
      limit: () => {
        query.capacity = true;
        return query;
      },
      doc: (id) => ref(`catalogAuthors/${id}`),
    };
    return query;
  });
  t.mock.method(db, "runTransaction", async (handler) => {
    transactionCount += 1;
    if (transactionCount === 1) {
      return handler({
        get: async () => ({data: () => undefined}),
        set: (reference, data) => quotaWrites.push({path: reference.path, data}),
      });
    }
    return handler({
      get: async (value) => {
        if (value.keys !== undefined) {
          return {
            docs: [...rows.keys()].map((path) => snap(ref(path))).filter((snapshot) =>
              snapshot.data().nameKeys.some((key) => value.keys.includes(key)),
            ),
          };
        }
        if (value.capacity === true) return {size: rows.size};
        return snap(value);
      },
      getAll: async (...references) => references.map(snap),
      set: (reference, data) => quotaWrites.push({path: reference.path, data}),
      update: (reference, data) => quotaWrites.push({path: reference.path, data}),
      create: (reference, data) => {
        assert.equal(rows.has(reference.path), false);
        rows.set(reference.path, data);
      },
    });
  });
  const result = await deployed.catalog.ensureauthors.run({authors: [
    {canonicalName: "Ursula K. Le Guin", sortName: "Le Guin", kind: "person"},
    {canonicalName: "Octavia E. Butler", sortName: "Butler", kind: "person"},
  ]}, authContext);
  assert.equal(result.authorIds[0], "le-guin");
  assert.match(result.authorIds[1], /^author_[a-f0-9]{24}$/);
  const created = rows.get(`catalogAuthors/${result.authorIds[1]}`);
  assert.equal(created.canonicalName, "Octavia E. Butler");
  assert.deepEqual(created.nameKeys, ["octavia e butler"]);
  assert.equal(created.status, "active");
  assert.deepEqual(quotaWrites.map(({path, data}) => ({path, count: data.count})), [
    {path: "users/owner/functionQuotas/catalogEnsureAuthors", count: 2},
    {path: "functionGlobalQuotas/catalogEnsureAuthors", count: 1},
  ]);

  await assert.rejects(
    deployed.catalog.ensureauthors.run({authors: [{
      canonicalName: "Ursula K. Le Guin", sortName: "Le Guin", kind: "entity",
    }]}, authContext),
    (error) => error.code === "failed-precondition" && /different type/.test(error.message),
  );

  rows.set("catalogAuthors/le-guin", {
    ...rows.get("catalogAuthors/le-guin"),
    nameKeys: ["canonical target"],
  });
  rows.set("catalogAuthors/legacy-le-guin", {
    ...activeAuthor("Ursula K. Le Guin"),
    nameKeys: ["ursula k le guin"],
    kind: "entity",
    status: "merged",
    mergedInto: "le-guin",
  });
  await assert.rejects(
    deployed.catalog.ensureauthors.run({authors: [{
      canonicalName: "Ursula K. Le Guin", sortName: "Le Guin", kind: "entity",
    }]}, authContext),
    (error) => error.code === "failed-precondition" && /different type/.test(error.message),
  );
});

function installMissingAuthorBoundaryStore(t, {catalogSize, globalCount}) {
  const ref = (path) => ({path, id: path.slice(path.lastIndexOf("/") + 1)});
  const snapshot = (reference, data) => ({
    exists: data !== undefined,
    id: reference.id,
    ref: reference,
    data: () => data,
    get: (field) => data?.[field],
  });
  let transactions = 0;
  t.mock.method(db, "doc", ref);
  t.mock.method(db, "collection", (name) => {
    if (name === "users") {
      return {doc: () => ({get: async () => ({exists: true, get: () => undefined})})};
    }
    assert.equal(name, "catalogAuthors");
    return {
      where: () => ({kind: "matching"}),
      limit: () => ({kind: "capacity"}),
      doc: (id) => ref(`catalogAuthors/${id ?? "auto"}`),
    };
  });
  t.mock.method(db, "runTransaction", async (handler) => {
    transactions += 1;
    if (transactions === 1) {
      return handler({
        get: async () => ({data: () => undefined}),
        set: () => undefined,
      });
    }
    return handler({
      get: async (value) => {
        if (value.kind === "matching") return {docs: []};
        if (value.kind === "capacity") return {size: catalogSize};
        assert.equal(value.path, "functionGlobalQuotas/catalogEnsureAuthors");
        return snapshot(value, globalCount === null ? undefined : {
          windowStartedAt: Timestamp.now(), count: globalCount,
        });
      },
      getAll: async (...references) => references.map((reference) => snapshot(reference, undefined)),
      set: () => undefined,
      update: () => undefined,
      create: () => undefined,
    });
  });
}

test("shared author creation refuses the hard catalog capacity", async (t) => {
  installMissingAuthorBoundaryStore(t, {catalogSize: 500, globalCount: 0});
  await assert.rejects(
    deployed.catalog.ensureauthors.run({authors: [{
      canonicalName: "New Author", sortName: "Author", kind: "person",
    }]}, authContext),
    (error) => error.code === "resource-exhausted" && /catalog is full/.test(error.message),
  );
});

test("shared author creation refuses the global missing-name breaker", async (t) => {
  installMissingAuthorBoundaryStore(t, {catalogSize: 0, globalCount: 500});
  await assert.rejects(
    deployed.catalog.ensureauthors.run({authors: [{
      canonicalName: "New Author", sortName: "Author", kind: "person",
    }]}, authContext),
    (error) => error.code === "resource-exhausted" && /temporarily busy/.test(error.message),
  );
});

test("an exact title with the wrong author is not returned", async (t) => {
  const whereCalls = [];
  let authorReads = 0;
  const work = {
    canonicalTitle: "The Shared Title",
    alternateTitles: [],
    titleKeys: ["shared title"],
    authorIds: ["correct-author"],
    coverUrl: "",
    subjects: [],
    fiction: null,
    visibility: "searchable",
    status: "active",
    mergedFrom: [],
  };
  const snap = (path, data) => ({
    exists: data !== undefined,
    id: path.slice(path.lastIndexOf("/") + 1),
    ref: {path},
    data: () => data,
    get: (field) => data?.[field],
  });
  t.mock.method(db, "doc", () => ({path: "users/owner/functionQuotas/catalogSearch"}));
  t.mock.method(db, "runTransaction", async (handler) => handler({
    get: async () => ({data: () => undefined}),
    set: () => undefined,
  }));
  t.mock.method(db, "collection", (name) => {
    if (name === "users") return liveUserCollection();
    if (name === "workTitleIndex") {
      const query = {
        where: (...args) => {
          whereCalls.push(args);
          return query;
        },
        orderBy: () => query,
        limit: () => query,
        get: async () => ({docs: [snap("workTitleIndex/index", {
          workId: "work", visibility: "searchable",
        })]}),
      };
      return query;
    }
    if (name === "works") {
      return {doc: (id) => ({get: async () => snap(`works/${id}`, work)})};
    }
    if (name === "catalogAuthors") {
      return {doc: (id) => ({get: async () => {
        authorReads += 1;
        return snap(`catalogAuthors/${id}`, activeAuthor("Correct Author"));
      }})};
    }
    assert.fail(`unexpected collection ${name}`);
  });
  assert.deepEqual(await deployed.catalog.search.run({
    title: "The Shared Title",
    authorNames: ["Wrong Author"],
  }, authContext), {results: []});
  const exactWork = await deployed.catalog.search.run({
    title: "The Shared Title",
    authorNames: ["Correct Author"],
  }, authContext);
  assert.equal(exactWork.results[0].workId, "work");
  assert.equal(exactWork.results[0].editionId, null);
  assert.equal(exactWork.results[0].edition, null);
  assert.deepEqual(whereCalls[0], ["visibility", "==", "searchable"]);
  assert.equal(authorReads, 2);
});

test("ordinary catalog creation is not deployed", async (t) => {
  assert.equal(deployed.catalog.create, undefined);
  const references = new Map();
  const ref = (path) => {
    if (!references.has(path)) {
      references.set(path, {path, id: path.slice(path.lastIndexOf("/") + 1)});
    }
    return references.get(path);
  };
  const rows = new Map([
    ["isbnIndex/9780000000002", {workId: "internal-work", editionId: "internal-edition"}],
    ["works/internal-work", {
      canonicalTitle: "Private source title",
      alternateTitles: [],
      titleKeys: ["private source title"],
      authorIds: ["private-author"],
      coverUrl: "",
      subjects: [],
      fiction: null,
      visibility: "internal",
      status: "active",
      mergedFrom: [],
    }],
    ["editions/internal-edition", {
      workId: "internal-work",
      isbn13: "9780000000002",
      title: "Private source title",
      publisher: "",
      publishedDate: "",
      language: "",
      translatorNames: [],
      format: "unknown",
      suggestedPageCount: null,
      coverUrl: "",
      externalIds: {},
    }],
    ["catalogAuthors/private-author", activeAuthor("Private Author")],
  ]);
  const snapshot = (reference) => ({
    exists: rows.has(reference.path),
    id: reference.id,
    ref: reference,
    data: () => rows.get(reference.path),
    get: (field) => rows.get(reference.path)?.[field],
  });
  t.mock.method(db, "doc", (path) => ref(path));
  t.mock.method(db, "collection", (name) => ({
    doc: (id) => ref(`${name}/${id}`),
  }));
  t.mock.method(db, "runTransaction", async (handler) => handler({
    get: async (reference) => snapshot(reference),
    set: (reference, value) => rows.set(reference.path, value),
    update: (reference, value) => rows.set(reference.path, {
      ...rows.get(reference.path),
      ...value,
    }),
    create: () => assert.fail("collision must not create a catalog row"),
  }));
  const request = {
    confirmSearchable: true,
    promoteInternalCollision: false,
    work: {
      canonicalTitle: "Caller title",
      alternateTitles: [],
      authorIds: ["private-author"],
      coverUrl: "",
      subjects: [],
      fiction: null,
    },
    edition: {
      isbn13: "9780000000002",
      title: "Caller title",
      publisher: "",
      publishedDate: "",
      language: "",
      translatorNames: [],
      format: "unknown",
      suggestedPageCount: null,
      coverUrl: "",
      externalIds: {},
    },
  };
  assert.deepEqual(await catalog.createCatalogEntry(request), {
    status: "confirmation-required",
    reason: "identifier-unavailable",
  });
  assert.deepEqual(
    await catalog.createCatalogEntry({
      ...request,
      promoteInternalCollision: true,
    }),
    {status: "confirmation-required", reason: "identifier-unavailable"},
  );
  assert.equal(rows.get("works/internal-work").visibility, "internal");
});

test("ordinary users cannot reserve catalog external IDs", async (t) => {
  assert.equal(deployed.catalog.create, undefined);
  const references = new Map();
  const rows = new Map();
  rows.set("catalogAuthors/ada-lovelace", activeAuthor("Ada Lovelace"));
  const ref = (path) => {
    if (!references.has(path)) {
      references.set(path, {path, id: path.slice(path.lastIndexOf("/") + 1)});
    }
    return references.get(path);
  };
  const snapshot = (reference) => ({
    exists: rows.has(reference.path),
    id: reference.id,
    ref: reference,
    data: () => rows.get(reference.path),
    get: (field) => rows.get(reference.path)?.[field],
  });
  t.mock.method(db, "doc", (path) => ref(path));
  t.mock.method(db, "collection", (name) => ({
    doc: (id) => ref(`${name}/${id}`),
  }));
  t.mock.method(db, "runTransaction", async (handler) => handler({
    get: async (reference) => snapshot(reference),
    set: (reference, value) => rows.set(reference.path, value),
    update: (reference, value) => rows.set(reference.path, {
      ...rows.get(reference.path),
      ...value,
    }),
    create: (reference, value) => {
      assert.equal(rows.has(reference.path), false);
      rows.set(reference.path, value);
    },
  }));
  const result = await catalog.createCatalogEntry({
    confirmSearchable: true,
    promoteInternalCollision: false,
    work: {
      canonicalTitle: "The Book",
      alternateTitles: [],
      authorIds: ["ada-lovelace"],
      coverUrl: "",
      subjects: [],
      fiction: true,
    },
    edition: {
      isbn13: null,
      title: "The Book",
      publisher: "",
      publishedDate: "",
      language: "en",
      translatorNames: [],
      format: "full",
      suggestedPageCount: 320,
      coverUrl: "",
      externalIds: {"google-books": "volume-123"},
    },
  });
  assert.equal(result.status, "ready");
  assert.equal(result.created, true);
  assert.equal(result.promoted, false);
  const externalRows = [...rows.entries()].filter(([path]) =>
    path.startsWith("externalIdIndex/"),
  );
  assert.deepEqual(externalRows.map(([, value]) => ({
    workId: value.workId,
    editionId: value.editionId,
    provider: value.provider,
    externalId: value.externalId,
  })), [{
    workId: result.workId,
    editionId: result.editionId,
    provider: "google-books",
    externalId: "volume-123",
  }]);
});

test("work readers resolve aliases and return only consented redacted summaries", async (t) => {
  const sharedOwner = db.collection("users").doc("shared-reader");
  const workData = {
    canonicalTitle: "The Book",
    alternateTitles: [],
    titleKeys: ["book"],
    authorIds: ["ada-lovelace"],
    coverUrl: "https://example.test/work.jpg",
    subjects: ["Private implementation detail"],
    fiction: true,
    visibility: "searchable",
    status: "active",
    mergedFrom: ["old-work"],
  };
  const editionData = {
    workId: "canonical-work",
    isbn13: "9780000000002",
    title: "The Book",
    publisher: "Publisher",
    publishedDate: "2026",
    language: "en",
    translatorNames: [],
    format: "full",
    suggestedPageCount: 300,
    coverUrl: "https://example.test/edition.jpg",
    externalIds: {"google-books": "must-not-be-returned"},
  };
  const snap = (path, data, extra = {}) => ({
    exists: data !== undefined,
    id: path.slice(path.lastIndexOf("/") + 1),
    ref: {path},
    data: () => data,
    get: (field) => data?.[field],
    ...extra,
  });
  const updates = snap("users/shared-reader/books/reread/updates/session", {
    type: "reading",
    createdAt: Timestamp.fromDate(new Date("2026-08-20T18:00:00.000Z")),
    pagesRead: 100,
    timeRead: 60,
    owner: sharedOwner,
    book: {path: "users/shared-reader/books/reread"},
    privateNote: "must not be returned",
  });
  const bookSnap = (uid, owner, id) => snap(`users/${uid}/books/${id}`, {
    owner,
    finished: true,
    pageCount: 300,
    editionId: "edition-one",
    email: `${uid}@example.test`,
  }, {
    ref: {
      path: `users/${uid}/books/${id}`,
      collection: (name) => {
        assert.equal(name, "updates");
        return {limit: (limit) => {
          assert.equal(limit, 201);
          return {get: async () => ({
            docs: uid === "shared-reader" ? [updates] : [],
            size: uid === "shared-reader" ? 1 : 0,
          })};
        }};
      },
    },
  });
  const books = [bookSnap("shared-reader", sharedOwner, "reread")];
  const quotaRef = {path: "users/owner/functionQuotas/workReaders"};
  const settings = {
    "users/shared-reader/settings/bookSharing": {
      profileUsername: "ada-reader",
      timeZone: "America/Los_Angeles",
    },
  };
  let projectionOverflow = false;
  let malformedProjection = false;
  let malformedBook = false;
  t.mock.method(db, "doc", (path) => {
    if (path === quotaRef.path) return quotaRef;
    return {
      path,
      get: async () => snap(path, settings[path]),
    };
  });
  t.mock.method(db, "runTransaction", async (handler) => handler({
    get: async () => ({data: () => undefined}),
    set: () => undefined,
  }));
  t.mock.method(db, "collection", (name) => {
    if (name === "sharedWorkOwners") return {
      where: (field, operator, values) => {
        assert.deepEqual([field, operator, values], [
          "workId", "in", ["canonical-work", "old-work"],
        ]);
        let cursor = null;
        const query = {
          orderBy: (field) => {
            assert.deepEqual(field, FieldPath.documentId());
            return query;
          },
          startAfter: (value) => {
            cursor = value;
            return query;
          },
          limit: (limit) => {
            assert.equal(limit, 11);
          const id = sharedWorkOwnerId("canonical-work", "shared-reader");
          const stale = Array.from({length: projectionOverflow ? 10 : 0}, (_, index) => {
            const uid = `revoked-reader-${String(index).padStart(2, "0")}`;
            const staleId = sharedWorkOwnerId("canonical-work", uid);
            return snap(`sharedWorkOwners/${staleId}`, {
              workId: "canonical-work",
              uid,
            });
          });
          const malformed = malformedProjection ? [snap(
            "sharedWorkOwners/not-the-required-hash",
            {workId: "canonical-work", uid: "bad/uid"},
          )] : [];
            const valid = snap(`sharedWorkOwners/${id}`, {
              workId: "canonical-work",
              uid: "shared-reader",
            });
            const all = projectionOverflow
              ? [...stale, valid, ...malformed]
              : [valid, ...malformed];
            const start = cursor === null ? 0 : all.findIndex((row) => row.id === cursor) + 1;
            const docs = all.slice(start, start + limit);
            return {get: async () => ({docs, size: docs.length})};
          },
        };
        return query;
      },
    };
    if (name === "works") return {doc: (id) => ({
      path: `works/${id}`,
      get: async () => snap(`works/${id}`,
        id === "canonical-work" ? workData :
          id === "internal-work" ? {...workData, visibility: "internal"} :
            id === "broken-work" ? {
              ...workData,
              status: "merged",
              mergedInto: "missing-target",
              mergedFrom: [],
            } : undefined),
    })};
    if (name === "catalogAuthors") return {doc: (id) => ({
      get: async () => snap(
        `catalogAuthors/${id}`,
        id === "ada-lovelace" ? activeAuthor("Ada Lovelace") : undefined,
      ),
    })};
    if (name === "editions") return {
      where: (field, operator, value) => {
        assert.deepEqual([field, operator, value], ["workId", "==", "canonical-work"]);
        return {limit: (limit) => {
          assert.equal(limit, 101);
          return {get: async () => ({
            docs: [snap("editions/edition-one", editionData)],
            size: 1,
          })};
        }};
      },
    };
    if (name === "users") return {doc: (uid) => ({
      get: async () => snap(`users/${uid}`, {uid}),
    })};
    if (name === "profiles") return {doc: (username) => ({
      get: async () => snap(`profiles/${username}`, username === "ada-reader" ? {
        uid: "shared-reader",
        public: true,
        givenName: "Ada",
        familyName: "Reader",
        email: "must-not-be-returned@example.test",
      } : undefined),
    })};
    if (name === "users/shared-reader/books") {
      return {where: (field, operator, values) => {
        assert.deepEqual([field, operator, values], [
          "workId", "in", ["canonical-work", "old-work"],
        ]);
        return {orderBy: () => ({limit: (limit) => {
          assert.equal(limit, 6);
          const visibleBooks = malformedBook ? [
            ...books,
            bookSnap("shared-reader", {path: "users/other"}, "invalid-owner"),
          ] : books;
          return {get: async () => ({docs: visibleBooks, size: visibleBooks.length})};
        }})};
      }};
    }
    assert.fail(`unexpected collection ${name}`);
  });
  const logs = [];
  const warnings = [];
  t.mock.method(logger, "info", (...args) => logs.push(args));
  t.mock.method(logger, "warn", (...args) => warnings.push(args));
  const result = await deployed.catalog.workreaders.run(
    {workId: "canonical-work"},
    authContext,
  );
  assert.deepEqual(result.work, {
    workId: "canonical-work",
    canonicalTitle: "The Book",
    alternateTitles: [],
    authors: [{
      authorId: "ada-lovelace",
      canonicalName: "Ada Lovelace",
      sortName: "Ada Lovelace",
      kind: "person",
    }],
    coverUrl: "https://example.test/work.jpg",
    subjects: ["Private implementation detail"],
    fiction: true,
    mergedFrom: ["old-work"],
  });
  assert.deepEqual(Object.keys(result.editions[0]).sort(), [
    "coverUrl", "editionId", "format", "isbn13", "language",
    "publishedDate", "publisher", "suggestedPageCount", "title",
    "translatorNames", "workId",
  ]);
  assert.deepEqual(result.attempts, [{
    username: "ada-reader",
    displayName: "Ada Reader",
    editionIsbn13: null,
    status: "finished",
    pageCount: 300,
    firstProgressAt: "2026-08-20",
    firstReadAt: "2026-08-20",
    finishedAt: "2026-08-20",
    calendarDays: 1,
    activeDays: 1,
    trackedMinutes: 60,
    sessionCount: 1,
    qualifiedPagesPerHour: 100,
    percentPerHour: (100 / 300) * 100,
    trackingCoverage: 1 / 3,
  }]);
  assert.equal(result.incomplete, false);
  assert.equal(result.omittedAttempts, 0);
  assert.equal(result.nextCursor, null);
  projectionOverflow = true;
  const overflow = await deployed.catalog.workreaders.run(
    {workId: "canonical-work"},
    authContext,
  );
  assert.equal(overflow.incomplete, false);
  assert.equal(overflow.omittedAttempts, 0);
  assert.equal(overflow.attempts.length, 0);
  assert.equal(typeof overflow.nextCursor, "string");
  const overflowNext = await deployed.catalog.workreaders.run(
    {workId: "canonical-work", cursor: overflow.nextCursor},
    authContext,
  );
  assert.equal(overflowNext.nextCursor, null);
  assert.equal(overflowNext.attempts.length, 1);
  projectionOverflow = false;
  malformedProjection = true;
  const malformedProjectionResult = await deployed.catalog.workreaders.run(
    {workId: "canonical-work"}, authContext,
  );
  assert.equal(malformedProjectionResult.incomplete, true);
  assert.equal(malformedProjectionResult.omittedAttempts, 0);
  malformedProjection = false;
  malformedBook = true;
  const malformedBookResult = await deployed.catalog.workreaders.run(
    {workId: "canonical-work"}, authContext,
  );
  assert.equal(malformedBookResult.incomplete, true);
  assert.equal(malformedBookResult.omittedAttempts, 1);
  malformedBook = false;
  updates.data().book = {path: "users/shared-reader/books/a-different-book"};
  const malformedUpdateResult = await deployed.catalog.workreaders.run(
    {workId: "canonical-work"}, authContext,
  );
  assert.equal(malformedUpdateResult.attempts.length, 0);
  assert.equal(malformedUpdateResult.incomplete, true);
  assert.equal(malformedUpdateResult.omittedAttempts, 1);
  assert.equal(JSON.stringify(result).includes("shared-reader"), false);
  assert.equal(JSON.stringify(result).includes("private-reader"), false);
  assert.equal(JSON.stringify(result).includes("must-not-be-returned"), false);
  const readerLog = logs.find(([message]) => message === "catalog.work_readers");
  assert.ok(readerLog);
  assert.deepEqual(readerLog[1], {
    workId: "canonical-work",
    personalBooks: 1,
    optedInRows: 1,
    readers: 1,
    durationMs: readerLog[1].durationMs,
    aliasesQueried: true,
  });
  for (const hiddenId of ["missing-work", "internal-work", "broken-work"]) {
    await assert.rejects(
      deployed.catalog.workreaders.run({workId: hiddenId}, authContext),
      (error) => error.code === "not-found" && error.message === "Book not found.",
    );
  }
  assert.equal(warnings.filter(([message]) =>
    message === "catalog.work_readers.invalid_work").length, 2);
});
