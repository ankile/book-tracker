require("./setup.cts");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test").test = require("node:test");
const {FieldValue, getFirestore, Timestamp}: typeof import("firebase-admin/firestore") = require("firebase-admin/firestore");
const {logger}: typeof import("firebase-functions") = require("firebase-functions");

interface Runnable {
  run(data: unknown, context?: unknown): Promise<unknown>;
}
interface Deployed {
  booksapi: {lookupisbn: Runnable};
  toggl: {
    savetoken: Runnable;
    start: Runnable;
    stop: Runnable;
    syncqueue: Runnable;
  };
}
interface TransactionStub {
  get(target: object): Promise<{exists: boolean; data(): unknown}>;
  update(target: object, value: Record<string, unknown>): void;
  set(target: object, value: Record<string, unknown>): void;
}

const decoders: typeof import("../src/decoders") = require("../lib/decoders");
const deployed: Deployed = require("../lib");
const db = getFirestore();

const authContext = {auth: {uid: "owner", token: {email_verified: true}}};

test("callable request decoders reject malformed and extra fields", () => {
  assert.deepEqual(decoders.decodeSaveTokenRequest({token: "abc"}), {
    token: "abc",
  });
  assert.throws(
    () => decoders.decodeSaveTokenRequest({token: "abc", uid: "other"}),
    /unexpected field "uid"/,
  );
  assert.throws(
    () => decoders.decodeBookCallableRequest({bookId: "book/updates/x"}),
    /one Firestore document id/,
  );
  assert.throws(
    () => decoders.decodeBookCallableRequest({bookId: "📚".repeat(500)}),
    /one Firestore document id/,
  );
  assert.throws(
    () => decoders.decodeIsbnLookupRequest({isbn: "978000000000x"}),
    /checksum-valid ISBN-13/,
  );
  assert.throws(
    () => decoders.decodeIsbnLookupRequest({isbn: "9780000000003"}),
    /checksum-valid ISBN-13/,
  );
  assert.deepEqual(
    decoders.decodeIsbnLookupRequest({isbn: "9780000000002"}),
    {isbn: "9780000000002"},
  );
});

test("catalog request decoders are exact and bounded", () => {
  assert.deepEqual(decoders.decodeCatalogSearchRequest({
    externalId: {provider: "google-books", id: "volume-123"},
  }), {
    externalId: {provider: "google-books", id: "volume-123"},
  });
  for (const broken of [
    {},
    {title: "Book", authorNames: ["Author"], limit: 1000},
    {title: "Bo", authorNames: ["Author"]},
    {title: "b!!", authorNames: ["Author"]},
    {title: "Book"},
    {title: "Book", authorNames: ["!!!"]},
    {externalId: {provider: "Google", id: "volume"}},
    {externalId: {provider: "google-books", id: "volume", extra: true}},
    {title: "Book", authorNames: Array(21).fill("Author")},
  ]) {
    assert.throws(() => decoders.decodeCatalogSearchRequest(broken));
  }
  assert.deepEqual(decoders.decodeEnsureCatalogAuthorsRequest({authors: [{
    canonicalName: "Ada Lovelace", sortName: "Lovelace", kind: "person",
  }]}), {authors: [{canonicalName: "Ada Lovelace", sortName: "Lovelace", kind: "person"}]});
  assert.throws(() => decoders.decodeEnsureCatalogAuthorsRequest({authors: []}));
  assert.throws(
    () => decoders.decodeWorkReadersRequest({workId: "works/catalog"}),
    /one Firestore document id/,
  );
});

