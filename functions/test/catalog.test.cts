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
    create: Runnable<{workId: string; editionId: string; created: boolean}>;
    addedition: Runnable<{workId: string; editionId: string; created: boolean}>;
    ensureauthors: Runnable<{authorIds: string[]}>;
    workreaders: Runnable<WorkReadersResult>;
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
  identity: {
    uid: string;
    finished: boolean;
    finishedAt: import("firebase-admin/firestore").Timestamp | null;
    pageCount: number;
  };
  shared: {readerKey: string; username: string | null; displayName: string | null; timeZone: string};
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
  catalogAuthorId(nameKey: string): string;
  titleIndexId(workId: string, titleKey: string): string;
  externalIndexId(externalId: {provider: string; id: string}): string;
  summarizeReadingAttempt(
    book: {
      finished: boolean;
      finishedAt: import("firebase-admin/firestore").Timestamp | null;
      pageCount: number;
    },
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

// The migration scripts derive the same document ids with their own copies
// of these formulas; the fixture is asserted from both packages so a drift
// on either side goes red instead of minting a second active document.
test("the Functions id derivations agree with the shared id fixture", () => {
  const fixtures: Array<{kind: string; input: Record<string, string>; expectedId: string}> =
    JSON.parse(readFileSync(join(__dirname, "..", "..", "test-fixtures", "catalog-ids.json"), "utf8"));
  const derive: Record<string, (input: Record<string, string>) => string> = {
    "catalog-author": (input) => catalog.catalogAuthorId(input.nameKey),
    "work-title-index": (input) => catalog.titleIndexId(input.workId, input.titleKey),
    "shared-work-owner": (input) => sharedWorkOwnerId(input.workId, input.uid),
    "external-id-index": (input) => catalog.externalIndexId({provider: input.provider, id: input.externalId}),
  };
  const covered = fixtures.filter((fixture) => fixture.kind in derive);
  assert.equal(covered.length, 6);
  for (const fixture of covered) {
    assert.equal(derive[fixture.kind](fixture.input), fixture.expectedId, fixture.kind);
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
    {
      finished: true,
      finishedAt: Timestamp.fromDate(new Date("2024-03-10T22:00:00.000Z")),
      pageCount: 300,
    },
    [
      // 01:30 local, before the 3 AM boundary: first (positive) progress
      // lands on the previous calendar day.
      event("update", "2024-03-10T09:30:00.000Z", 5),
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
    {
      finished: true,
      finishedAt: Timestamp.fromDate(new Date("0001-01-02T04:00:00.000Z")),
      pageCount: 100,
    },
    [event("0001-01-01T04:00:00.000Z", 50), event("0001-01-02T04:00:00.000Z", 50)],
    "UTC",
  );
  assert.equal(result.firstReadAt, "0001-01-01");
  assert.equal(result.finishedAt, "0001-01-02");
  assert.equal(result.calendarDays, 2);
});

// The stamp written when the book was marked finished is the finish date,
// whatever the history says; a finished book without one is malformed
// (migrate-finished-at.ts stamped every older book) and is refused rather
// than dated from its rows.
test("the finishedAt stamp is the finish date and an unstamped finished book is refused", () => {
  const reading = (createdAt: string): ReadingEventStub => ({
    type: "reading",
    createdAt: Timestamp.fromDate(new Date(createdAt)),
    pagesRead: 100,
    timeRead: 60,
  });
  const result = catalog.summarizeReadingAttempt(
    {
      finished: true,
      finishedAt: Timestamp.fromDate(new Date("2026-03-05T20:00:00.000Z")),
      pageCount: 200,
    },
    [reading("2026-03-01T10:00:00.000Z"), reading("2026-03-02T10:00:00.000Z")],
    "UTC",
  );
  assert.equal(result.finishedAt, "2026-03-05");
  assert.equal(result.calendarDays, 5);
  assert.throws(
    () => catalog.summarizeReadingAttempt(
      {finished: true, finishedAt: null, pageCount: 200},
      [reading("2026-03-01T10:00:00.000Z")],
      "UTC",
    ),
    /carries no finishedAt/,
  );
});

// A page-count correction (updateBook with pageCountClampFrom) is an
// update event with zero or negative pagesRead, appended long after the
// book was finished; it must not count as an active day or stretch the
// calendar span.
test("a later page-count correction does not stretch the reading span", () => {
  const event = (type: "reading" | "update", createdAt: string, pagesRead: number): ReadingEventStub => ({
    type,
    createdAt: Timestamp.fromDate(new Date(createdAt)),
    pagesRead,
    timeRead: type === "reading" ? 60 : 0,
  });
  const result = catalog.summarizeReadingAttempt(
    {
      finished: true,
      finishedAt: Timestamp.fromDate(new Date("2026-03-02T10:00:00.000Z")),
      pageCount: 250,
    },
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

// A book added already finished carries a finishedAt stamp and no reading
// history; a later page-count correction is its only event. Were that
// correction taken as "first progress", calendarDays would go negative
// and the client decoder would reject the whole reader response.
test("a correction-only finished attempt has no first progress and no negative span", () => {
  const result = catalog.summarizeReadingAttempt(
    {
      finished: true,
      finishedAt: Timestamp.fromDate(new Date("2026-03-05T20:00:00.000Z")),
      pageCount: 180,
    },
    [{
      type: "update",
      createdAt: Timestamp.fromDate(new Date("2026-06-01T10:00:00.000Z")),
      pagesRead: -20,
      timeRead: 0,
    }],
    "UTC",
  );
  assert.equal(result.firstProgressAt, null);
  assert.equal(result.calendarDays, null);
  assert.equal(result.finishedAt, "2026-03-05");
  assert.equal(result.activeDays, 0);
});

// Browsers report these verbatim and Rules accept them; the validator
// must too, or the reader is silently omitted from every work page.
test("reading summaries accept the time zone aliases browsers report", () => {
  for (const timeZone of ["Asia/Kolkata", "Europe/Kyiv", "Etc/UTC"]) {
    const result = catalog.summarizeReadingAttempt(
      {finished: false, finishedAt: null, pageCount: 100},
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
    {finished: false, finishedAt: null, pageCount: 100}, [], "Mars/Olympus_Mons",
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
    identity: {
      uid: `reader-${index}`,
      finished: true,
      finishedAt: Timestamp.fromDate(new Date("2026-08-21T18:00:00.000Z")),
      pageCount: 300,
    },
    shared: {
      readerKey: `reader-${index}`,
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

// The page is bounded by its caller: ten owners (SHARED_OWNER_LIMIT) times
// five rereads each (BOOKS_PER_UID_LIMIT). All fifty are summarized, each
// history read once at the 200-row cap, and none is dropped.
test("the largest possible owner page is summarized in full", async () => {
  let queries = 0;
  const books: ReaderBookStub[] = Array.from({length: 50}, (_, index) => ({
    snapshot: {
      ref: {
        path: `users/reader-${Math.floor(index / 5)}/books/book-${index}`,
        collection: () => ({limit: (limit: number) => ({get: async () => {
          queries += 1;
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
      finishedAt: Timestamp.fromDate(new Date("2026-08-21T18:00:00.000Z")),
      pageCount: 300,
    },
    shared: {
      readerKey: `reader-${String(Math.floor(index / 5)).padStart(2, "0")}`,
      username: `reader-${String(Math.floor(index / 5)).padStart(2, "0")}`,
      displayName: `Reader ${Math.floor(index / 5)}`,
      timeZone: "UTC",
    },
  }));
  const result = await catalog.summarizeReaderBooks(books, "work");
  assert.equal(queries, 50);
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

// A reader page can cost ~10k reads (ten owners x five books x 200 update
// rows); sixty an hour caps one hostile account at roughly $0.36/h. The
// account's own counter is the only meter, and it is spent before the work
// is read.
test("reader summaries are metered per account at sixty an hour", async (t) => {
  const paths: string[] = [];
  t.mock.method(db, "doc", (path: string) => ({path}));
  t.mock.method(db, "collection", (name: string) => {
    assert.equal(name, "users");
    return liveUserCollection();
  });
  t.mock.method(db, "runTransaction", async (handler: Handler<{
    get(reference: {path: string}): Promise<{data(): Row}>;
    update(): void;
  }>) => handler({
    get: async (reference: {path: string}) => {
      paths.push(reference.path);
      return {data: () => ({windowStartedAt: Timestamp.now(), count: 60})};
    },
    update: () => undefined,
  }));
  await assert.rejects(
    deployed.catalog.workreaders.run({workId: "work"}, authContext),
    (error) => hasCode(error, "resource-exhausted"),
  );
  assert.deepEqual(paths, ["users/owner/functionQuotas/workReaders"]);
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
  assert.equal(created.createdBy, "owner");
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
  installMissingAuthorBoundaryStore(t, 5000);
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
    language: "",
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
  // A title search costs on the order of 100 reads (~$0.00006), so it has no
  // quota: it must not read or write a quota document at all.
  t.mock.method(db, "doc", (path: string): never => assert.fail(`search read ${path}`));
  t.mock.method(db, "runTransaction", (): never =>
    assert.fail("search runs no quota transaction"));
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
          workId: "work", status: "active",
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
  assert.deepEqual(whereCalls[0], ["status", "==", "active"]);
  assert.equal(authorReads, 3);
});

// More works than one index page can share a normalized title ("Collected
// Works"); the author filter runs on hydrated candidates, so search must
// page past the first window or the exact title/author match is invisible
// and the add flow creates a duplicate.
test("a title shared by more than one index page still finds the requested author", async (t) => {
  interface TitleQuery {
    where(...args: unknown[]): TitleQuery;
    orderBy(): TitleQuery;
    startAfter(cursor: {ref: {path: string}}): TitleQuery;
    limit(limit: number): TitleQuery;
    get(): Promise<{docs: unknown[]}>;
  }
  const snap = (path: string, data: Row) => ({
    exists: true,
    id: path.slice(path.lastIndexOf("/") + 1),
    ref: {path},
    data: () => data,
    get: (field: string) => data[field],
  });
  // 26 works, all with the identical key; the wanted author's work sorts
  // last, past the 25-row first page.
  const indexRows = Array.from({length: 26}, (_, position) =>
    snap(`workTitleIndex/row-${String(position).padStart(2, "0")}`, {
      workId: `work-${String(position).padStart(2, "0")}`,
      status: "active",
    }),
  );
  const workData = (position: number): Row => ({
    canonicalTitle: "Collected Works",
    alternateTitles: [],
    titleKeys: ["collected works"],
    authorIds: [position === 25 ? "wanted-author" : "other-author"],
    coverUrl: "",
    subjects: [],
    fiction: null,
    language: "",
    status: "active",
    mergedFrom: [],
  });
  const pageLimits: number[] = [];
  t.mock.method(db, "doc", (path: string): never => assert.fail(`search read ${path}`));
  t.mock.method(db, "runTransaction", (): never =>
    assert.fail("search runs no quota transaction"));
  t.mock.method(db, "collection", (name: string) => {
    if (name === "users") return liveUserCollection();
    if (name === "workTitleIndex") {
      const makeQuery = (start: number): TitleQuery => ({
        where: () => makeQuery(start),
        orderBy: () => makeQuery(start),
        startAfter: (cursor: {ref: {path: string}}) => makeQuery(
          indexRows.findIndex((row) => row.ref.path === cursor.ref.path) + 1,
        ),
        limit: (limit: number) => {
          pageLimits.push(limit);
          return makeQuery(start);
        },
        get: async () => ({docs: indexRows.slice(start, start + pageLimits[pageLimits.length - 1])}),
      });
      return makeQuery(0);
    }
    if (name === "works") {
      return {doc: (id: string) => ({get: async () =>
        snap(`works/${id}`, workData(Number(id.slice("work-".length)))),
      })};
    }
    if (name === "catalogAuthors") {
      return {doc: (id: string) => ({get: async () => snap(
        `catalogAuthors/${id}`,
        activeAuthor(id === "wanted-author" ? "Wanted Author" : "Other Author"),
      )})};
    }
    assert.fail(`unexpected collection ${name}`);
  });
  const found = await deployed.catalog.search.run({
    title: "Collected Works",
    authorNames: ["Wanted Author"],
  }, authContext);
  assert.equal(found.results.some(({workId}) => workId === "work-25"), true);
  assert.equal(pageLimits.length, 2);
});

// Any verified user creates the work and edition a book lacks (catalog
// data is public); an identifier already in the catalog resolves to the
// existing entry so retries and races never duplicate one.
test("users create missing works and resolve existing identifiers", async (t) => {
  const rows = new Map<string, Row>([
    ["catalogAuthors/ada", activeAuthor("Ada Lovelace")],
    ["isbnIndex/9780000000002", {workId: "old-work", editionId: "old-edition"}],
    // The indexed edition was merged since: the index still names it, the
    // answer is its survivor.
    ["editions/old-edition", {
      workId: "canonical-work", isbn13: "9780000000002", title: "Old", publisher: "", publishedDate: "",
      language: "", translatorNames: [], format: "unknown", suggestedPageCount: null, coverUrl: "",
      externalIds: {}, status: "merged", mergedInto: "surviving-edition",
    }],
    ["editions/surviving-edition", {
      workId: "canonical-work", isbn13: null, title: "Surviving", publisher: "", publishedDate: "",
      language: "", translatorNames: [], format: "unknown", suggestedPageCount: null, coverUrl: "",
      externalIds: {}, mergedFrom: ["old-edition"],
    }],
    ["works/old-work", {
      canonicalTitle: "Old", alternateTitles: [], titleKeys: ["old"], authorIds: ["ada"],
      coverUrl: "", subjects: [], fiction: null, status: "merged",
      language: "",
      mergedInto: "canonical-work", mergedFrom: [],
    }],
    ["works/canonical-work", {
      canonicalTitle: "Canonical", alternateTitles: [], titleKeys: ["canonical"], authorIds: ["ada"],
      coverUrl: "", subjects: [], fiction: null, status: "active",
      language: "",
      mergedFrom: ["old-work"],
    }],
  ]);
  const ref = (path: string): Ref => ({path, id: path.slice(path.lastIndexOf("/") + 1)});
  const snap = (reference: Ref) => ({
    exists: rows.has(reference.path), id: reference.id, ref: reference,
    data: () => rows.get(reference.path),
    get: (field: string) => rows.get(reference.path)?.[field],
  });
  const created: Array<{path: string; data: Row}> = [];
  t.mock.method(db, "doc", (path: string) => ref(path));
  t.mock.method(db, "collection", (name: string) => {
    if (name === "users") return liveUserCollection();
    return {
      doc: (id: string) => ref(`${name}/${id}`),
      count: () => ({kind: "count", name}),
    };
  });
  t.mock.method(db, "runTransaction", async (handler: Handler<{
    get(value: {kind: string; name: string} | Ref): Promise<unknown>;
    create(reference: Ref, data: Row): void;
  }>) => handler({
    get: async (value: {kind: string; name: string} | Ref) => {
      if ("kind" in value) {
        return {data: () => ({count: [...rows.keys()].filter((path) => path.startsWith(`${value.name}/`)).length})};
      }
      return snap(value);
    },
    create: (reference: Ref, data: Row) => {
      assert.equal(rows.has(reference.path), false, reference.path);
      rows.set(reference.path, data);
      created.push({path: reference.path, data});
    },
  }));
  const edition = {
    isbn13: null, title: "A New Book", publisher: "", publishedDate: "", language: "",
    translatorNames: [], format: "unknown", suggestedPageCount: 300, coverUrl: "", externalIds: {},
  };
  const work = {
    canonicalTitle: "A New Book", alternateTitles: [], authorIds: ["ada"],
    coverUrl: "", subjects: [], fiction: null,
    language: "",
  };
  const result = await deployed.catalog.create.run({work, edition}, authContext);
  assert.equal(result.created, true);
  assert.match(result.workId, /^work-/);
  assert.match(result.editionId, /^edition-/);
  const storedWork = rows.get(`works/${result.workId}`);
  assert.equal(storedWork?.status, "active");
  assert.equal(storedWork?.createdBy, "owner");
  assert.deepEqual(storedWork?.titleKeys, ["new book"]);
  assert.equal(rows.get(`editions/${result.editionId}`)?.workId, result.workId);
  assert.equal(rows.get(`editions/${result.editionId}`)?.createdBy, "owner");
  assert.equal(created.some(({path, data}) => path.startsWith("workTitleIndex/") &&
    data.workId === result.workId && data.titleKey === "new book"), true);

  // An ISBN the catalog already has resolves to the canonical work and the
  // surviving edition — one merge hop followed on each — and creates nothing.
  created.length = 0;
  const existing = await deployed.catalog.create.run({
    work, edition: {...edition, isbn13: "9780000000002"},
  }, authContext);
  assert.deepEqual(existing, {workId: "canonical-work", editionId: "surviving-edition", created: false});
  assert.deepEqual(created, []);

  // A client that loaded its author list before an admin merge still
  // names the absorbed author: the work is written with the survivor.
  rows.set("catalogAuthors/ada", {...activeAuthor("Ada Lovelace"), status: "merged", mergedInto: "lovelace"});
  rows.set("catalogAuthors/lovelace", {...activeAuthor("Ada Lovelace"), mergedFrom: ["ada"]});
  const resolved = await deployed.catalog.create.run({
    work: {...work, authorIds: ["ada", "lovelace"]}, edition,
  }, authContext);
  assert.deepEqual(rows.get(`works/${resolved.workId}`)?.authorIds, ["lovelace"]);

  // A chain (the merge transaction flattens them, so this is corruption)
  // is refused rather than followed.
  rows.set("catalogAuthors/lovelace", {
    ...activeAuthor("Ada Lovelace"), status: "merged", mergedInto: "elsewhere",
  });
  await assert.rejects(
    deployed.catalog.create.run({work, edition}, authContext),
    (error) => error instanceof Error && /not one hop at catalogAuthors\/ada/.test(error.message),
  );
});

// The admin scan reads the index collections whole and hard-fails past
// their caps, so creation must refuse before an ISBN or external-id row
// would cross a bound — works and editions staying under theirs is not
// enough (one request may carry two external IDs, so the external index
// can reach its cap while works sit at half theirs).
test("creation refuses when an index collection would cross its bound", async (t) => {
  const rows = new Map<string, Row>([["catalogAuthors/ada", activeAuthor("Ada Lovelace")]]);
  for (let position = 0; position < 999; position += 1) {
    rows.set(`externalIdIndex/pad-${position}`, {});
    rows.set(`isbnIndex/${9780000000000 + position}`, {});
  }
  const ref = (path: string): Ref => ({path, id: path.slice(path.lastIndexOf("/") + 1)});
  const snap = (reference: Ref) => ({
    exists: rows.has(reference.path), id: reference.id, ref: reference,
    data: () => rows.get(reference.path),
    get: (field: string) => rows.get(reference.path)?.[field],
  });
  let created = 0;
  t.mock.method(db, "doc", (path: string) => ref(path));
  t.mock.method(db, "collection", (name: string) => {
    if (name === "users") return liveUserCollection();
    return {
      doc: (id: string) => ref(`${name}/${id}`),
      count: () => ({kind: "count", name}),
    };
  });
  t.mock.method(db, "runTransaction", async (handler: Handler<{
    get(value: {kind: string; name: string} | Ref): Promise<unknown>;
    create(): void;
  }>) => handler({
    get: async (value: {kind: string; name: string} | Ref) => {
      if ("kind" in value) {
        return {data: () => ({count: [...rows.keys()].filter((path) => path.startsWith(`${value.name}/`)).length})};
      }
      return snap(value);
    },
    create: () => {
      created += 1;
    },
  }));
  const work = {
    canonicalTitle: "A New Book", alternateTitles: [], authorIds: ["ada"],
    coverUrl: "", subjects: [], fiction: null,
    language: "",
  };
  const edition = {
    isbn13: null, title: "A New Book", publisher: "", publishedDate: "", language: "",
    translatorNames: [], format: "unknown", suggestedPageCount: 300, coverUrl: "", externalIds: {},
  };
  // 999 external rows + 2 new IDs would cross the 1000 bound.
  await assert.rejects(
    deployed.catalog.create.run({work, edition: {...edition, externalIds: {
      "open-library": "OL1", "google-books": "GB1",
    }}}, authContext),
    (error) => hasCode(error, "resource-exhausted"),
  );
  // One new ID fits exactly; the same request must go through.
  const fits = await deployed.catalog.create.run({work, edition: {...edition, externalIds: {
    "open-library": "OL1",
  }}}, authContext);
  assert.equal(fits.created, true);
  assert.ok(created > 0);
  // The ISBN index is one row from its bound: fill it and the next
  // ISBN-carrying creation must refuse.
  rows.set(`isbnIndex/${9780000000999}`, {});
  await assert.rejects(
    deployed.catalog.create.run({
      work, edition: {...edition, isbn13: "9780306406157"},
    }, authContext),
    (error) => hasCode(error, "resource-exhausted"),
  );
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
    language: "",
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
  const bookSnap = (
    uid: string, owner: {path: string}, id: string, overrides: Row = {},
  ) => snap(`users/${uid}/books/${id}`, {
    owner,
    finished: true,
    finishedAt: Timestamp.fromDate(new Date("2026-08-20T20:00:00.000Z")),
    pageCount: 300,
    editionId: "edition-one",
    email: `${uid}@example.test`,
    ...overrides,
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
  // Sharing is on by default; the setting only carries the time zone and
  // an opt-out. The stale projection rows below belong to readers who
  // opted out, so consent must be re-checked live to exclude them.
  const settings: Record<string, Row | undefined> = {
    "users/shared-reader/settings/bookSharing": {
      enabled: true,
      timeZone: "America/Los_Angeles",
    },
    ...Object.fromEntries(Array.from({length: 10}, (_, index) => [
      `users/revoked-reader-${String(index).padStart(2, "0")}/settings/bookSharing`,
      {enabled: false, timeZone: "UTC"},
    ])),
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
          id === "hidden-work" ? {...workData, status: "hidden"} :
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
    if (name === "profileOwners") return {doc: (uid: string) => ({
      get: async () => snap(`profileOwners/${uid}`, uid === "shared-reader" ? {username: "ada-reader"} : undefined),
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
          // A finished book without its finishedAt stamp is malformed
          // (every finished book carries one since the backfill) and is
          // omitted like the bad owner, never dated from its history.
          const visibleBooks = malformedBook ? [
            ...books,
            bookSnap("shared-reader", {path: "users/other"}, "invalid-owner"),
            bookSnap("shared-reader", sharedOwner, "unstamped", {finishedAt: undefined}),
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
    language: "",
    mergedFrom: ["old-work"],
  });
  assert.deepEqual(Object.keys(result.editions[0]).sort(), [
    "coverUrl", "editionId", "format", "isbn13", "language",
    "publishedDate", "publisher", "suggestedPageCount", "title",
    "translatorNames", "workId",
  ]);
  assert.deepEqual(result.attempts, [{
    readerKey: "ada-reader",
    username: "ada-reader",
    displayName: "Ada Reader",
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
  assert.equal(malformedBookResult.omittedAttempts, 2);
  assert.equal(malformedBookResult.attempts.length, 1);
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
  for (const hiddenId of ["missing-work", "hidden-work", "broken-work"]) {
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

// The add-book flow adds an edition to a work it matched by title, so the
// book it saves stands on an edition of that work; the edition records the
// account, identifiers already in the catalog resolve instead of writing,
// and a hidden or missing work is not found.
test("users add an edition to an existing work and resolve an indexed identifier instead", async (t) => {
  const workRow = (title: string, overrides: Row = {}): Row => ({
    canonicalTitle: title, alternateTitles: [], titleKeys: [title.toLowerCase()], authorIds: ["ada"],
    coverUrl: "", subjects: [], fiction: true, status: "active", mergedFrom: [], ...overrides,
    language: "",
  });
  const rows = new Map<string, Row>([
    ["catalogAuthors/ada", activeAuthor("Ada Lovelace")],
    ["works/sheep", workRow("A Wild Sheep Chase", {mergedFrom: ["old-sheep"]})],
    ["works/old-sheep", workRow("Sheep", {status: "merged", mergedInto: "sheep"})],
    ["works/hidden", workRow("Hidden", {status: "hidden"})],
    ["isbnIndex/9780000000002", {workId: "sheep", editionId: "seeded"}],
    ["editions/seeded", {
      workId: "sheep", isbn13: "9780000000002", title: "Seeded", publisher: "", publishedDate: "",
      language: "", translatorNames: [], format: "unknown", suggestedPageCount: null, coverUrl: "",
      externalIds: {}, status: "merged", mergedInto: "seeded-survivor",
    }],
    ["editions/seeded-survivor", {
      workId: "sheep", isbn13: null, title: "Survivor", publisher: "", publishedDate: "",
      language: "", translatorNames: [], format: "unknown", suggestedPageCount: null, coverUrl: "",
      externalIds: {}, mergedFrom: ["seeded"],
    }],
  ]);
  const ref = (path: string): Ref => ({path, id: path.slice(path.lastIndexOf("/") + 1)});
  const snap = (reference: Ref) => ({
    exists: rows.has(reference.path), id: reference.id, ref: reference,
    data: () => rows.get(reference.path),
    get: (field: string) => rows.get(reference.path)?.[field],
  });
  const created: Array<{path: string; data: Row}> = [];
  t.mock.method(db, "doc", (path: string) => ref(path));
  t.mock.method(db, "collection", (name: string) => {
    if (name === "users") return liveUserCollection();
    return {
      doc: (id: string) => ref(`${name}/${id}`),
      count: () => ({kind: "count", name}),
    };
  });
  t.mock.method(db, "runTransaction", async (handler: Handler<{
    get(value: {kind: string; name: string} | Ref): Promise<unknown>;
    create(reference: Ref, data: Row): void;
  }>) => handler({
    get: async (value: {kind: string; name: string} | Ref) => {
      if ("kind" in value) {
        return {data: () => ({count: [...rows.keys()].filter((path) => path.startsWith(`${value.name}/`)).length})};
      }
      return snap(value);
    },
    create: (reference: Ref, data: Row) => {
      assert.equal(rows.has(reference.path), false, reference.path);
      rows.set(reference.path, data);
      created.push({path: reference.path, data});
    },
  }));
  const edition = {
    isbn13: null, title: "Vilda fårjakten", publisher: "Norstedts", publishedDate: "1987", language: "",
    translatorNames: [], format: "unknown", suggestedPageCount: 280, coverUrl: "", externalIds: {},
  };
  // A merged alias resolves to its survivor and the edition lands there.
  const result = await deployed.catalog.addedition.run({workId: "old-sheep", edition}, authContext);
  assert.equal(result.created, true);
  assert.equal(result.workId, "sheep");
  assert.match(result.editionId, /^edition-/);
  const stored = rows.get(`editions/${result.editionId}`);
  assert.equal(stored?.workId, "sheep");
  assert.equal(stored?.createdBy, "owner");
  assert.equal(stored?.title, "Vilda fårjakten");
  assert.equal(created.length, 1);

  // A new ISBN gets its index row; an indexed one resolves without writing.
  created.length = 0;
  const withIsbn = await deployed.catalog.addedition.run({
    workId: "sheep", edition: {...edition, isbn13: "9780000000019"},
  }, authContext);
  assert.deepEqual(rows.get("isbnIndex/9780000000019"), {workId: "sheep", editionId: withIsbn.editionId});
  created.length = 0;
  assert.deepEqual(await deployed.catalog.addedition.run({
    workId: "sheep", edition: {...edition, isbn13: "9780000000002"},
  }, authContext), {workId: "sheep", editionId: "seeded-survivor", created: false});
  assert.deepEqual(created, []);

  // A hidden or missing work is not found, and nothing is written.
  for (const workId of ["hidden", "nowhere"]) {
    await assert.rejects(
      deployed.catalog.addedition.run({workId, edition}, authContext),
      (error) => error instanceof Error && (error as {code?: unknown}).code === "not-found",
    );
  }
  assert.deepEqual(created, []);
});
