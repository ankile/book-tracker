require("./setup.cjs");

const assert = require("node:assert/strict");
const test = require("node:test");
const {FieldValue, getFirestore, Timestamp} = require("firebase-admin/firestore");

const deployed = require("../lib");
const db = getFirestore();
const authContext = {auth: {uid: "owner", token: {}}};

function snapshot(data, exists = true) {
  return {exists, data: () => data};
}

function enableFunctionsEmulator(t) {
  const previous = process.env.FUNCTIONS_EMULATOR;
  process.env.FUNCTIONS_EMULATOR = "true";
  t.after(() => {
    if (previous === undefined) {
      delete process.env.FUNCTIONS_EMULATOR;
    } else {
      process.env.FUNCTIONS_EMULATOR = previous;
    }
  });
  t.mock.method(global, "fetch", async () => {
    throw new Error("The Functions emulator must not make an outbound fetch.");
  });
}

function queueItem(overrides = {}) {
  return {
    type: "create",
    bookId: "book",
    bookTitle: "The Book",
    start: "2026-08-24T12:00:00Z",
    stop: "2026-08-24T12:20:00Z",
    status: "pending",
    createdAt: Timestamp.now(),
    ...overrides,
  };
}

function installQueueStore(t, item, {quota} = {}) {
  const queueUpdates = [];
  const transactionUpdates = [];
  const quotaWrites = [];
  const issues = [];
  let queueDeleted = false;
  let configReads = 0;
  let quotaValue = quota;
  const queueRef = {
    update: async (patch) => {
      queueUpdates.push(patch);
    },
    delete: async () => {
      queueDeleted = true;
    },
  };
  const userRef = {
    get: async () => {
      configReads += 1;
      return snapshot({
        toggl: {apiToken: "token", workspaceId: 3, projectId: 4},
      });
    },
  };
  const quotaRef = {};
  t.mock.method(db, "doc", (path) => {
    if (path === "users/owner") return userRef;
    assert.equal(path, "users/owner/functionQuotas/togglQueue");
    return quotaRef;
  });
  t.mock.method(db, "runTransaction", async (handler) => handler({
    get: async (ref) => {
      if (ref === queueRef) return snapshot(item);
      assert.equal(ref, quotaRef);
      return snapshot(quotaValue, quotaValue !== undefined);
    },
    update: (ref, patch) => {
      if (ref === queueRef) {
        transactionUpdates.push(patch);
      } else {
        assert.equal(ref, quotaRef);
        quotaValue = {...quotaValue, ...patch};
        quotaWrites.push({type: "update", value: patch});
      }
    },
    set: (ref, value) => {
      assert.equal(ref, quotaRef);
      quotaValue = value;
      quotaWrites.push({type: "set", value});
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
    get configReads() {
      return configReads;
    },
    get queueDeleted() {
      return queueDeleted;
    },
    get quota() {
      return quotaValue;
    },
    quotaWrites,
    queueUpdates,
    transactionUpdates,
  };
}

function installCorrelatedStopStore(t, mode) {
  const start = "2026-08-24T12:00:00Z";
  const queueId = `book_${start}`;
  const item = queueItem({
    type: "stop",
    bookId: "book",
    timerClaimVersion: 1,
    entryId: 52,
    start,
  });
  const queueRef = {
    get: async () => snapshot(item),
    delete: async () => {
      if (mode === "final-delete-fails" || mode === "lost-ack-delete-fails") {
        throw new Error("terminal queue cleanup failed");
      }
      queueRef.deleted = true;
    },
    deleted: false,
  };
  const bookRef = {};
  const claimRef = {};
  const quotaRef = {};
  const userRef = {
    get: async () => snapshot({
      toggl: {apiToken: "token", workspaceId: 3, projectId: 4},
    }),
  };
  const issues = [];
  let transactionNumber = 0;
  t.mock.method(db, "doc", (path) => {
    if (path === "users/owner") return userRef;
    if (path === "users/owner/functionQuotas/togglQueue") return quotaRef;
    if (path === "users/owner/books/book") return bookRef;
    if (path === "users/owner/timerLifecycle/current") return claimRef;
    throw new Error(`Unexpected document path ${path}`);
  });
  t.mock.method(db, "collection", (path) => {
    assert.equal(path, "logEvents");
    return {add: async (issue) => issues.push(issue)};
  });
  t.mock.method(db, "runTransaction", async (handler) => {
    transactionNumber += 1;
    if (transactionNumber === 1) {
      return handler({
        get: async (ref) => {
          if (ref === queueRef) return snapshot(item);
          assert.equal(ref, quotaRef);
          return snapshot(undefined, false);
        },
        set: () => {},
        update: (ref, patch) => {
          if (ref === queueRef) Object.assign(item, patch);
        },
      });
    }
    if (transactionNumber === 2) {
      if (mode === "recovery-write-fails") {
        return handler({
          get: async (ref) => {
            if (ref === queueRef) return snapshot(item);
            if (ref === bookRef) {
              return snapshot({
                title: "The Book",
                activeTimer: {state: "stopping", entryId: 52, start, queueId},
              });
            }
            assert.equal(ref, claimRef);
            return snapshot({
              version: 1,
              state: "remote",
              bookId: "other-book",
              entryId: 999,
              start,
            });
          },
          update: () => {},
          set: () => {},
        });
      }
      await handler({
        get: async (ref) => {
          if (ref === queueRef) return snapshot(item);
          if (ref === bookRef) {
            return snapshot({
              title: "The Book",
              activeTimer: {state: "stopping", entryId: 52, start, queueId},
            });
          }
          assert.equal(ref, claimRef);
          return snapshot({
            version: 1,
            state: "stopping",
            bookId: "book",
            entryId: 52,
            start,
            queueId,
          });
        },
        update: (ref, patch) => {
          if (ref === queueRef) Object.assign(item, patch);
        },
        set: () => {},
      });
      if (mode === "lost-ack" || mode === "lost-ack-delete-fails") {
        throw new Error("commit acknowledgement lost");
      }
      return undefined;
    }
    if (mode === "recovery-write-fails") {
      throw new Error("recovery storage unavailable");
    }
    return handler({
      get: async (ref) => {
        assert.equal(ref, queueRef);
        return snapshot(item);
      },
      update: () => {},
    });
  });
  return {
    event: {
      data: {after: {exists: true, data: () => item, ref: queueRef}},
      params: {uid: "owner", queueId},
    },
    issues,
    item,
    queueRef,
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
  assert.equal(store.queueDeleted, true);
  assert.equal(store.quota.count, 1);
});

test("the Functions emulator syncs a queued create without outbound fetch", async (t) => {
  enableFunctionsEmulator(t);
  const store = installQueueStore(t, queueItem());

  await deployed.toggl.syncqueue.run(store.event);

  assert.deepEqual(
    store.queueUpdates.map((patch) => patch.status),
    ["outcome-unknown", "synced"],
  );
  assert.equal(store.queueUpdates.at(-1).entryId, 900003);
  assert.equal(store.queueDeleted, true);
});

test("the Functions emulator still syncs a legacy queue row without bookId", async (t) => {
  enableFunctionsEmulator(t);
  const legacyItem = queueItem();
  delete legacyItem.bookId;
  const store = installQueueStore(t, legacyItem);

  await deployed.toggl.syncqueue.run(store.event);

  assert.equal(store.queueUpdates.at(-1).status, "synced");
  assert.equal(store.queueDeleted, true);
});

test("the handler repairs legacy pending retry metadata and oversized errors", async (t) => {
  enableFunctionsEmulator(t);
  const store = installQueueStore(t, queueItem({
    attempts: 1,
    claimedAt: Timestamp.now(),
    error: "x".repeat(2000),
  }));

  await deployed.toggl.syncqueue.run(store.event);

  assert.equal(store.transactionUpdates[0].status, "processing");
  assert.equal(store.transactionUpdates[0].attempts, 2);
  assert.ok(Object.hasOwn(store.transactionUpdates[0], "error"));
  assert.equal(store.queueUpdates.at(-1).status, "synced");
  assert.equal(store.queueDeleted, true);
});

test("the Functions emulator syncs a queued stop without outbound fetch", async (t) => {
  enableFunctionsEmulator(t);
  const store = installQueueStore(t, queueItem({type: "stop", entryId: 52}));

  await deployed.toggl.syncqueue.run(store.event);

  assert.equal(store.queueUpdates.at(-1).status, "synced");
  assert.equal(store.queueUpdates.at(-1).entryId, 52);
  assert.equal(store.queueDeleted, true);
});

test("a lost correlated-stop commit acknowledgement cleans the synced row", async (t) => {
  const store = installCorrelatedStopStore(t, "lost-ack");
  t.mock.method(global, "fetch", async () => new Response("", {status: 200}));

  await deployed.toggl.syncqueue.run(store.event);

  assert.equal(store.queueRef.deleted, true);
  assert.deepEqual(store.issues, []);
});

test("a failed correlated-stop cleanup retains a finite terminal expiry", async (t) => {
  const store = installCorrelatedStopStore(t, "final-delete-fails");
  t.mock.method(global, "fetch", async () => new Response("", {status: 200}));

  await assert.rejects(
    deployed.toggl.syncqueue.run(store.event),
    /terminal queue cleanup failed/,
  );

  assert.equal(store.item.status, "synced");
  assert.ok(store.item.expiresAt instanceof Timestamp);
});

test("a lost acknowledgement plus failed cleanup retains terminal expiry", async (t) => {
  const store = installCorrelatedStopStore(t, "lost-ack-delete-fails");
  const consoleErrors = [];
  t.mock.method(console, "error", (...args) => consoleErrors.push(args));
  t.mock.method(global, "fetch", async () => new Response("", {status: 200}));

  await assert.rejects(
    deployed.toggl.syncqueue.run(store.event),
    /commit acknowledgement lost/,
  );

  assert.equal(store.item.status, "synced");
  assert.ok(store.item.expiresAt instanceof Timestamp);
  assert.match(String(consoleErrors[0]?.[0]), /persist Toggl stop recovery state/);
});

test("a failed correlated-stop recovery logs and preserves the original error", async (t) => {
  const store = installCorrelatedStopStore(t, "recovery-write-fails");
  const consoleErrors = [];
  t.mock.method(console, "error", (...args) => consoleErrors.push(args));
  t.mock.method(global, "fetch", async () => new Response("", {status: 200}));

  await assert.rejects(
    deployed.toggl.syncqueue.run(store.event),
    /no longer matches the active timer claim/,
  );

  assert.equal(store.issues.length, 1);
  assert.equal(store.issues[0].event, "toggl.sync_failed");
  assert.match(store.issues[0].message, /no longer matches/);
  assert.match(String(consoleErrors[0]?.[0]), /persist Toggl stop recovery state/);
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

test("a queued create 5xx stays outcome-unknown", async (t) => {
  const store = installQueueStore(t, queueItem());
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () =>
    (fetchCalls += 1,
    new Response("gateway failed after forwarding", {status: 503})),
  );

  await assert.rejects(
    deployed.toggl.syncqueue.run(store.event),
    /create failed with status 503/,
  );

  assert.deepEqual(
    store.queueUpdates.map((patch) => patch.status),
    ["outcome-unknown", "outcome-unknown"],
  );
  assert.equal(fetchCalls, 1);
  assert.equal(store.queueUpdates.some((patch) => patch.status === "error"), false);
});

test("a queued create transport failure stays outcome-unknown", async (t) => {
  const store = installQueueStore(t, queueItem());
  t.mock.method(global, "fetch", async () => {
    throw new Error("socket closed");
  });

  await assert.rejects(deployed.toggl.syncqueue.run(store.event), /socket closed/);
  assert.deepEqual(
    store.queueUpdates.map((patch) => patch.status),
    ["outcome-unknown", "outcome-unknown"],
  );
});

test("a queued create definite 4xx becomes retryable", async (t) => {
  const store = installQueueStore(t, queueItem());
  t.mock.method(global, "fetch", async () =>
    new Response("rejected", {status: 422}),
  );

  await assert.rejects(
    deployed.toggl.syncqueue.run(store.event),
    /create failed with status 422/,
  );
  assert.deepEqual(
    store.queueUpdates.map((patch) => patch.status),
    ["outcome-unknown", "error"],
  );
});

test("an outcome-unknown queue event never calls Toggl", async (t) => {
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run");
  });
  await deployed.toggl.syncqueue.run({
    data: {
      after: {
        exists: true,
        data: () => queueItem({status: "outcome-unknown"}),
      },
    },
    params: {uid: "owner", queueId: "queue"},
  });
  assert.equal(fetchCalls, 0);
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

test("a correlated stopping claim never loses its recovery row to TTL", async (t) => {
  const item = queueItem({
    type: "stop",
    bookId: "book",
    timerClaimVersion: 1,
    entryId: 52,
    attempts: 5,
    claimedAt: Timestamp.now(),
  });
  const store = installQueueStore(t, item);

  await deployed.toggl.syncqueue.run(store.event);

  assert.equal(store.transactionUpdates[0].status, "error");
  assert.deepEqual(store.transactionUpdates[0].expiresAt, FieldValue.delete());
});

test("a malformed correlated stop still keeps its recovery row TTL-immune", async (t) => {
  const item = queueItem({
    type: "stop",
    bookId: "book",
    timerClaimVersion: 1,
    entryId: 52,
    bookTitle: 42,
  });
  const store = installQueueStore(t, item);

  await assert.rejects(
    deployed.toggl.syncqueue.run(store.event),
    /book title must be a non-empty string/,
  );

  assert.equal(store.transactionUpdates[0].status, "error");
  assert.deepEqual(store.transactionUpdates[0].expiresAt, FieldValue.delete());
});

test("queue quota increments, resets, and blocks remote work", async (t) => {
  const active = installQueueStore(t, queueItem(), {
    quota: {windowStartedAt: Timestamp.now(), count: 9},
  });
  t.mock.method(global, "fetch", async () =>
    new Response(JSON.stringify({id: 83}), {status: 200}),
  );
  await deployed.toggl.syncqueue.run(active.event);
  assert.equal(active.quota.count, 10);
  assert.equal(active.quotaWrites[0].type, "update");
});

test("an expired queue quota resets before remote work", async (t) => {
  const expired = installQueueStore(t, queueItem(), {
    quota: {
      windowStartedAt: Timestamp.fromMillis(Date.now() - 2 * 60 * 60 * 1000),
      count: 10,
    },
  });
  t.mock.method(global, "fetch", async () =>
    new Response(JSON.stringify({id: 84}), {status: 200}),
  );
  await deployed.toggl.syncqueue.run(expired.event);
  assert.equal(expired.quota.count, 1);
  assert.equal(expired.quotaWrites[0].type, "set");
});

test("an exhausted queue quota defers without consuming an attempt", async (t) => {
  const store = installQueueStore(t, queueItem(), {
    quota: {windowStartedAt: Timestamp.now(), count: 10},
  });
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run");
  });

  await assert.rejects(
    deployed.toggl.syncqueue.run(store.event),
    /Eventarc will retry/,
  );
  assert.equal(fetchCalls, 0);
  assert.equal(store.configReads, 0);
  assert.deepEqual(store.transactionUpdates, []);
  assert.deepEqual(store.quotaWrites, []);
  assert.equal(store.queueUpdates.length, 0);
});

test("quota deferral preserves a pending item's existing retry budget", async (t) => {
  const claimedAt = Timestamp.now();
  const item = queueItem({
    attempts: 4,
    claimedAt,
    retryRequestedAt: Timestamp.now(),
    error: "previous failure",
  });
  const store = installQueueStore(t, item, {
    quota: {windowStartedAt: Timestamp.now(), count: 10},
  });
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run");
  });

  await assert.rejects(
    deployed.toggl.syncqueue.run(store.event),
    /Eventarc will retry/,
  );
  assert.deepEqual(store.transactionUpdates, []);
  assert.deepEqual(store.quotaWrites, []);
  assert.equal(fetchCalls, 0);
  assert.equal(item.attempts, 4);
  assert.equal(item.claimedAt, claimedAt);
});

