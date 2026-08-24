const assert = require("node:assert/strict");
const test = require("node:test");
const {getFirestore, Timestamp} = require("firebase-admin/firestore");

process.env.GCLOUD_PROJECT = "book-tracker-d8f24";

const deployed = require("../lib");
const db = getFirestore();
const authContext = {auth: {uid: "owner", token: {}}};

function snapshot(data, exists = true) {
  return {exists, data: () => data};
}

function queueItem(overrides = {}) {
  return {
    type: "create",
    bookTitle: "The Book",
    start: "2026-08-24T12:00:00Z",
    stop: "2026-08-24T12:20:00Z",
    status: "pending",
    createdAt: Timestamp.now(),
    ...overrides,
  };
}

function installQueueStore(t, item) {
  const queueUpdates = [];
  const transactionUpdates = [];
  const issues = [];
  const queueRef = {
    update: async (patch) => {
      queueUpdates.push(patch);
    },
  };
  const userRef = {
    get: async () => snapshot({
      toggl: {apiToken: "token", workspaceId: 3, projectId: 4},
    }),
  };
  t.mock.method(db, "doc", (path) => {
    assert.equal(path, "users/owner");
    return userRef;
  });
  t.mock.method(db, "runTransaction", async (handler) => handler({
    get: async (ref) => {
      assert.equal(ref, queueRef);
      return snapshot(item);
    },
    update: (ref, patch) => {
      assert.equal(ref, queueRef);
      transactionUpdates.push(patch);
    },
  }));
  t.mock.method(db, "collection", (path) => {
    assert.equal(path, "logEvents");
    return {add: async (issue) => issues.push(issue)};
  });
  return {
    event: {
      data: {
        after: {
          exists: true,
          data: () => item,
          ref: queueRef,
        },
      },
      params: {uid: "owner", queueId: "queue"},
    },
    issues,
    queueRef,
    queueUpdates,
    transactionUpdates,
  };
}

test("queued creates pass through outcome-unknown before synced", async (t) => {
  const store = installQueueStore(t, queueItem());
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({id: 81}), {status: 200});
  });

  await deployed.toggl.syncqueue.run(store.event);

  assert.equal(fetchCalls, 1);
  assert.equal(store.transactionUpdates[0].status, "processing");
  assert.deepEqual(
    store.queueUpdates.map((patch) => patch.status),
    ["outcome-unknown", "synced"],
  );
  assert.equal(store.queueUpdates[1].entryId, 81);
});

test("a successful create with an invalid response stays outcome-unknown", async (t) => {
  const store = installQueueStore(t, queueItem());
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({created: true}), {status: 200});
  });

  await assert.rejects(
    deployed.toggl.syncqueue.run(store.event),
    /created an entry but its response was invalid/,
  );

  assert.equal(fetchCalls, 1);
  assert.deepEqual(
    store.queueUpdates.map((patch) => patch.status),
    ["outcome-unknown", "outcome-unknown"],
  );
  assert.equal(store.queueUpdates.some((patch) => patch.status === "error"), false);
});

test("a create stays outcome-unknown when the synced write fails", async (t) => {
  const store = installQueueStore(t, queueItem());
  store.queueRef.update = async (patch) => {
    if (patch.status === "synced") throw new Error("durable write failed");
    store.queueUpdates.push(patch);
  };
  t.mock.method(global, "fetch", async () =>
    new Response(JSON.stringify({id: 82}), {status: 200}),
  );

  await assert.rejects(
    deployed.toggl.syncqueue.run(store.event),
    /durable write failed/,
  );

  assert.deepEqual(
    store.queueUpdates.map((patch) => patch.status),
    ["outcome-unknown"],
  );
});