test("admin catalog decoders admit only the bounded tagged operations", () => {
  assert.deepEqual(decoders.decodeAdminCatalogScanRequest({}), {bookCursor: null});
  assert.deepEqual(decoders.decodeAdminCatalogScanRequest({
    bookCursor: "users/reader/books/book-one",
  }), {bookCursor: "users/reader/books/book-one"});
  assert.throws(() => decoders.decodeAdminCatalogScanRequest({
    bookCursor: "works/not-a-book",
  }));
  assert.throws(() => decoders.decodeAdminCatalogScanRequest({extra: true}));
  assert.throws(() => decoders.decodeAdminCatalogOperation({
    type: "linkBooks",
    books: [{uid: "reader", bookId: "book"}],
    target: {workId: "w".repeat(101), editionId: null},
  }));
  const work = {
    canonicalTitle: "Catalog Work",
    alternateTitles: [],
    authorIds: ["ada-author"],
    coverUrl: "",
    subjects: [],
    fiction: null,
  };
  const edition = {
    isbn13: null,
    title: "Catalog Work",
    publisher: "",
    publishedDate: "",
    language: "en",
    translatorNames: [],
    format: "full",
    suggestedPageCount: 200,
    coverUrl: "",
    externalIds: {},
  };
  const operations = [
    {
      type: "upsertAuthor", authorId: "ada-author",
      author: {canonicalName: "Ada Author", alternateNames: [], sortName: "Author", kind: "person"},
    },
    {type: "mergeAuthors", sourceAuthorId: "source-author", targetAuthorId: "target-author"},
    {
      type: "createWork", workId: "new-work", visibility: "internal", work,
      books: [{uid: "owner", bookId: "book"}],
    },
    {
      type: "linkBooks", books: [{uid: "owner", bookId: "book"}],
      target: {workId: "work", editionId: null},
    },
    {type: "mergeWorks", sourceWorkIds: ["source"], targetWorkId: "target"},
    {type: "editWork", workId: "work", visibility: "searchable", work},
    {type: "upsertEdition", editionId: "edition", workId: "work", edition},
    {type: "repointIsbn", isbn13: "9780000000002", editionId: "edition"},
  ];
  for (const operation of operations) {
    assert.deepEqual(
      decoders.decodeAdminCatalogPreviewRequest({operation}),
      {operation},
    );
  }
  for (const operation of [
    {...operations[0], path: "users/victim/books/private"},
    {...operations[1], books: Array(101).fill({uid: "owner", bookId: "book"})},
    {type: "mergeWorks", sourceWorkIds: ["same"], targetWorkId: "same"},
    {type: "deleteWork", workId: "work"},
  ]) {
    assert.throws(() => decoders.decodeAdminCatalogPreviewRequest({operation}));
  }
  const operationId = "123e4567-e89b-12d3-a456-426614174000";
  const expected = {
    catalog: [{
      kind: "external-id", id: "index", exists: true, updatedAt: 123,
    }, {
      kind: "title-index", id: "title-index", exists: false, updatedAt: null,
    }],
    books: [{
      uid: "owner", bookId: "book", workId: null, editionId: null,
      matchMethod: null, linkedAt: null, decisionIsbn13: null, decisionAuthorIds: null,
    }],
  };
  assert.deepEqual(decoders.decodeAdminCatalogApplyRequest({
    operationId,
    operation: operations[1],
    expected,
  }), {operationId, operation: operations[1], expected});
  const bookVersion = expected.books[0];
  assert.doesNotThrow(() => decoders.decodeAdminCatalogApplyRequest({
    operationId,
    operation: operations[1],
    expected: {...expected, books: Array.from({length: 200}, (_, index) => ({
      ...bookVersion, bookId: `book-${index}`,
    }))},
  }));
  assert.throws(() => decoders.decodeAdminCatalogApplyRequest({
    operationId,
    operation: operations[1],
    expected: {...expected, books: Array.from({length: 201}, (_, index) => ({
      ...bookVersion, bookId: `book-${index}`,
    }))},
  }), /at most 200/);
  assert.throws(() => decoders.decodeAdminCatalogApplyRequest({
    operationId,
    operation: operations[1],
    expected,
    arbitraryPatch: {activeTimer: null},
  }));
});

