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
  t.mock.method(db, "runTransaction", async (handler) => handler({
    get: async () => ({data: () => quota}),
    update: () => undefined,
  }));
  await assert.rejects(
    deployed.catalog.search.run({title: "Book", authorNames: ["Author"]}, authContext),
    (error) => error.code === "resource-exhausted",
  );
});

test("an exact title with the wrong author is not returned", async (t) => {
  const whereCalls = [];
  const work = {
    canonicalTitle: "The Shared Title",
    alternateTitles: [],
    titleKeys: ["shared title"],
    authorNames: ["Correct Author"],
    authorNamesLower: ["correct author"],
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
    assert.fail(`unexpected collection ${name}`);
  });
  assert.deepEqual(await deployed.catalog.search.run({
    title: "The Shared Title",
    authorNames: ["Wrong Author"],
  }, authContext), {results: []});
  assert.deepEqual(whereCalls[0], ["visibility", "==", "searchable"]);
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
      authorNames: ["Private Author"],
      authorNamesLower: ["private author"],
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
      authorNames: ["Private Author"],
      publisher: "",
      publishedDate: "",
      language: "",
      translatorNames: [],
      format: "unknown",
      suggestedPageCount: null,
      coverUrl: "",
      externalIds: {},
    }],
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
      authorNames: ["Caller Author"],
      coverUrl: "",
      subjects: [],
      fiction: null,
    },
    edition: {
      isbn13: "9780000000002",
      title: "Caller title",
      authorNames: ["Caller Author"],
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
      authorNames: ["Ada Lovelace"],
      coverUrl: "",
      subjects: [],
      fiction: true,
    },
    edition: {
      isbn13: null,
      title: "The Book",
      authorNames: ["Ada Lovelace"],
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
    authorNames: ["Ada Lovelace"],
    authorNamesLower: ["ada lovelace"],
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
    authorNames: ["Ada Lovelace"],
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
    authorNames: ["Ada Lovelace"],
    coverUrl: "https://example.test/work.jpg",
    mergedFrom: ["old-work"],
  });
  assert.deepEqual(Object.keys(result.editions[0]).sort(), [
    "authorNames", "coverUrl", "editionId", "format", "isbn13", "language",
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
  assert.equal(logs[0][0], "catalog.work_readers");
  assert.deepEqual(logs[0][1], {
    workId: "canonical-work",
    personalBooks: 1,
    optedInRows: 1,
    readers: 1,
    durationMs: logs[0][1].durationMs,
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