test("queued stop failures are retryable errors", async (t) => {
  const item = queueItem({type: "stop", entryId: 52});
  const store = installQueueStore(t, item);
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    return new Response("failed", {status: 503});
  });

  await assert.rejects(
    deployed.toggl.syncqueue.run(store.event),
    /stop-update failed with status 503/,
  );

  assert.equal(fetchCalls, 1);
  assert.equal(store.queueUpdates.at(-1).status, "error");
  assert.equal(store.issues.length, 1);
});

test("the fifth claimed queue item becomes terminal without fetch", async (t) => {
  const claimedAt = Timestamp.now();
  const item = queueItem({
    attempts: 5,
    claimedAt,
    retryRequestedAt: Timestamp.now(),
  });
  const store = installQueueStore(t, item);
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run");
  });

  await deployed.toggl.syncqueue.run(store.event);

  assert.equal(fetchCalls, 0);
  assert.equal(store.transactionUpdates[0].status, "error");
  assert.match(store.transactionUpdates[0].error, /retry limit/);
  assert.equal(store.queueUpdates.length, 0);
});

function installBooksStore(t, books) {
  const userRef = {
    get: async () => snapshot({
      toggl: {apiToken: "token", workspaceId: 3, projectId: 4},
    }),
  };
  const booksRef = {};
  const bookRefs = new Map(Object.entries(books).map(([id, book]) => [id, {
    id,
    get: async () => snapshot(book),
    update: async (patch) => Object.assign(book, patch),
  }]));
  const bookSnapshot = (id) => ({
    ...snapshot(books[id]),
    id,
    ref: bookRefs.get(id),
  });
  t.mock.method(db, "doc", (path) => {
    if (path === "users/owner") return userRef;
    const prefix = "users/owner/books/";
    assert.ok(path.startsWith(prefix));
    const ref = bookRefs.get(path.slice(prefix.length));
    assert.ok(ref);
    return ref;
  });
  t.mock.method(db, "collection", (path) => {
    assert.equal(path, "users/owner/books");
    return booksRef;
  });
  t.mock.method(db, "runTransaction", async (handler) => handler({
    get: async (ref) => {
      if (ref === booksRef) {
        return {docs: Object.keys(books).map(bookSnapshot)};
      }
      const entry = [...bookRefs.entries()].find(([, bookRef]) => bookRef === ref);
      assert.ok(entry);
      return snapshot(books[entry[0]]);
    },
    update: (ref, patch) => {
      const entry = [...bookRefs.entries()].find(([, bookRef]) => bookRef === ref);
      assert.ok(entry);
      Object.assign(books[entry[0]], patch);
    },
  }));
  return {books, bookRefs};
}

function installBookStore(t, book) {
  const store = installBooksStore(t, {book});
  return {book, bookRef: store.bookRefs.get("book")};
}

test("concurrent starts share a transactional claim and issue one POST", async (t) => {
  const store = installBookStore(t, {title: "The Book", activeTimer: null});
  let fetchCalls = 0;
  let announceFetch;
  let releaseFetch;
  const fetchStarted = new Promise((resolve) => {
    announceFetch = resolve;
  });
  const fetchResponse = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    announceFetch();
    return fetchResponse;
  });

  const first = deployed.toggl.start.run({bookId: "book"}, authContext);
  await fetchStarted;
  await assert.rejects(
    deployed.toggl.start.run({bookId: "book"}, authContext),
    (error) => error.code === "failed-precondition",
  );
  releaseFetch(new Response(JSON.stringify({
    id: 91,
    start: "2026-08-24T12:00:00Z",
  }), {status: 200}));
  assert.deepEqual(await first, {
    entryId: 91,
    start: "2026-08-24T12:00:00Z",
  });

  assert.equal(fetchCalls, 1);
  assert.deepEqual(store.book.activeTimer, {
    entryId: 91,
    start: "2026-08-24T12:00:00Z",
  });
});