test("a malformed queue quota fails closed without fetch", async (t) => {
  const store = installQueueStore(t, queueItem(), {
    quota: {windowStartedAt: Timestamp.now(), count: "ten"},
  });
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run");
  });

  await assert.rejects(
    deployed.toggl.syncqueue.run(store.event),
    /quota has invalid values/,
  );
  assert.equal(fetchCalls, 0);
  assert.equal(store.configReads, 0);
});

test("a failed terminal cleanup leaves a durable synced queue item", async (t) => {
  const store = installQueueStore(t, queueItem());
  store.queueRef.delete = async () => {
    throw new Error("delete failed");
  };
  t.mock.method(global, "fetch", async () =>
    new Response(JSON.stringify({id: 85}), {status: 200}),
  );

  await assert.rejects(deployed.toggl.syncqueue.run(store.event), /delete failed/);
  assert.equal(store.queueUpdates.at(-1).status, "synced");
  assert.ok(store.transactionUpdates[0].expiresAt instanceof Timestamp);
});

function installBooksStore(t, books) {
  const userRef = {
    get: async () => snapshot({
      toggl: {apiToken: "token", workspaceId: 3, projectId: 4},
    }),
  };
  const active = Object.entries(books).find(([, book]) => book.activeTimer !== null);
  let claim = active === undefined ?
    {version: 1, state: "idle", cleared: null} :
    {version: 1, bookId: active[0], ...active[1].activeTimer};
  if (active !== undefined && !("state" in active[1].activeTimer)) {
    claim = active[1].activeTimer.entryId === undefined ? {
      version: 1,
      state: "local",
      bookId: active[0],
      operationId: active[1].activeTimer.operationId,
      start: active[1].activeTimer.start,
    } : {
      version: 1,
      state: "remote",
      bookId: active[0],
      entryId: active[1].activeTimer.entryId,
      start: active[1].activeTimer.start,
    };
  }
  const claimRef = {id: "current"};
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
    if (path === "users/owner/timerLifecycle/current") return claimRef;
    const prefix = "users/owner/books/";
    assert.ok(path.startsWith(prefix));
    const ref = bookRefs.get(path.slice(prefix.length));
    assert.ok(ref);
    return ref;
  });
  t.mock.method(db, "runTransaction", async (handler) => handler({
    get: async (ref) => {
      if (ref === claimRef) return snapshot(claim, claim !== null);
      const entry = [...bookRefs.entries()].find(([, bookRef]) => bookRef === ref);
      assert.ok(entry);
      return snapshot(books[entry[0]]);
    },
    update: (ref, patch) => {
      const entry = [...bookRefs.entries()].find(([, bookRef]) => bookRef === ref);
      assert.ok(entry);
      Object.assign(books[entry[0]], patch);
    },
    set: (ref, value) => {
      assert.equal(ref, claimRef);
      claim = value;
    },
    delete: (ref) => {
      assert.equal(ref, claimRef);
      claim = null;
    },
  }));
  return {books, bookRefs, get claim() { return claim; }};
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
    new Response("rejected", {status: 400}),
  );

  await assert.rejects(
    deployed.toggl.start.run({bookId: "book"}, authContext),
    /start failed with status 400/,
  );

  assert.equal(store.book.activeTimer, null);
});