test("public profile and discovery decoders pin their published shapes", () => {
  const updatedAt = Timestamp.now();
  const profile = {
    uid: "owner",
    public: true,
    givenName: "Ada",
    familyName: "Lovelace",
    links: [{type: "github", value: "ada"}],
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
    records: null,
    years: [{year: 2026, count: 10, hours: 80, pages: 3200}],
    days: [{day: "2026-08-20", pagesRead: 120, timeRead: 95, sessions: 1}],
    updatedAt,
  };
  assert.deepEqual(decoders.decodePublicProfile("ada-lovelace", profile), {
    username: "ada-lovelace",
    uid: "owner",
    public: true,
    givenName: "Ada",
    familyName: "Lovelace",
    links: [{type: "github", value: "ada"}],
    stats: profile.stats,
    records: null,
    years: profile.years,
    days: profile.days,
    updatedAt,
  });
  const records = {
    momentum: {recentPagesPerDay: 40, lifetimePagesPerDay: 25, ratio: 1.6},
    superlatives: {
      biggestDay: {day: "2026-08-20", pages: 120},
      longestSession: {minutes: 95},
      medianSessionMinutes: 30,
      fastestFinish: {days: 3, pageCount: 300},
    },
  };
  assert.deepEqual(
    decoders.decodePublicProfile("ada-lovelace", {...profile, records}).records,
    records,
  );
  assert.throws(
    () => decoders.decodePublicProfile("ada-lovelace", {
      ...profile,
      records: {
        ...records,
        superlatives: {
          ...records.superlatives,
          longestSession: {minutes: 95, title: "Private book"},
        },
      },
    }),
    /unexpected field "title"/,
  );
  assert.throws(
    () => decoders.decodePublicProfile("ada-lovelace", {...profile, privateTitle: "secret"}),
    /unexpected field "privateTitle"/,
  );
  assert.throws(
    () => decoders.decodePublicProfile("ada-lovelace", {...profile, public: false}),
    /must be public/,
  );

  const marker = {uid: "owner", createdAt: updatedAt};
  assert.deepEqual(decoders.decodeProfileDiscoveryMarker(marker), marker);
  assert.throws(
    () => decoders.decodeProfileDiscoveryMarker({...marker, searchable: true}),
    /unexpected field "searchable"/,
  );
});

test("stored Toggl configuration and timer books are decoded field by field", () => {
  assert.deepEqual(decoders.decodeTogglConfig({
    apiToken: "secret",
    workspaceId: 12,
    projectId: 34,
  }), {
    apiToken: "secret",
    workspaceId: 12,
    projectId: 34,
  });
  assert.deepEqual(decoders.decodeBookForTimer({
    title: "The Book",
    activeTimer: {entryId: 99, start: "2026-08-24T12:00:00Z"},
  }), {
    title: "The Book",
    activeTimer: {entryId: 99, start: "2026-08-24T12:00:00Z"},
  });
  const claimedAt = Timestamp.now();
  assert.deepEqual(decoders.decodeActiveTimerFromBook({
    title: null,
    activeTimer: {
      state: "starting",
      operationId: "operation",
      start: "2026-08-24T12:00:00Z",
      claimedAt,
    },
  }), {
    state: "starting",
    operationId: "operation",
    start: "2026-08-24T12:00:00Z",
    claimedAt,
  });
  assert.deepEqual(decoders.decodeTimerClaim({
    version: 1,
    state: "stopping",
    bookId: "book",
    entryId: 99,
    start: "2026-08-24T12:00:00Z",
    queueId: "book_2026-08-24T12:00:00Z",
  }), {
    version: 1,
    state: "stopping",
    bookId: "book",
    entryId: 99,
    start: "2026-08-24T12:00:00Z",
    queueId: "book_2026-08-24T12:00:00Z",
  });
  assert.throws(
    () => decoders.decodeTimerClaim({
      version: 1,
      state: "idle",
      cleared: {version: 1, state: "idle", cleared: null},
    }),
    /cannot contain another idle claim/,
  );
  assert.throws(
    () => decoders.decodeTimerClaim({
      version: 1,
      state: "local",
      bookId: "book",
      operationId: "x".repeat(101),
      start: "2026-08-24T12:00:00Z",
    }),
    /operation id/,
  );
  assert.throws(
    () => decoders.decodeTogglConfig({
      apiToken: "secret",
      workspaceId: "12",
      projectId: 34,
    }),
    /workspace id must be a finite number/,
  );
  assert.throws(
    () => decoders.decodeBookForTimer({
      title: "The Book",
      activeTimer: {entryId: "99", start: "not-a-date"},
    }),
    /entry id must be a finite number|ISO-8601/,
  );
  for (const start of [
    "2026-02-30T12:00:00.000Z",
    "2025-02-29T12:00:00Z",
    "2026-04-31T12:00:00Z",
    "2026-01-01T24:00:00Z",
  ]) {
    assert.throws(
      () => decoders.decodeBookForTimer({
        title: "The Book",
        activeTimer: {start},
      }),
      /ISO-8601/,
    );
  }
  const precise = "2024-02-29T23:59:59.123456789+05:30";
  assert.deepEqual(decoders.decodeBookForTimer({
    title: "The Book",
    activeTimer: {start: precise},
  }), {
    title: "The Book",
    activeTimer: {start: precise},
  });
});

