require("./setup.cts");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const {readFileSync}: typeof import("node:fs") = require("node:fs");
const {join}: typeof import("node:path") = require("node:path");
const test: typeof import("node:test").test = require("node:test");
const {FieldPath, getFirestore, Timestamp}: typeof import("firebase-admin/firestore") = require("firebase-admin/firestore");
const {logger}: typeof import("firebase-functions") = require("firebase-functions");
const {sharedWorkOwnerId}: typeof import("../src/catalogProjection") = require("../lib/catalogProjection");

type TestContext = import("node:test").TestContext;
type Row = Record<string, unknown>;
type Handler<T> = (transaction: T) => Promise<unknown>;
interface Ref {
  path: string;
  id: string;
}
interface Runnable<T> {
  run(data: unknown, context: unknown): Promise<T>;
}
interface SearchResult {
  results: Array<{workId: string; editionId: string | null; edition: unknown; work: {authors: Row[]}}>;
}
interface WorkReadersResult {
  work: unknown;
  editions: Row[];
  attempts: Row[];
  incomplete: boolean;
  omittedAttempts: number;
  nextCursor: string | null;
}
interface Deployed {
  catalog: {
    search: Runnable<SearchResult>;
    ensureauthors: Runnable<{authorIds: string[]}>;
    workreaders: Runnable<WorkReadersResult>;
    create?: unknown;
  };
}
interface ReadingEventStub {
  type: string;
  createdAt: import("firebase-admin/firestore").Timestamp;
  pagesRead: number;
  timeRead: number;
}
interface UpdatesQueryStub {
  limit(limit: number): {get(): Promise<{size: number; docs: unknown[]}>};
}
interface ReaderBookStub {
  snapshot: {ref: {path: string; collection(name: string): UpdatesQueryStub}};
  identity: {uid: string; finished: boolean; pageCount: number; editionId: string | null};
  shared: {username: string; displayName: string; timeZone: string};
}
interface CreateResult {
  status: string;
  reason?: string;
  created?: boolean;
  promoted?: boolean;
  workId?: string;
  editionId?: string;
}
// The pure helpers take Firestore snapshot types; the stubs below satisfy
// only the members the helpers read, so the module is typed locally.
interface CatalogModule {
  normalizeCatalogTitle(value: string): string;
  summarizeReadingAttempt(
    book: {finished: boolean; pageCount: number; editionId: string | null},
    events: readonly ReadingEventStub[],
    timeZone: string,
  ): Row;
  summarizeReaderBooks(books: ReaderBookStub[], workId: string): Promise<{
    attempts: Array<{username: string}>;
    incomplete: boolean;
    omittedAttempts: number;
  }>;
  createCatalogEntry(request: unknown): Promise<CreateResult>;
}

const deployed: Deployed = require("../lib");
const catalog: CatalogModule = require("../lib/catalog");
const db = getFirestore();
const authContext = {auth: {uid: "owner", token: {email_verified: true}}};
const liveUserCollection = () => ({
  doc: () => ({get: async () => ({exists: true, get: () => undefined})}),
});
const activeAuthor = (canonicalName: string): Row => ({
  canonicalName,
  alternateNames: [],
  nameKeys: [canonicalName.toLowerCase()],
  sortName: canonicalName,
  kind: "person",
  status: "active",
  mergedFrom: [],
});