test("a start 5xx becomes outcome-unknown", async (t) => {
  const store = installBookStore(t, {title: "The Book", activeTimer: null});
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    return new Response("gateway failed after forwarding", {status: 503});
  });

  await assert.rejects(
    deployed.toggl.start.run({bookId: "book"}, authContext),
    /start failed with status 503/,
  );

  assert.equal(store.book.activeTimer.state, "outcome-unknown");
  assert.match(store.book.activeTimer.error, /status 503/);
  await assert.rejects(
    deployed.toggl.start.run({bookId: "book"}, authContext),
    (error) => error.code === "failed-precondition",
  );
  assert.equal(fetchCalls, 1);
});

test("an ambiguous start network failure becomes outcome-unknown", async (t) => {
  const store = installBookStore(t, {title: "The Book", activeTimer: null});
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("socket closed");
  });

  await assert.rejects(
    deployed.toggl.start.run({bookId: "book"}, authContext),
    /socket closed/,
  );

  assert.equal(store.book.activeTimer.state, "outcome-unknown");
  assert.match(store.book.activeTimer.error, /socket closed/);
  await assert.rejects(
    deployed.toggl.start.run({bookId: "book"}, authContext),
    (error) => error.code === "failed-precondition",
  );
  assert.equal(fetchCalls, 1);
});