test("external Toggl and Google responses are runtime checked", () => {
  assert.deepEqual(decoders.decodeTogglProjects([{
    id: 4,
    workspace_id: 3,
    name: "Reading",
    ignored: true,
  }]), [{id: 4, workspaceId: 3, name: "Reading"}]);
  assert.deepEqual(decoders.decodeStartedTogglEntry({
    id: 7,
    start: "2026-08-24T12:00:00+00:00",
  }), {id: 7, start: "2026-08-24T12:00:00+00:00"});
  assert.equal(decoders.decodeStoppedTogglDuration({duration: 90}), 90);
  assert.equal(decoders.decodeCreatedTogglEntryId({id: 8}), 8);
  assert.throws(
    () => decoders.decodeStoppedTogglDuration({duration: "90"}),
    /finite number/,
  );
  assert.throws(
    () => decoders.decodeStartedTogglEntry({
      id: 7,
      start: "August 24, 2026 12:00:00 UTC",
    }),
    /ISO-8601/,
  );

  assert.deepEqual(decoders.decodeBooksApiVolume({
    totalItems: 1,
    items: [{
      volumeInfo: {
        title: "The Book",
        authors: ["Ada Lovelace"],
        pageCount: 320,
        imageLinks: {thumbnail: "https://example.test/cover.jpg"},
      },
    }],
  }), {
    title: "The Book",
    authors: ["Ada Lovelace"],
    pageCount: 320,
    imageLinks: {
      thumbnail: "https://example.test/cover.jpg",
    },
  });
  assert.equal(
    decoders.decodeBooksApiVolume({totalItems: 1, items: []}),
    null,
  );
  assert.deepEqual(decoders.decodeBooksApiVolume({
    totalItems: 1,
    items: [{
      volumeInfo: {
        title: "",
        authors: ["Ada", "", 7],
        publisher: 9,
        pageCount: 0,
        categories: "History",
        imageLinks: {thumbnail: "", smallThumbnail: "https://cover"},
      },
    }],
  }), {
    authors: ["Ada"],
    pageCount: 0,
    imageLinks: {smallThumbnail: "https://cover"},
  });
});