test("the Functions title normalizer agrees with the shared client fixture", () => {
  const fixtures: Array<{input: string; output: string}> = JSON.parse(readFileSync(join(
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
  const event = (type: string, createdAt: string, pagesRead: number, timeRead = 0): ReadingEventStub => ({
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
  const event = (createdAt: string, pagesRead: number): ReadingEventStub => ({
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

// A page-count correction (updateBook with pageCountClampFrom) is an
// update event with zero or negative pagesRead, appended long after the
// book was finished; it must not move the finish date or stretch the
// calendar span.
test("a later page-count correction does not move the finish date", () => {
  const event = (type: "reading" | "update", createdAt: string, pagesRead: number): ReadingEventStub => ({
    type,
    createdAt: Timestamp.fromDate(new Date(createdAt)),
    pagesRead,
    timeRead: type === "reading" ? 60 : 0,
  });
  const result = catalog.summarizeReadingAttempt(
    {finished: true, pageCount: 250, editionId: null},
    [
      event("reading", "2026-03-01T10:00:00.000Z", 150),
      event("reading", "2026-03-02T10:00:00.000Z", 150),
      event("update", "2026-06-01T10:00:00.000Z", -50),
    ],
    "UTC",
  );
  assert.equal(result.finishedAt, "2026-03-02");
  assert.equal(result.calendarDays, 2);
  assert.equal(result.activeDays, 2);
});

// Browsers report these verbatim and Rules accept them; the validator
// must too, or the reader is silently omitted from every work page.
test("reading summaries accept the time zone aliases browsers report", () => {
  for (const timeZone of ["Asia/Kolkata", "Europe/Kyiv", "Etc/UTC"]) {
    const result = catalog.summarizeReadingAttempt(
      {finished: false, pageCount: 100, editionId: null},
      [{
        type: "reading",
        createdAt: Timestamp.fromDate(new Date("2026-08-20T18:00:00.000Z")),
        pagesRead: 10,
        timeRead: 10,
      }],
      timeZone,
    );
    assert.equal(result.firstReadAt, "2026-08-20", timeZone);
  }
  assert.throws(() => catalog.summarizeReadingAttempt(
    {finished: false, pageCount: 100, editionId: null}, [], "Mars/Olympus_Mons",
  ), /Unsupported time zone/);
});

test("an oversized first attempt does not crowd out the next owner", async () => {
  let queries = 0;
  const books: ReaderBookStub[] = Array.from({length: 2}, (_, index) => ({
    snapshot: {
      ref: {
        path: `users/reader-${index}/books/book-${index}`,
        collection: () => ({limit: (limit: number) => ({get: async () => {
          queries += 1;
          assert.equal(limit, 201);
          if (index === 0) return {size: limit, docs: Array(limit).fill({})};
          const reading: Row = {
            type: "reading",
            createdAt: Timestamp.fromDate(new Date("2026-08-20T18:00:00.000Z")),
            pagesRead: 50,
            timeRead: 60,
            owner: {path: `users/reader-${index}`},
            book: {path: `users/reader-${index}/books/book-${index}`},
          };
          const update = {get: (field: string) => reading[field]};
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
  const books: ReaderBookStub[] = Array.from({length: 50}, (_, index) => ({
    snapshot: {
      ref: {
        path: `users/reader-${Math.floor(index / 5)}/books/book-${index}`,
        collection: () => ({limit: (limit: number) => ({get: async () => {
          assert.equal(limit, 201);
          const reading: Row = {
            type: "reading",
            createdAt: Timestamp.fromDate(new Date("2026-08-20T18:00:00.000Z")),
            pagesRead: 1,
            timeRead: 5,
            owner: {path: `users/reader-${Math.floor(index / 5)}`},
            book: {path: `users/reader-${Math.floor(index / 5)}/books/book-${index}`},
          };
          const update = {get: (field: string) => reading[field]};
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
    (error) => hasCode(error, "unauthenticated"),
  );
  await assert.rejects(
    deployed.catalog.ensureauthors.run({authors: [{
      canonicalName: "Author", sortName: "Author", kind: "person",
    }]}, {auth: undefined}),
    (error) => hasCode(error, "unauthenticated"),
  );
  await assert.rejects(
    deployed.catalog.search.run({title: "Book", uid: "other"}, authContext),
    (error) => hasCode(error, "invalid-argument"),
  );
  await assert.rejects(
    deployed.catalog.workreaders.run({workId: "work/other"}, authContext),
    (error) => hasCode(error, "invalid-argument"),
  );
  assert.equal(touched, false);
});

test("catalog search has a separate bounded hourly quota", async (t) => {
  const quotaRef = {path: "users/owner/functionQuotas/catalogSearch"};
  const quota = {windowStartedAt: Timestamp.now(), count: 60};
  t.mock.method(db, "doc", (path: string) => {
    assert.equal(path, quotaRef.path);
    return quotaRef;
  });
  t.mock.method(db, "collection", (name: string) => {
    assert.equal(name, "users");
    return liveUserCollection();
  });
  t.mock.method(db, "runTransaction", async (handler: Handler<{
    get(): Promise<{data(): Row}>;
    update(): void;
  }>) => handler({
    get: async () => ({data: () => quota}),
    update: () => undefined,
  }));
  await assert.rejects(
    deployed.catalog.search.run({title: "Book", authorNames: ["Author"]}, authContext),
    (error) => hasCode(error, "resource-exhausted"),
  );
});

test("title search has a global hourly spend breaker", async (t) => {
  const paths: string[] = [];
  t.mock.method(db, "doc", (path: string) => ({path}));
  t.mock.method(db, "collection", (name: string) => {
    assert.equal(name, "users");
    return liveUserCollection();
  });
  t.mock.method(db, "runTransaction", async (handler: Handler<{
    get(reference: {path: string}): Promise<{data(): Row | undefined}>;
    set(): void;
    update(): void;
  }>) => handler({
    get: async (reference: {path: string}) => {
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
    (error) => hasCode(error, "resource-exhausted"),
  );
  assert.deepEqual(paths, [
    "users/owner/functionQuotas/catalogSearch",
    "functionGlobalQuotas/catalogSearch",
  ]);
});

test("catalog callables reject deleted accounts before quotas or catalog reads", async (t) => {
  let catalogTouched = false;
  t.mock.method(db, "collection", (name: string) => {
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
    (error) => hasCode(error, "failed-precondition"),
  );
  await assert.rejects(
    deployed.catalog.search.run({title: "Book", authorNames: ["Author"]}, authContext),
    (error) => hasCode(error, "failed-precondition"),
  );
  await assert.rejects(
    deployed.catalog.workreaders.run({workId: "work"}, authContext),
    (error) => hasCode(error, "failed-precondition"),
  );
  assert.equal(catalogTouched, false);
});

test("ordinary users resolve existing shared authors and create only missing catalog rows", async (t) => {
  interface AuthorQuery {
    keys?: unknown;
    capacity?: boolean;
    where(field: string, operator: string, keys: unknown): AuthorQuery;
    count(): AuthorQuery;
    doc(id: string): Ref;
  }
  const rows = new Map<string, Row>([["catalogAuthors/le-guin", {
    ...activeAuthor("Ursula K. Le Guin"), nameKeys: ["ursula k le guin"],
  }]]);
  const ref = (path: string): Ref => ({path, id: path.slice(path.lastIndexOf("/") + 1)});
  const snap = (reference: Ref) => ({
    exists: rows.has(reference.path), id: reference.id, ref: reference,
    data: () => rows.get(reference.path),
    get: (field: string) => rows.get(reference.path)?.[field],
  });
  t.mock.method(db, "doc", (path: string) => ref(path));
  t.mock.method(db, "collection", (name: string) => {
    if (name === "users") {
      return {doc: () => ({get: async () => ({exists: true, get: () => undefined})})};
    }
    assert.equal(name, "catalogAuthors");
    const query: AuthorQuery = {
      where: (field: string, operator: string, keys: unknown) => {
        assert.deepEqual([field, operator], ["nameKeys", "array-contains-any"]);
        query.keys = keys;
        return query;
      },
      count: () => {
        query.capacity = true;
        return query;
      },
      doc: (id: string) => ref(`catalogAuthors/${id}`),
    };
    return query;
  });
  t.mock.method(db, "runTransaction", async (handler: Handler<{
    get(value: AuthorQuery | Ref): Promise<unknown>;
    getAll?(...references: Ref[]): Promise<unknown[]>;
    set(reference: Ref, data: Row): void;
    update?(reference: Ref, data: Row): void;
    create?(reference: Ref, data: Row): void;
  }>) => {
    return handler({
      get: async (value: AuthorQuery | Ref) => {
        if ("where" in value) {
          if (value.keys !== undefined) {
            const keys = value.keys;
            assert.ok(Array.isArray(keys));
            return {
              docs: [...rows.keys()].map((path) => snap(ref(path))).filter((snapshot) => {
                const nameKeys = snapshot.data()?.nameKeys;
                assert.ok(Array.isArray(nameKeys));
                return nameKeys.some((key: unknown) => keys.includes(key));
              }),
            };
          }
          if (value.capacity === true) return {data: () => ({count: rows.size})};
          assert.fail("unexpected catalogAuthors query read");
        }
        return snap(value);
      },
      getAll: async (...references: Ref[]) => references.map(snap),
      set: () => assert.fail("ensureauthors writes no quota documents"),
      update: () => assert.fail("ensureauthors writes no quota documents"),
      create: (reference: Ref, data: Row) => {
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
  assert.ok(created);
  assert.equal(created.canonicalName, "Octavia E. Butler");
  assert.deepEqual(created.nameKeys, ["octavia e butler"]);
  assert.equal(created.status, "active");
  await assert.rejects(
    deployed.catalog.ensureauthors.run({authors: [{
      canonicalName: "Ursula K. Le Guin", sortName: "Le Guin", kind: "entity",
    }]}, authContext),
    (error) => hasCode(error, "failed-precondition") && messageMatches(error, /different type/),
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
    (error) => hasCode(error, "failed-precondition") && messageMatches(error, /different type/),
  );
});

function installMissingAuthorBoundaryStore(t: TestContext, catalogSize: number): void {
  const ref = (path: string): Ref => ({path, id: path.slice(path.lastIndexOf("/") + 1)});
  const snapshot = (reference: Ref, data: Row | undefined) => ({
    exists: data !== undefined,
    id: reference.id,
    ref: reference,
    data: () => data,
    get: (field: string) => data?.[field],
  });
  t.mock.method(db, "doc", ref);
  t.mock.method(db, "collection", (name: string) => {
    if (name === "users") {
      return {doc: () => ({get: async () => ({exists: true, get: () => undefined})})};
    }
    assert.equal(name, "catalogAuthors");
    return {
      where: () => ({kind: "matching"}),
      count: () => ({kind: "capacity"}),
      doc: (id?: string) => ref(`catalogAuthors/${id ?? "auto"}`),
    };
  });
  t.mock.method(db, "runTransaction", async (handler: Handler<{
    get(value: {kind: string} | Ref): Promise<unknown>;
    getAll?(...references: Ref[]): Promise<unknown[]>;
    set(): void;
    update?(): void;
    create?(): void;
  }>) => {
    return handler({
      get: async (value: {kind: string} | Ref) => {
        if ("kind" in value) {
          if (value.kind === "matching") return {docs: []};
          if (value.kind === "capacity") return {data: () => ({count: catalogSize})};
          assert.fail(`unexpected catalogAuthors query ${value.kind}`);
        }
        assert.fail(`unexpected document read ${value.path}`);
      },
      getAll: async (...references: Ref[]) => references.map((reference) => snapshot(reference, undefined)),
      set: () => undefined,
      update: () => undefined,
      create: () => undefined,
    });
  });
}

test("shared author creation refuses the hard catalog capacity", async (t) => {
  installMissingAuthorBoundaryStore(t, 500);
  await assert.rejects(
    deployed.catalog.ensureauthors.run({authors: [{
      canonicalName: "New Author", sortName: "Author", kind: "person",
    }]}, authContext),
    (error) => hasCode(error, "resource-exhausted") && messageMatches(error, /catalog is full/),
  );
});

test("an exact title with the wrong author is not returned", async (t) => {
  interface TitleQuery {
    where(...args: unknown[]): TitleQuery;
    orderBy(): TitleQuery;
    limit(): TitleQuery;
    get(): Promise<{docs: unknown[]}>;
  }
  const whereCalls: unknown[][] = [];
  let authorReads = 0;
  const work: Row = {
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
  const snap = (path: string, data: Row | undefined) => ({
    exists: data !== undefined,
    id: path.slice(path.lastIndexOf("/") + 1),
    ref: {path},
    data: () => data,
    get: (field: string) => data?.[field],
  });
  t.mock.method(db, "doc", () => ({path: "users/owner/functionQuotas/catalogSearch"}));
  t.mock.method(db, "runTransaction", async (handler: Handler<{
    get(): Promise<{data(): undefined}>;
    set(): void;
  }>) => handler({
    get: async () => ({data: () => undefined}),
    set: () => undefined,
  }));
  t.mock.method(db, "collection", (name: string) => {
    if (name === "users") return liveUserCollection();
    if (name === "workTitleIndex") {
      const query: TitleQuery = {
        where: (...args: unknown[]) => {
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
      return {doc: (id: string) => ({get: async () => snap(`works/${id}`, work)})};
    }
    if (name === "catalogAuthors") {
      return {doc: (id: string) => ({get: async () => {
        authorReads += 1;
        return snap(`catalogAuthors/${id}`, {
          ...activeAuthor("Correct Author"),
          alternateNames: ["C. Author"],
          nameKeys: ["correct author", "c author"],
        });
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
  // A stored alias matches too: the author the user types may be the
  // spelling ensureauthors would resolve, and a miss here creates an
  // unlinked duplicate.
  const aliasWork = await deployed.catalog.search.run({
    title: "The Shared Title",
    authorNames: ["C. Author"],
  }, authContext);
  assert.equal(aliasWork.results[0].workId, "work");
  assert.deepEqual(Object.keys(aliasWork.results[0].work.authors[0]).sort(),
    ["authorId", "canonicalName", "kind", "sortName"]);
  assert.deepEqual(whereCalls[0], ["visibility", "==", "searchable"]);
  assert.equal(authorReads, 3);
});

// Work and edition creation is admin-only (adminCatalog.ts); there is no
// ordinary-user creation callable and no exported creation path to drift.
test("ordinary catalog creation is not deployed", () => {
  assert.equal(deployed.catalog.create, undefined);
  assert.equal("createCatalogEntry" in catalog, false);
});

test("work readers resolve aliases and return only consented redacted summaries", async (t) => {
  interface BookRef {
    path: string;
    collection?(name: string): UpdatesQueryStub;
  }
  const sharedOwner = db.collection("users").doc("shared-reader");
  const workData: Row = {
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
  const editionData: Row = {
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
  const snap = (path: string, data: Row | undefined, extra: {ref?: BookRef} = {}) => ({
    exists: data !== undefined,
    id: path.slice(path.lastIndexOf("/") + 1),
    ref: {path},
    data: () => data,
    get: (field: string) => data?.[field],
    ...extra,
  });
  type Snap = ReturnType<typeof snap>;
  interface OwnersQuery {
    orderBy(field: unknown): OwnersQuery;
    startAfter(value: string): OwnersQuery;
    limit(limit: number): {get(): Promise<{docs: Snap[]; size: number}>};
  }
  const updatesData: Row = {
    type: "reading",
    createdAt: Timestamp.fromDate(new Date("2026-08-20T18:00:00.000Z")),
    pagesRead: 100,
    timeRead: 60,
    owner: sharedOwner,
    book: {path: "users/shared-reader/books/reread"},
    privateNote: "must not be returned",
  };
  const updates = snap("users/shared-reader/books/reread/updates/session", updatesData);
  const bookSnap = (uid: string, owner: {path: string}, id: string) => snap(`users/${uid}/books/${id}`, {
    owner,
    finished: true,
    pageCount: 300,
    editionId: "edition-one",
    email: `${uid}@example.test`,
  }, {
    ref: {
      path: `users/${uid}/books/${id}`,
      collection: (name: string) => {
        assert.equal(name, "updates");
        return {limit: (limit: number) => {
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
  const settings: Record<string, Row | undefined> = {
    "users/shared-reader/settings/bookSharing": {
      profileUsername: "ada-reader",
      timeZone: "America/Los_Angeles",
    },
  };
  let projectionOverflow = false;
  let malformedProjection = false;
  let malformedBook = false;
  t.mock.method(db, "doc", (path: string) => {
    if (path === quotaRef.path) return quotaRef;
    return {
      path,
      get: async () => snap(path, settings[path]),
    };
  });
  t.mock.method(db, "runTransaction", async (handler: Handler<{
    get(): Promise<{data(): undefined}>;
    set(): void;
  }>) => handler({
    get: async () => ({data: () => undefined}),
    set: () => undefined,
  }));
  t.mock.method(db, "collection", (name: string) => {
    if (name === "sharedWorkOwners") return {
      where: (field: string, operator: string, values: unknown) => {
        assert.deepEqual([field, operator, values], [
          "workId", "in", ["canonical-work", "old-work"],
        ]);
        let cursor: string | null = null;
        const query: OwnersQuery = {
          orderBy: (field: unknown) => {
            assert.deepEqual(field, FieldPath.documentId());
            return query;
          },
          startAfter: (value: string) => {
            cursor = value;
            return query;
          },
          limit: (limit: number) => {
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
    if (name === "works") return {doc: (id: string) => ({
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
    if (name === "catalogAuthors") return {doc: (id: string) => ({
      get: async () => snap(
        `catalogAuthors/${id}`,
        id === "ada-lovelace" ? activeAuthor("Ada Lovelace") : undefined,
      ),
    })};
    if (name === "editions") return {
      where: (field: string, operator: string, value: unknown) => {
        assert.deepEqual([field, operator, value], ["workId", "==", "canonical-work"]);
        return {limit: (limit: number) => {
          assert.equal(limit, 101);
          return {get: async () => ({
            docs: [snap("editions/edition-one", editionData)],
            size: 1,
          })};
        }};
      },
    };
    if (name === "users") return {doc: (uid: string) => ({
      get: async () => snap(`users/${uid}`, {uid}),
    })};
    if (name === "profiles") return {doc: (username: string) => ({
      get: async () => snap(`profiles/${username}`, username === "ada-reader" ? {
        uid: "shared-reader",
        public: true,
        givenName: "Ada",
        familyName: "Reader",
        email: "must-not-be-returned@example.test",
      } : undefined),
    })};
    if (name === "users/shared-reader/books") {
      return {where: (field: string, operator: string, values: unknown) => {
        assert.deepEqual([field, operator, values], [
          "workId", "in", ["canonical-work", "old-work"],
        ]);
        return {orderBy: () => ({limit: (limit: number) => {
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
  const logs: Array<[string, Row]> = [];
  const warnings: unknown[][] = [];
  t.mock.method(logger, "info", (...args: [string, Row]) => logs.push(args));
  t.mock.method(logger, "warn", (...args: unknown[]) => warnings.push(args));
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
  updatesData.book = {path: "users/shared-reader/books/a-different-book"};
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
      (error) => hasCode(error, "not-found") && hasMessage(error, "Book not found."),
    );
  }
  assert.equal(warnings.filter(([message]) =>
    message === "catalog.work_readers.invalid_work").length, 2);
});

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}

function hasMessage(error: unknown, message: string): boolean {
  return error instanceof Error && error.message === message;
}

function messageMatches(error: unknown, pattern: RegExp): boolean {
  return error instanceof Error && pattern.test(error.message);
}
