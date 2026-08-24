const assert = require("node:assert/strict");
const test = require("node:test");
const {getFirestore, Timestamp} = require("firebase-admin/firestore");

process.env.GCLOUD_PROJECT = "book-tracker-d8f24";

const decoders = require("../lib/decoders");
const deployed = require("../lib");
const db = getFirestore();

const authContext = {auth: {uid: "owner", token: {}}};

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
    error: undefined,
  });
  const stop = {
    ...create,
    type: "stop",
    entryId: 42,
  };
  assert.equal(decoders.decodeTogglQueueDocument(stop).entryId, 42);
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
  assert.throws(
    () => decoders.decodeTogglQueueDocument({
      ...create,
      attempts: 1,
      claimedAt,
    }),
    /retry request time/,
  );
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
    (error) => error.code === "invalid-argument",
  );
  await assert.rejects(
    deployed.toggl.start.run({bookId: "book/updates/x"}, authContext),
    (error) => error.code === "invalid-argument",
  );
  await assert.rejects(
    deployed.toggl.stop.run({bookId: 7}, authContext),
    (error) => error.code === "invalid-argument",
  );
  await assert.rejects(
    deployed.booksapi.lookupisbn.run({isbn: "bad"}, authContext),
    (error) => error.code === "invalid-argument",
  );
  assert.equal(fetchCalls, 0);
});

test("a malformed pending queue item is terminal before fetch", async (t) => {
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run");
  });
  const updates = [];
  const quotaRef = {};
  let quota = {windowStartedAt: Timestamp.now(), count: 9};
  const item = {
    type: "create",
    bookTitle: "Malformed Clock",
    start: "2026-99-99T99:99:99Z",
    stop: "2026-08-24T12:20:00Z",
    status: "pending",
    createdAt: Timestamp.now(),
  };
  const ref = {};
  t.mock.method(db, "doc", (path) => {
    assert.equal(path, "users/owner/functionQuotas/togglQueue");
    return quotaRef;
  });
  t.mock.method(db, "runTransaction", async (handler) => handler({
    get: async (target) => target === ref ?
      {exists: true, data: () => item} :
      {exists: true, data: () => quota},
    update: (target, value) => {
      if (target === ref) updates.push(value);
      else quota = {...quota, ...value};
    },
    set: (target, value) => {
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

  await assert.rejects(
    deployed.toggl.syncqueue.run(event),
    /queue start must be an ISO-8601 timestamp/,
  );
  assert.equal(fetchCalls, 0);
  assert.equal(quota.count, 10);
  assert.deepEqual(updates, [{
    status: "error",
    attempts: 5,
    claimedAt: updates[0].claimedAt,
    expiresAt: updates[0].expiresAt,
    error: "Malformed queue item: queue start must be an ISO-8601 timestamp.",
    retryRequestedAt: updates[0].retryRequestedAt,
  }]);
  assert.ok(updates[0].claimedAt instanceof Timestamp);
  assert.ok(updates[0].expiresAt instanceof Timestamp);
  assert.equal(
    updates[0].expiresAt.toMillis() - updates[0].claimedAt.toMillis(),
    90 * 24 * 60 * 60 * 1000,
  );
  assert.ok(updates[0].retryRequestedAt);
});