test("queue decoding enforces payload and lifecycle discriminants", () => {
  const createdAt = Timestamp.fromMillis(Date.now() - 60_000);
  const claimedAt = Timestamp.now();
  const create = {
    type: "create",
    bookTitle: "The Book",
    start: "2026-08-24T12:00:00Z",
    stop: "2026-08-24T12:20:00Z",
    status: "pending",
    createdAt,
  };
  assert.deepEqual(decoders.decodeTogglQueueDocument(create), {
    ...create,
    attempts: 0,
    claimedAt: undefined,
    expiresAt: undefined,
    retryRequestedAt: undefined,
    deferredUntil: undefined,
    deferrals: 0,
    error: undefined,
  });
  assert.equal(decoders.decodeTogglQueueDocument({...create, deferrals: 3}).deferrals, 3);
  assert.equal(decoders.decodeTogglQueueDocument({
    ...create, status: "error", attempts: 5, claimedAt, deferrals: 25, error: "capped",
  }).deferrals, 25);
  assert.throws(
    () => decoders.decodeTogglQueueDocument({...create, deferrals: -1}),
    /queue deferrals/,
  );
  // A server deferral stamps a pending row with the end of its quota
  // window; the stamp is cleared on claim, so it is only valid on pending.
  const deferredUntil = Timestamp.fromMillis(Date.now() + 3_600_000);
  assert.equal(
    decoders.decodeTogglQueueDocument({...create, deferredUntil}).deferredUntil,
    deferredUntil,
  );
  assert.throws(
    () => decoders.decodeTogglQueueDocument({...create, deferredUntil: "soon"}),
    /queue deferral time/,
  );
  assert.throws(
    () => decoders.decodeTogglQueueDocument({
      ...create, status: "processing", attempts: 1, claimedAt, deferredUntil,
    }),
    /Only a pending queue item can be deferred/,
  );
  assert.equal(decoders.decodeTogglQueueDocument({
    ...create,
    bookId: "book-123",
  }).bookId, "book-123");
  assert.throws(
    () => decoders.decodeTogglQueueDocument({...create, bookId: "books/123"}),
    /one Firestore document id/,
  );
  const stop = {
    ...create,
    type: "stop",
    entryId: 42,
  };
  const decodedStop = decoders.decodeTogglQueueDocument(stop);
  assert.ok(decodedStop.type === "stop");
  assert.equal(decodedStop.entryId, 42);
  assert.equal(decoders.decodeTogglQueueDocument({
    ...create,
    status: "processing",
    attempts: 1,
    claimedAt,
  }).status, "processing");
  assert.equal(decoders.decodeTogglQueueDocument({
    ...create,
    status: "processing",
    attempts: 1,
    claimedAt,
    expiresAt: claimedAt,
  }).expiresAt, claimedAt);
  assert.equal(decoders.decodeTogglQueueDocument({
    ...create,
    status: "error",
    attempts: 1,
    claimedAt,
    error: "network failed",
  }).status, "error");
  assert.equal(decoders.decodeTogglQueueDocument({
    ...create,
    status: "synced",
    attempts: 1,
    claimedAt,
    entryId: 42,
  }).status, "synced");
  assert.equal(decoders.decodeTogglQueueDocument({
    ...create,
    status: "outcome-unknown",
    attempts: 1,
    claimedAt,
    error: "check Toggl",
  }).status, "outcome-unknown");

  assert.throws(
    () => decoders.decodeTogglQueueDocument({...create, entryId: 42}),
    /unexpected field "entryId"/,
  );
  assert.throws(
    () => decoders.decodeTogglQueueDocument({...create, attempts: 0}),
    /cannot have claim metadata/,
  );
  assert.throws(
    () => decoders.decodeTogglQueueDocument({...create, attempts: 1}),
    /must have claim metadata/,
  );
  assert.equal(decoders.decodeTogglQueueDocument({
    ...create,
    retryRequestedAt: claimedAt,
  }).retryRequestedAt, claimedAt);
  assert.equal(decoders.decodeTogglQueueDocument({
    ...create,
    attempts: 1,
    claimedAt,
  }).retryRequestedAt, undefined);
  const oversizedError = "x".repeat(2000);
  assert.equal(decoders.decodeTogglQueueDocument({
    ...create,
    status: "error",
    attempts: 1,
    claimedAt,
    error: oversizedError,
  }).error, oversizedError);
  assert.throws(
    () => decoders.decodeTogglQueueDocument({
      ...create,
      status: "processing",
      attempts: "1",
      claimedAt,
    }),
    /attempts must be a finite number/,
  );
  assert.throws(
    () => decoders.decodeTogglQueueDocument({
      ...create,
      status: "processing",
      attempts: 1,
      claimedAt,
      expiresAt: "later",
    }),
    /expiry time must be a Firestore timestamp/,
  );
  assert.throws(
    () => decoders.decodeTogglQueueDocument({
      ...create,
      status: "error",
      attempts: 1,
      claimedAt,
    }),
    /must have an error/,
  );
});