test("an invalid start response becomes outcome-unknown and blocks replay", async (t) => {
  const store = installBookStore(t, {title: "The Book", activeTimer: null});
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({created: true}), {status: 200});
  });

  await assert.rejects(
    deployed.toggl.start.run({bookId: "book"}, authContext),
    /entry id/,
  );
  assert.equal(store.book.activeTimer.state, "outcome-unknown");
  await assert.rejects(
    deployed.toggl.start.run({bookId: "book"}, authContext),
    (error) => error.code === "failed-precondition",
  );
  assert.equal(fetchCalls, 1);
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

test("a 404 does not claim the timer was cleared after its identity changed", async (t) => {
  const store = installBookStore(t, {
    activeTimer: {
      entryId: 12,
      start: "2026-08-24T12:00:00Z",
    },
  });
  t.mock.method(global, "fetch", async () => {
    store.book.activeTimer = {
      entryId: 13,
      start: "2026-08-24T12:00:01Z",
    };
    return new Response("missing", {status: 404});
  });

  await assert.rejects(
    deployed.toggl.stop.run({bookId: "book"}, authContext),
    /entry is gone, but its local timer claim changed/,
  );
  assert.equal(store.book.activeTimer.entryId, 13);
});

test("the Functions emulator starts and stops using Firestore state only", async (t) => {
  enableFunctionsEmulator(t);
  const store = installBookStore(t, {title: "The Book", activeTimer: null});

  const started = await deployed.toggl.start.run({bookId: "book"}, authContext);
  assert.equal(started.entryId, 900003);
  assert.deepEqual(store.book.activeTimer, started);

  assert.deepEqual(
    await deployed.toggl.stop.run({bookId: "book"}, authContext),
    {seconds: 60, minutes: 1},
  );
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

test("the Functions emulator saves a deterministic Toggl project without outbound fetch", async (t) => {
  enableFunctionsEmulator(t);
  const writes = [];
  const userRef = {set: async (value, options) => writes.push({value, options})};
  t.mock.method(db, "doc", (path) => {
    assert.equal(path, "users/owner");
    return userRef;
  });

  assert.deepEqual(
    await deployed.toggl.savetoken.run({token: "snapshot-production-token"}, authContext),
    {workspaceId: 900001, projectId: 900002},
  );
  assert.deepEqual(writes, [{
    value: {
      toggl: {
        apiToken: "snapshot-production-token",
        workspaceId: 900001,
        projectId: 900002,
      },
    },
    options: {merge: true},
  }]);
});