test("starts on different books share the user-wide claim", async (t) => {
  const store = installBooksStore(t, {
    first: {title: "First", activeTimer: null},
    second: {title: "Second", activeTimer: null},
  });
  let fetchCalls = 0;
  let announceFetch;
  let releaseFetch;
  const fetchStarted = new Promise((resolve) => {
    announceFetch = resolve;
  });
  const fetchResponse = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    announceFetch();
    return fetchResponse;
  });

  const first = deployed.toggl.start.run({bookId: "first"}, authContext);
  await fetchStarted;
  await assert.rejects(
    deployed.toggl.start.run({bookId: "second"}, authContext),
    (error) => error.code === "failed-precondition" &&
      /another book/.test(error.message),
  );
  releaseFetch(new Response(JSON.stringify({
    id: 92,
    start: "2026-08-24T12:00:00Z",
  }), {status: 200}));
  await first;

  assert.equal(fetchCalls, 1);
  assert.equal(store.books.first.activeTimer.entryId, 92);
  assert.equal(store.books.second.activeTimer, null);
});

test("a stale start claim becomes terminal without another POST", async (t) => {
  const store = installBookStore(t, {
    title: "The Book",
    activeTimer: {
      state: "starting",
      operationId: "old-operation",
      start: "2026-08-24T12:00:00Z",
      claimedAt: Timestamp.fromMillis(Date.now() - 10 * 60 * 1000),
    },
  });
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run");
  });

  await assert.rejects(
    deployed.toggl.start.run({bookId: "book"}, authContext),
    (error) => error.code === "failed-precondition",
  );

  assert.equal(fetchCalls, 0);
  assert.equal(store.book.activeTimer.state, "outcome-unknown");
});

test("an explicit start rejection clears its claim", async (t) => {
  const store = installBookStore(t, {title: "The Book", activeTimer: null});
  t.mock.method(global, "fetch", async () =>
    new Response("rejected", {status: 503}),
  );

  await assert.rejects(
    deployed.toggl.start.run({bookId: "book"}, authContext),
    /start failed with status 503/,
  );

  assert.equal(store.book.activeTimer, null);
});

test("an ambiguous start network failure becomes outcome-unknown", async (t) => {
  const store = installBookStore(t, {title: "The Book", activeTimer: null});
  t.mock.method(global, "fetch", async () => {
    throw new Error("socket closed");
  });

  await assert.rejects(
    deployed.toggl.start.run({bookId: "book"}, authContext),
    /socket closed/,
  );

  assert.equal(store.book.activeTimer.state, "outcome-unknown");
  assert.match(store.book.activeTimer.error, /socket closed/);
});

test("stop decodes activeTimer without requiring a title", async (t) => {
  const store = installBookStore(t, {
    activeTimer: {
      entryId: 12,
      start: "2026-08-24T12:00:00Z",
    },
  });
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({duration: 90}), {status: 200});
  });

  assert.deepEqual(
    await deployed.toggl.stop.run({bookId: "book"}, authContext),
    {seconds: 90, minutes: 2},
  );
  assert.equal(fetchCalls, 1);
  assert.equal(store.book.activeTimer, null);
});

test("savetoken validates Toggl responses and stores the selected project", async (t) => {
  const writes = [];
  const userRef = {set: async (value, options) => writes.push({value, options})};
  t.mock.method(db, "doc", (path) => {
    assert.equal(path, "users/owner");
    return userRef;
  });
  const requested = [];
  t.mock.method(global, "fetch", async (url) => {
    requested.push(url);
    if (url.endsWith("/me")) return new Response("{}", {status: 200});
    return new Response(JSON.stringify([{
      id: 7,
      workspace_id: 6,
      name: "Reading",
    }]), {status: 200});
  });

  assert.deepEqual(
    await deployed.toggl.savetoken.run({token: "valid-token"}, authContext),
    {workspaceId: 6, projectId: 7},
  );
  assert.deepEqual(writes, [{
    value: {
      toggl: {apiToken: "valid-token", workspaceId: 6, projectId: 7},
    },
    options: {merge: true},
  }]);
  assert.equal(requested.length, 2);
});