test("issue reports are shaped, allowlisted and bounded before storage", () => {
  const valid = {
    level: "error",
    event: "firestore.listener_failed",
    message: "Couldn't load books",
    code: "permission-denied",
  };
  assert.deepEqual(decoders.decodeIssueReport(valid), valid);
  assert.deepEqual(
    decoders.decodeIssueReport({...valid, code: null}),
    {...valid, code: null},
  );
  assert.deepEqual(
    decoders.CLIENT_ISSUE_EVENTS,
    [
      "firestore.listener_failed",
      "firestore.decode_failed",
      "firestore.write_failed",
      "toggl.sync_stuck",
    ],
  );
  const invalidReports: ReadonlyArray<readonly [string, unknown]> = [
    ["server-only event", {...valid, event: "toggl.sync_failed"}],
    ["retired anonymous event", {...valid, event: "auth.sign_in_failed"}],
    ["unknown event", {...valid, event: "anything"}],
    ["non-string event", {...valid, event: 7}],
    ["level outside warn/error", {...valid, level: "info"}],
    ["empty message", {...valid, message: ""}],
    ["oversized message", {...valid, message: "x".repeat(1001)}],
    ["oversized code", {...valid, code: "x".repeat(101)}],
    ["undefined code", {...valid, code: undefined}],
    ["numeric code", {...valid, code: 7}],
    ["missing code", {level: "warn", event: "toggl.sync_stuck", message: "m"}],
    ["detail field", {...valid, detail: {email: "a@example.test"}}],
    ["uid field", {...valid, uid: "someone-else"}],
    ["createdAt field", {...valid, createdAt: "2999-01-01T00:00:00Z"}],
    ["array", [valid]],
    ["null", null],
  ];
  for (const [label, broken] of invalidReports) {
    assert.throws(
      () => decoders.decodeIssueReport(broken),
      decoders.DataDecodeError,
      label,
    );
  }
  assert.throws(
    () => decoders.decodeIssueReport({...valid, event: "auth.sign_in_failed"}, (message) => {
      throw new RangeError(message);
    }),
    RangeError,
  );
});

test("admin issue decoding skips malformed historical rows", () => {
  const createdAt = Timestamp.now();
  assert.deepEqual(decoders.decodeStoredIssue({
    createdAt,
    level: "warn",
    event: "toggl.sync_stuck",
    message: "stuck",
    code: null,
    uid: "owner",
    detail: null,
  }), {
    createdAt,
    level: "warn",
    event: "toggl.sync_stuck",
    message: "stuck",
    code: null,
    uid: "owner",
    detailEmail: null,
  });
  assert.equal(decoders.decodeStoredIssue({
    createdAt: "today",
    level: "warn",
    event: "toggl.sync_stuck",
    message: "stuck",
  }), null);
  assert.equal(decoders.decodeStoredIssue({
    createdAt,
    level: "debug",
    event: "anything",
    message: "stuck",
  }), null);
});

test("malformed callable data is rejected before external requests", async (t) => {
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run");
  });

  await assert.rejects(
    deployed.toggl.savetoken.run({token: ""}, authContext),
    (error) => hasCode(error, "invalid-argument"),
  );
  await assert.rejects(
    deployed.toggl.start.run({bookId: "book/updates/x"}, authContext),
    (error) => hasCode(error, "invalid-argument"),
  );
  await assert.rejects(
    deployed.toggl.stop.run({bookId: 7}, authContext),
    (error) => hasCode(error, "invalid-argument"),
  );
  await assert.rejects(
    deployed.booksapi.lookupisbn.run({isbn: "bad"}, authContext),
    (error) => hasCode(error, "invalid-argument"),
  );
  assert.equal(fetchCalls, 0);
});

test("a malformed pending queue item is terminal before fetch", async (t) => {
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run");
  });
  const updates: Record<string, unknown>[] = [];
  const quotaRef = {};
  let quota: Record<string, unknown> = {windowStartedAt: Timestamp.now(), count: 9};
  const item = {
    type: "create",
    bookTitle: "Malformed Clock",
    start: "2026-99-99T99:99:99Z",
    stop: "2026-08-24T12:20:00Z",
    status: "pending",
    createdAt: Timestamp.now(),
  };
  const ref = {};
  const rowsRef = {};
  let rows: Record<string, unknown> | undefined;
  t.mock.method(db, "doc", (path: string) => {
    if (path === "users/owner/functionQuotas/togglQueueRows") return rowsRef;
    assert.equal(path, "users/owner/functionQuotas/togglQueue");
    return quotaRef;
  });
  t.mock.method(db, "runTransaction", async (handler: (transaction: TransactionStub) => Promise<unknown>) => handler({
    get: async (target: object) => {
      if (target === ref) return {exists: true, data: () => item};
      if (target === rowsRef) return {exists: rows !== undefined, data: () => rows};
      return {exists: true, data: () => quota};
    },
    update: (target: object, value: Record<string, unknown>) => {
      if (target === ref) updates.push(value);
      else if (target === rowsRef) rows = {...rows, ...value};
      else quota = {...quota, ...value};
    },
    set: (target: object, value: Record<string, unknown>) => {
      if (target === rowsRef) {
        rows = value;
        return;
      }
      assert.equal(target, quotaRef);
      quota = value;
    },
  }));
  const event = {
    data: {
      after: {
        exists: true,
        data: () => item,
        ref,
      },
    },
    params: {uid: "owner", queueId: "bad"},
  };

  const errors: unknown[][] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => errors.push(args));
  // Terminal and logged, not thrown: a throw is an Eventarc redelivery.
  await deployed.toggl.syncqueue.run(event);
  assert.deepEqual(errors, [["toggl.queue_malformed", {
    uid: "owner",
    queueId: "bad",
    message: "queue start must be an ISO-8601 timestamp.",
  }]]);
  assert.equal(fetchCalls, 0);
  assert.equal(quota.count, 10);
  assert.deepEqual(updates, [{
    status: "error",
    attempts: 5,
    claimedAt: updates[0].claimedAt,
    expiresAt: updates[0].expiresAt,
    error: "Malformed queue item: queue start must be an ISO-8601 timestamp.",
    retryRequestedAt: updates[0].retryRequestedAt,
    deferredUntil: updates[0].deferredUntil,
  }]);
  assert.deepEqual(updates[0].deferredUntil, FieldValue.delete());
  // Malformed rows are rows: counted against the per-user row bound.
  assert.ok(rows);
  assert.equal(rows.count, 1);
  assert.ok(updates[0].claimedAt instanceof Timestamp);
  assert.ok(updates[0].expiresAt instanceof Timestamp);
  assert.equal(
    updates[0].expiresAt.toMillis() - updates[0].claimedAt.toMillis(),
    90 * 24 * 60 * 60 * 1000,
  );
  assert.ok(updates[0].retryRequestedAt);
});

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}
