require("./setup.cts");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test").test = require("node:test");
const {FieldValue, getFirestore, Timestamp}: typeof import("firebase-admin/firestore") = require("firebase-admin/firestore");
const {logger}: typeof import("firebase-functions") = require("firebase-functions");
const {
  TOGGL_QUEUE_LIMIT,
  TOGGL_QUEUE_MAX_DEFERRALS,
  TOGGL_QUEUE_RETENTION_MS,
  TOGGL_QUEUE_ROW_LIMIT,
  TOGGL_QUEUE_WINDOW_MS,
}: typeof import("../src/togglQueueLimits") = require("../lib/togglQueueLimits");

type TestContext = import("node:test").TestContext;
interface Snapshot {
  exists: boolean;
  data(): unknown;
  get(field: string): unknown;
}
interface TransactionStub {
  get(ref: object): Promise<Snapshot>;
  update(ref: object, patch: QueuePatch): void;
  set(ref: object, value: Record<string, unknown>): void;
  delete?(ref: object): void;
}
interface QueueItem {
  type: string;
  bookId?: string;
  bookTitle: unknown;
  start: string;
  stop: string;
  status: string;
  createdAt: import("firebase-admin/firestore").Timestamp;
  entryId?: number;
  timerClaimVersion?: number;
  attempts?: number;
  claimedAt?: import("firebase-admin/firestore").Timestamp;
  expiresAt?: unknown;
  retryRequestedAt?: import("firebase-admin/firestore").Timestamp;
  deferredUntil?: unknown;
  deferrals?: number;
  error?: string;
}
interface QueuePatch {
  status?: string;
  entryId?: number;
  attempts?: number;
  claimedAt?: unknown;
  expiresAt?: unknown;
  retryRequestedAt?: unknown;
  deferredUntil?: unknown;
  deferrals?: number;
  error?: string;
  [key: string]: unknown;
}
interface Counter {
  windowStartedAt: import("firebase-admin/firestore").Timestamp;
  count: unknown;
  [key: string]: unknown;
}
interface StoreWrite {
  type: "set" | "update";
  value: Record<string, unknown>;
}
interface LoggedIssue {
  event: string;
  message: string;
  [key: string]: unknown;
}
interface TogglSecret {
  apiToken: string;
  workspaceId: number;
  projectId: number;
  updatedAt: import("firebase-admin/firestore").Timestamp;
}
interface SecretWrite {
  type: "set" | "delete";
  value?: TogglSecret;
}
interface ActiveTimer {
  state?: string;
  operationId?: string;
  entryId?: number;
  start?: string;
  error?: string;
  claimedAt?: import("firebase-admin/firestore").Timestamp;
  queueId?: string;
  [key: string]: unknown;
}
interface Book {
  title?: string;
  activeTimer: ActiveTimer | null;
  [key: string]: unknown;
}
interface BookRef {
  id: string;
  get(): Promise<Snapshot>;
  update(patch: Record<string, unknown>): Promise<void>;
}
interface BookTransactionStub {
  get(ref: object): Promise<Snapshot>;
  update(ref: object, patch: Record<string, unknown>): void;
  set(ref: object, value: Record<string, unknown>): void;
  delete(ref: object): void;
}
interface Deployed {
  toggl: {
    syncqueue: {run(event: unknown): Promise<void>};
    start: {run(data: unknown, context: unknown): Promise<{entryId: number; start: string}>};
    stop: {run(data: unknown, context: unknown): Promise<{seconds: number; minutes: number}>};
    savetoken: {run(data: unknown, context: unknown): Promise<{workspaceId: number; projectId: number}>};
    clearstopping: {run(data: unknown, context: unknown): Promise<unknown>};
    cleartoken: {run(data: unknown, context: unknown): Promise<unknown>};
  };
}

const deployed: Deployed = require("../lib");
const db = getFirestore();
const secretsDb = getFirestore("secrets");
const authContext = {auth: {uid: "owner", token: {}}};

function snapshot(data: unknown, exists = true): Snapshot {
  return {exists, data: () => data, get: (field: string) => {
    if (typeof data !== "object" || data === null) return undefined;
    return Object.fromEntries(Object.entries(data))[field];
  }};
}

// The credential store (SEC-004): getTogglConfig reads
// secrets:togglTokens/{uid}, savetoken sets it, cleartoken and the
// deletion trigger delete it. `data: undefined` models a disconnected
// account.
function installTogglSecret(
  t: TestContext,
  data: TogglSecret | undefined = {
    apiToken: "token",
    workspaceId: 3,
    projectId: 4,
    updatedAt: Timestamp.fromMillis(1),
  },
): {writes: SecretWrite[]; readonly stored: TogglSecret | undefined} {
  const writes: SecretWrite[] = [];
  let stored: TogglSecret | undefined = data;
  const tokenRef = {
    get: async () => snapshot(stored, stored !== undefined),
    set: async (value: TogglSecret) => {
      stored = value;
      writes.push({type: "set", value});
    },
    delete: async () => {
      stored = undefined;
      writes.push({type: "delete"});
    },
  };
  t.mock.method(secretsDb, "doc", (path: string) => {
    assert.equal(path, "togglTokens/owner");
    return tokenRef;
  });
  return {
    writes,
    get stored() {
      return stored;
    },
  };
}

function enableFunctionsEmulator(t: TestContext): void {
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

function queueItem(overrides: Record<string, unknown> = {}): QueueItem {
  const item: QueueItem = {
    type: "create",
    bookId: "book",
    bookTitle: "The Book",
    start: "2026-08-24T12:00:00Z",
    stop: "2026-08-24T12:20:00Z",
    status: "pending",
    createdAt: Timestamp.now(),
  };
  Object.assign(item, overrides);
  return item;
}

function installQueueStore(
  t: TestContext,
  item: QueueItem,
  {quota, rows}: {quota?: Counter; rows?: Counter} = {},
) {
  const queueUpdates: QueuePatch[] = [];
  const transactionUpdates: QueuePatch[] = [];
  const quotaWrites: StoreWrite[] = [];
  const rowsWrites: StoreWrite[] = [];
  const issues: LoggedIssue[] = [];
  let queueDeleted = false;
  let configReads = 0;
  let quotaValue: Record<string, unknown> | undefined = quota;
  let rowsValue: Record<string, unknown> | undefined = rows;
  let rowsReads = 0;
  const queueRef = {
    update: async (patch: QueuePatch) => {
      queueUpdates.push(patch);
    },
    delete: async () => {
      queueDeleted = true;
    },
  };
  const userRef = {
    get: async () => {
      configReads += 1;
      return snapshot({uid: "owner", toggl: {workspaceId: 3, projectId: 4}});
    },
  };
  installTogglSecret(t);
  const quotaRef = {};
  const rowsRef = {};
  t.mock.method(db, "doc", (path: string) => {
    if (path === "users/owner") return userRef;
    if (path === "users/owner/functionQuotas/togglQueueRows") return rowsRef;
    assert.equal(path, "users/owner/functionQuotas/togglQueue");
    return quotaRef;
  });
  t.mock.method(db, "runTransaction", async (handler: (transaction: TransactionStub) => Promise<unknown>) => {
    const effects: Array<()=>Promise<void>>=[];
    const result=await handler({
    get: async (ref: object) => {
      if (ref === userRef) return snapshot({uid:"owner",toggl:{workspaceId:3,projectId:4}});
      if (ref === queueRef) return snapshot(item);
      if (ref === rowsRef) {
        rowsReads += 1;
        return snapshot(rowsValue, rowsValue !== undefined);
      }
      assert.equal(ref, quotaRef);
      return snapshot(quotaValue, quotaValue !== undefined);
    },
    update: (ref: object, patch: QueuePatch) => {
      if (ref === queueRef) {
        if ("claimedAt" in patch || "deferredUntil" in patch || "deferrals" in patch) transactionUpdates.push(patch);
        else { effects.push(async()=>{await queueRef.update(patch);Object.assign(item,patch);});return; }
        Object.assign(item, patch);
      } else if (ref === rowsRef) {
        rowsValue = {...rowsValue, ...patch};
        rowsWrites.push({type: "update", value: patch});
      } else {
        assert.equal(ref, quotaRef);
        quotaValue = {...quotaValue, ...patch};
        quotaWrites.push({type: "update", value: patch});
      }
    },
    delete: (ref: object) => { assert.equal(ref, queueRef); effects.push(()=>queueRef.delete()); },
    set: (ref: object, value: Record<string, unknown>) => {
      if (ref === rowsRef) {
        rowsValue = value;
        rowsWrites.push({type: "set", value});
        return;
      }
      assert.equal(ref, quotaRef);
      quotaValue = value;
      quotaWrites.push({type: "set", value});
    },
    });
    for(const effect of effects) await effect();
    return result;
  });
  t.mock.method(db, "collection", (path: string) => {
    assert.equal(path, "logEvents");
    return {add: async (issue: LoggedIssue) => issues.push(issue)};
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
      return counter(quotaValue);
    },
    get rows() {
      return counter(rowsValue);
    },
    get rowsReads() {
      return rowsReads;
    },
    quotaWrites,
    rowsWrites,
    queueUpdates,
    transactionUpdates,
  };
}

type CorrelatedStopMode =
  | "final-delete-fails"
  | "lost-ack"
  | "lost-ack-delete-fails"
  | "quota-full"
  | "recovery-write-fails";

function installCorrelatedStopStore(
  t: TestContext,
  mode: CorrelatedStopMode,
  {quota}: {quota?: Counter} = {},
) {
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
  const rowsRef = {};
  const userRef = {
    get: async () => snapshot({uid: "owner", toggl: {workspaceId: 3, projectId: 4}}),
  };
  installTogglSecret(t);
  const issues: LoggedIssue[] = [];
  let transactionNumber = 0;
  t.mock.method(db, "doc", (path: string) => {
    if (path === "users/owner") return userRef;
    if (path === "users/owner/functionQuotas/togglQueue") return quotaRef;
    if (path === "users/owner/functionQuotas/togglQueueRows") return rowsRef;
    if (path === "users/owner/books/book") return bookRef;
    if (path === "users/owner/timerLifecycle/current") return claimRef;
    throw new Error(`Unexpected document path ${path}`);
  });
  t.mock.method(db, "collection", (path: string) => {
    assert.equal(path, "logEvents");
    return {add: async (issue: LoggedIssue) => issues.push(issue)};
  });
  t.mock.method(db, "runTransaction", async (handler: (transaction: TransactionStub) => Promise<unknown>) => {
    transactionNumber += 1;
    if (transactionNumber === 1) {
      return handler({
        get: async (ref: object) => {
          if (ref === userRef) return userRef.get();
      if (ref === queueRef) return snapshot(item);
          if (ref === rowsRef) return snapshot(undefined, false);
          assert.equal(ref, quotaRef);
          return snapshot(quota, quota !== undefined);
        },
        set: () => {},
        update: (ref: object, patch: QueuePatch) => {
          if (ref === queueRef) Object.assign(item, patch);
        },
      });
    }
    if (transactionNumber === 2) {
      if (mode === "recovery-write-fails") {
        return handler({
          get: async (ref: object) => {
            if (ref === userRef) return userRef.get();
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
        get: async (ref: object) => {
          if (ref === userRef) return userRef.get();
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
        update: (ref: object, patch: QueuePatch) => {
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
    let deleted = false;
    const result = await handler({
      delete: (ref: object) => { assert.equal(ref, queueRef); deleted = true; },
      get: async (ref: object) => {
        assert.equal(ref, queueRef);
        return snapshot(item);
      },
      update: () => {},
      set: () => {},
    });
    if (deleted) await queueRef.delete();
    return result;
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

function counter(value: Record<string, unknown> | undefined): Counter {
  assert.ok(value);
  assert.ok(value.windowStartedAt instanceof Timestamp);
  return {windowStartedAt: value.windowStartedAt, count: value.count};
}

function lastPatch(patches: QueuePatch[]): QueuePatch {
  const patch = patches.at(-1);
  assert.ok(patch);
  return patch;
}

function activeTimer(book: Book): ActiveTimer {
  assert.ok(book.activeTimer);
  return book.activeTimer;
}

function hasError(error: unknown, code: string, message?: RegExp): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code &&
    (message === undefined ||
      ("message" in error && typeof error.message === "string" && message.test(error.message)));
}

function errorDetails(error: unknown): error is {code: string; message: string} {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string";
}

function recordValue(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null);
  return Object.fromEntries(Object.entries(value));
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
  assert.equal(lastPatch(store.queueUpdates).entryId, 900003);
  assert.equal(store.queueDeleted, true);
});

test("the Functions emulator still syncs a legacy queue row without bookId", async (t) => {
  enableFunctionsEmulator(t);
  const legacyItem = queueItem();
  delete legacyItem.bookId;
  const store = installQueueStore(t, legacyItem);

  await deployed.toggl.syncqueue.run(store.event);

  assert.equal(lastPatch(store.queueUpdates).status, "synced");
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
  assert.equal(lastPatch(store.queueUpdates).status, "synced");
  assert.equal(store.queueDeleted, true);
});

test("the Functions emulator syncs a queued stop without outbound fetch", async (t) => {
  enableFunctionsEmulator(t);
  const store = installQueueStore(t, queueItem({type: "stop", entryId: 52}));

  await deployed.toggl.syncqueue.run(store.event);

  assert.equal(lastPatch(store.queueUpdates).status, "synced");
  assert.equal(lastPatch(store.queueUpdates).entryId, 52);
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
  const consoleErrors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => consoleErrors.push(args));
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
  const consoleErrors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => consoleErrors.push(args));
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
  assert.equal(lastPatch(store.queueUpdates).status, "error");
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
  assert.ok(store.transactionUpdates[0].error);
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
  const errors: Array<[string, {message: string}]> = [];
  t.mock.method(logger, "error", (event: string, detail: {message: string}) =>
    errors.push([event, detail]));

  await deployed.toggl.syncqueue.run(store.event);
  assert.equal(errors.length, 1);
  assert.match(errors[0][1].message, /book title must be a non-empty string/);

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
  // The fresh row is counted against the row bound in the same transaction
  // as its claim, and the claim clears any deferral stamp.
  assert.equal(active.rowsReads, 1);
  assert.deepEqual(active.rowsWrites.map((write) => write.type), ["set"]);
  assert.equal(active.rows.count, 1);
  assert.deepEqual(active.transactionUpdates[0].deferredUntil, FieldValue.delete());
});

test("a redelivered event for an already-touched row is not counted again", async (t) => {
  const store = installQueueStore(t, queueItem({
    attempts: 1,
    claimedAt: Timestamp.fromMillis(Date.now() - 20 * 60 * 1000),
    retryRequestedAt: Timestamp.now(),
  }), {rows: {windowStartedAt: Timestamp.now(), count: 3}});
  t.mock.method(global, "fetch", async () =>
    new Response(JSON.stringify({id: 84}), {status: 200}),
  );
  await deployed.toggl.syncqueue.run(store.event);
  assert.equal(store.rowsReads, 0);
  assert.deepEqual(store.rowsWrites, []);
  assert.equal(store.rows.count, 3);
  assert.equal(store.queueDeleted, true);
});

test("the row bound refuses past the limit, warns once, and never blocks the row", async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(logger, "warn", (...args: unknown[]) => warnings.push(args));
  t.mock.method(global, "fetch", async () =>
    new Response(JSON.stringify({id: 85}), {status: 200}),
  );
  const atLimit = installQueueStore(t, queueItem(), {
    rows: {windowStartedAt: Timestamp.now(), count: TOGGL_QUEUE_ROW_LIMIT},
  });
  await deployed.toggl.syncqueue.run(atLimit.event);
  // The row itself is processed: the bound closes the rules for later
  // creates, it does not discard a row the rules already admitted.
  assert.equal(atLimit.queueDeleted, true);
  assert.deepEqual(atLimit.rowsWrites, [
    {type: "update", value: {count: TOGGL_QUEUE_ROW_LIMIT + 1}},
  ]);
  assert.deepEqual(warnings, [["toggl.queue_rows_exceeded", {uid: "owner"}]]);

  const pastLimit = installQueueStore(t, queueItem(), {
    rows: {windowStartedAt: Timestamp.now(), count: TOGGL_QUEUE_ROW_LIMIT + 1},
  });
  await deployed.toggl.syncqueue.run(pastLimit.event);
  assert.equal(pastLimit.queueDeleted, true);
  assert.deepEqual(pastLimit.rowsWrites, []);
  assert.equal(warnings.length, 1);

  const expired = installQueueStore(t, queueItem(), {
    rows: {
      windowStartedAt: Timestamp.fromMillis(Date.now() - TOGGL_QUEUE_WINDOW_MS - 1),
      count: TOGGL_QUEUE_ROW_LIMIT + 1,
    },
  });
  await deployed.toggl.syncqueue.run(expired.event);
  assert.deepEqual(expired.rowsWrites.map((write) => write.type), ["set"]);
  assert.equal(expired.rows.count, 1);
  assert.equal(warnings.length, 1);
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

test("an exhausted queue quota defers once per window and never throws", async (t) => {
  const windowStartedAt = Timestamp.fromMillis(Date.now() - 5 * 60 * 1000);
  const createdAt = Timestamp.fromMillis(Date.now() - 60 * 1000);
  const store = installQueueStore(t, queueItem({createdAt}), {
    quota: {windowStartedAt, count: TOGGL_QUEUE_LIMIT},
  });
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run");
  });

  // Resolves: a throw here used to make Eventarc redeliver every over-quota
  // row with backoff for a day (SEC-002).
  await deployed.toggl.syncqueue.run(store.event);
  assert.equal(fetchCalls, 0);
  assert.equal(store.configReads, 0);
  assert.deepEqual(store.quotaWrites, []);
  assert.equal(store.queueUpdates.length, 0);
  // The stamp is the server-pinned end of the quota window, and a deferred
  // create row gets a finite expiry measured from its creation.
  assert.deepEqual(store.transactionUpdates, [{
    deferredUntil: Timestamp.fromMillis(windowStartedAt.toMillis() + TOGGL_QUEUE_WINDOW_MS),
    deferrals: 1,
    expiresAt: Timestamp.fromMillis(createdAt.toMillis() + TOGGL_QUEUE_RETENTION_MS),
  }]);
  // A deferred row is still a row: it is counted against the row bound.
  assert.deepEqual(store.rowsWrites.map((write) => write.type), ["set"]);
  assert.equal(store.rows.count, 1);
});

test("a forward-dated row's deferral expiry is measured from now, not its claimed creation", async (t) => {
  const windowStartedAt = Timestamp.fromMillis(Date.now() - 5 * 60 * 1000);
  const createdAt = Timestamp.fromMillis(Date.now() + 4 * 60 * 1000);
  const store = installQueueStore(t, queueItem({createdAt}), {
    quota: {windowStartedAt, count: TOGGL_QUEUE_LIMIT},
  });
  t.mock.method(global, "fetch", async () => {
    throw new Error("fetch must not run");
  });
  const before = Date.now();
  await deployed.toggl.syncqueue.run(store.event);
  const expiry = store.transactionUpdates[0].expiresAt;
  assert.ok(expiry instanceof Timestamp);
  const expiresAt = expiry.toMillis() - TOGGL_QUEUE_RETENTION_MS;
  assert.ok(expiresAt >= before && expiresAt <= Date.now());
});

test("a row already stamped for this window is left untouched", async (t) => {
  const windowStartedAt = Timestamp.fromMillis(Date.now() - 5 * 60 * 1000);
  const deferredUntil = Timestamp.fromMillis(windowStartedAt.toMillis() + TOGGL_QUEUE_WINDOW_MS);
  const store = installQueueStore(t, queueItem({
    deferredUntil,
    expiresAt: Timestamp.fromMillis(Date.now() + TOGGL_QUEUE_RETENTION_MS),
  }), {
    quota: {windowStartedAt, count: TOGGL_QUEUE_LIMIT},
    rows: {windowStartedAt, count: 7},
  });
  t.mock.method(global, "fetch", async () => {
    throw new Error("fetch must not run");
  });

  // The stamp write fires this trigger once more; writing it again would
  // loop. Nothing is written and the row is not counted a second time.
  await deployed.toggl.syncqueue.run(store.event);
  assert.deepEqual(store.transactionUpdates, []);
  assert.deepEqual(store.quotaWrites, []);
  assert.deepEqual(store.rowsWrites, []);
  assert.equal(store.rowsReads, 0);
  assert.equal(store.rows.count, 7);
});

test("a new quota window re-stamps a still-deferred row without re-counting it", async (t) => {
  const previousWindow = Timestamp.fromMillis(Date.now() - 90 * 60 * 1000);
  const windowStartedAt = Timestamp.fromMillis(Date.now() - 10 * 60 * 1000);
  const expiresAt = Timestamp.fromMillis(Date.now() + TOGGL_QUEUE_RETENTION_MS);
  const store = installQueueStore(t, queueItem({
    deferredUntil: Timestamp.fromMillis(previousWindow.toMillis() + TOGGL_QUEUE_WINDOW_MS),
    deferrals: 3,
    expiresAt,
  }), {
    quota: {windowStartedAt, count: TOGGL_QUEUE_LIMIT},
    rows: {windowStartedAt, count: 7},
  });
  t.mock.method(global, "fetch", async () => {
    throw new Error("fetch must not run");
  });

  await deployed.toggl.syncqueue.run(store.event);
  // Only the stamp moves: the expiry set at the first deferral is kept, so
  // a row deferred window after window still ends 90 days after creation.
  assert.deepEqual(store.transactionUpdates, [{
    deferredUntil: Timestamp.fromMillis(windowStartedAt.toMillis() + TOGGL_QUEUE_WINDOW_MS),
    deferrals: 4,
  }]);
  assert.equal(store.rowsReads, 0);
  assert.deepEqual(store.rowsWrites, []);
});

test("a row deferred for a whole day becomes terminal instead of a delivery per window forever", async (t) => {
  const windowStartedAt = Timestamp.fromMillis(Date.now() - 10 * 60 * 1000);
  const expiresAt = Timestamp.fromMillis(Date.now() + TOGGL_QUEUE_RETENTION_MS);
  const store = installQueueStore(t, queueItem({
    deferredUntil: Timestamp.fromMillis(Date.now() - 60 * 1000),
    deferrals: TOGGL_QUEUE_MAX_DEFERRALS,
    expiresAt,
  }), {
    quota: {windowStartedAt, count: TOGGL_QUEUE_LIMIT},
  });
  t.mock.method(global, "fetch", async () => {
    throw new Error("fetch must not run");
  });

  await deployed.toggl.syncqueue.run(store.event);
  assert.equal(store.transactionUpdates.length, 1);
  const terminal = store.transactionUpdates[0];
  assert.equal(terminal.status, "error");
  assert.equal(terminal.attempts, 5);
  assert.equal(terminal.deferrals, TOGGL_QUEUE_MAX_DEFERRALS + 1);
  assert.ok(terminal.error);
  assert.match(terminal.error, /consecutive hours/);
  assert.ok(terminal.claimedAt instanceof Timestamp);
  assert.ok(terminal.expiresAt instanceof Timestamp);
  assert.deepEqual(terminal.deferredUntil, FieldValue.delete());
  assert.deepEqual(terminal.retryRequestedAt, FieldValue.delete());
  assert.deepEqual(store.quotaWrites, []);
});

test("a malformed row over quota is terminal at once, never parked behind a stamp", async (t) => {
  // Stamping before decoding would leave a malformed row pending with a
  // deferral the client sweep reads as an expected refusal, forever.
  const windowStartedAt = Timestamp.fromMillis(Date.now() - 10 * 60 * 1000);
  const store = installQueueStore(t, queueItem({start: "2026-99-99T99:99:99Z"}), {
    quota: {windowStartedAt, count: TOGGL_QUEUE_LIMIT},
  });
  t.mock.method(global, "fetch", async () => {
    throw new Error("fetch must not run");
  });

  const errors: unknown[][] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => errors.push(args));
  await deployed.toggl.syncqueue.run(store.event);
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], "toggl.queue_malformed");
  assert.equal(store.transactionUpdates.length, 1);
  assert.equal(store.transactionUpdates[0].status, "error");
  assert.equal(store.transactionUpdates[0].deferredUntil !== undefined, true);
  assert.deepEqual(store.transactionUpdates[0].deferredUntil, FieldValue.delete());
  assert.equal(store.quota.count, TOGGL_QUEUE_LIMIT + 1);
  assert.equal(store.rows.count, 1);
});

test("an SDK transaction retry that early-returns does not report the first attempt's refusal", async (t) => {
  // The Admin SDK re-runs the callback on contention. The first attempt
  // sees a fresh row past the bound (sets the refusal flag); the retry
  // sees the row already claimed by another worker and returns early.
  const warnings: unknown[][] = [];
  t.mock.method(logger, "warn", (...args: unknown[]) => warnings.push(args));
  const store = installQueueStore(t, queueItem(), {
    rows: {windowStartedAt: Timestamp.now(), count: TOGGL_QUEUE_ROW_LIMIT},
  });
  const handlers: Array<(transaction: TransactionStub) => Promise<unknown>> = [];
  t.mock.method(db, "runTransaction", async (handler: (transaction: TransactionStub) => Promise<unknown>) => {
    handlers.push(handler);
    const firstAttempt = {
      get: async (ref: object) => ref === store.queueRef ?
        snapshot(queueItem()) : "get" in ref ? snapshot({uid:"owner",toggl:{workspaceId:3,projectId:4}}) :
        snapshot({windowStartedAt: Timestamp.now(), count: TOGGL_QUEUE_ROW_LIMIT}, true),
      update: () => {},
      set: () => {},
    };
    await handler(firstAttempt);
    const retry = {
      get: async () => snapshot(queueItem({status: "processing", attempts: 1, claimedAt: Timestamp.now()})),
      update: () => {
        throw new Error("the retry must not write");
      },
      set: () => {
        throw new Error("the retry must not write");
      },
    };
    return handler(retry);
  });
  await deployed.toggl.syncqueue.run(store.event);
  assert.equal(handlers.length, 1);
  assert.deepEqual(warnings, []);
});

test("quota deferral preserves a pending item's existing retry budget", async (t) => {
  const claimedAt = Timestamp.now();
  const windowStartedAt = Timestamp.fromMillis(Date.now() - 5 * 60 * 1000);
  const item = queueItem({
    attempts: 4,
    claimedAt,
    retryRequestedAt: Timestamp.now(),
    error: "previous failure",
  });
  const store = installQueueStore(t, item, {
    quota: {windowStartedAt, count: TOGGL_QUEUE_LIMIT},
  });
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run");
  });

  await deployed.toggl.syncqueue.run(store.event);
  assert.equal(store.transactionUpdates.length, 1);
  assert.deepEqual(Object.keys(store.transactionUpdates[0]).sort(), ["deferrals", "deferredUntil", "expiresAt"]);
  assert.deepEqual(store.quotaWrites, []);
  // A retried row was counted when first touched; not again.
  assert.equal(store.rowsReads, 0);
  assert.deepEqual(store.rowsWrites, []);
  assert.equal(fetchCalls, 0);
  assert.equal(item.attempts, 4);
  assert.equal(item.claimedAt, claimedAt);
  assert.equal(item.retryRequestedAt instanceof Timestamp, true);
});

test("a correlated stop is claimed even when the quota window is full", async (t) => {
  // While it is pending, the book and the lifecycle lock stay in `stopping`
  // and every timer in the app is disabled; nothing but this trigger can
  // release them, so it is never parked behind a stamp.
  const windowStartedAt = Timestamp.fromMillis(Date.now() - 5 * 60 * 1000);
  const store = installCorrelatedStopStore(t, "quota-full", {
    quota: {windowStartedAt, count: TOGGL_QUEUE_LIMIT},
  });
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({id: 52}), {status: 200});
  });

  await deployed.toggl.syncqueue.run(store.event);
  assert.equal(fetchCalls, 1);
  assert.equal(store.item.status, "synced");
  // The mock applies patches verbatim: the claim explicitly clears the stamp.
  assert.deepEqual(store.item.deferredUntil, FieldValue.delete());
  assert.equal(store.queueRef.deleted, true);
});

test("a malformed queue quota document is repaired into a fresh window and logged", async (t) => {
  // Only the Admin SDK writes it, so this is a server bug; throwing here was
  // an Eventarc redelivery storm that also skipped the row count.
  const errors: unknown[][] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => errors.push(args));
  const store = installQueueStore(t, queueItem(), {
    quota: {windowStartedAt: Timestamp.now(), count: "ten"},
  });
  t.mock.method(global, "fetch", async () =>
    new Response(JSON.stringify({id: 86}), {status: 200}),
  );

  await deployed.toggl.syncqueue.run(store.event);
  assert.equal(store.queueDeleted, true);
  assert.deepEqual(store.quotaWrites.map((write) => write.type), ["set"]);
  assert.equal(store.quota.count, 1);
  assert.equal(store.rows.count, 1);
  assert.deepEqual(errors, [["toggl.queue_quota_repaired", {uid: "owner"}]]);
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
  assert.equal(lastPatch(store.queueUpdates).status, "synced");
  assert.ok(store.transactionUpdates[0].expiresAt instanceof Timestamp);
});

function installBooksStore(t: TestContext, books: Record<string, Book>) {
  const userRef = {
    get: async () => snapshot({uid: "owner", toggl: {workspaceId: 3, projectId: 4}}),
  };
  installTogglSecret(t);
  const active = Object.entries(books).find(([, book]) => book.activeTimer !== null);
  let claim: Record<string, unknown> | null = {version: 1, state: "idle", cleared: null};
  if (active !== undefined) {
    const [bookId, activeBook] = active;
    const timer = activeBook.activeTimer;
    assert.ok(timer);
    claim = "state" in timer ?
      {version: 1, bookId, ...timer} :
      timer.entryId === undefined ? {
        version: 1,
        state: "local",
        bookId,
        operationId: timer.operationId,
        start: timer.start,
      } : {
        version: 1,
        state: "remote",
        bookId,
        entryId: timer.entryId,
        start: timer.start,
      };
  }
  const claimRef = {id: "current"};
  const bookRefs = new Map<string, BookRef>(Object.entries(books).map(([id, book]) => [id, {
    id,
    get: async () => snapshot(book),
    update: async (patch: Record<string, unknown>) => {
      Object.assign(book, patch);
    },
  }]));
  t.mock.method(db, "doc", (path: string) => {
    if (path === "users/owner") return userRef;
    if (path === "users/owner/timerLifecycle/current") return claimRef;
    const prefix = "users/owner/books/";
    assert.ok(path.startsWith(prefix));
    const ref = bookRefs.get(path.slice(prefix.length));
    assert.ok(ref);
    return ref;
  });
  t.mock.method(db, "runTransaction", async (handler: (transaction: BookTransactionStub) => Promise<unknown>) => handler({
    get: async (ref: object) => {
      if (ref === userRef) return userRef.get();
      if (ref === claimRef) return snapshot(claim, claim !== null);
      const entry = [...bookRefs.entries()].find(([, bookRef]) => bookRef === ref);
      assert.ok(entry);
      return snapshot(books[entry[0]]);
    },
    update: (ref: object, patch: Record<string, unknown>) => {
      const entry = [...bookRefs.entries()].find(([, bookRef]) => bookRef === ref);
      assert.ok(entry);
      Object.assign(books[entry[0]], patch);
    },
    set: (ref: object, value: Record<string, unknown>) => {
      assert.equal(ref, claimRef);
      claim = value;
    },
    delete: (ref: object) => {
      assert.equal(ref, claimRef);
      claim = null;
    },
  }));
  return {books, bookRefs, get claim() { return claim; }};
}

function installBookStore(t: TestContext, book: Book) {
  const store = installBooksStore(t, {book});
  return {book, bookRef: store.bookRefs.get("book")};
}

test("concurrent starts share a transactional claim and issue one POST", async (t) => {
  const store = installBookStore(t, {title: "The Book", activeTimer: null});
  let fetchCalls = 0;
  let announceFetch: () => void = () => assert.fail("fetch start resolver was not installed");
  let releaseFetch: (response: Response) => void = () =>
    assert.fail("fetch response resolver was not installed");
  const fetchStarted = new Promise<void>((resolve) => {
    announceFetch = resolve;
  });
  const fetchResponse = new Promise<Response>((resolve) => {
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
    (error) => hasError(error, "failed-precondition"),
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
  let announceFetch: () => void = () => assert.fail("fetch start resolver was not installed");
  let releaseFetch: (response: Response) => void = () =>
    assert.fail("fetch response resolver was not installed");
  const fetchStarted = new Promise<void>((resolve) => {
    announceFetch = resolve;
  });
  const fetchResponse = new Promise<Response>((resolve) => {
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
    (error) => hasError(error, "failed-precondition", /another book/),
  );
  releaseFetch(new Response(JSON.stringify({
    id: 92,
    start: "2026-08-24T12:00:00Z",
  }), {status: 200}));
  await first;

  assert.equal(fetchCalls, 1);
  assert.equal(activeTimer(store.books.first).entryId, 92);
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
    (error) => hasError(error, "failed-precondition"),
  );

  assert.equal(fetchCalls, 0);
  assert.equal(activeTimer(store.book).state, "outcome-unknown");
});

test("an explicit start rejection clears its claim and reports Toggl's reason", async (t) => {
  const store = installBookStore(t, {title: "The Book", activeTimer: null});
  t.mock.method(global, "fetch", async () =>
    new Response("Payment Required\n", {status: 402}),
  );

  // A typed error reaches the client as its message; a plain Error would
  // arrive as a bare INTERNAL with the status and body lost.
  await assert.rejects(
    deployed.toggl.start.run({bookId: "book"}, authContext),
    (error) => hasError(
      error,
      "failed-precondition",
      /^Toggl start failed with status 402: Payment Required$/,
    ),
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
    (error) => hasError(
      error,
      "unavailable",
      /^Toggl start failed with status 503: gateway failed after forwarding$/,
    ),
  );

  const failedTimer = activeTimer(store.book);
  assert.equal(failedTimer.state, "outcome-unknown");
  assert.ok(failedTimer.error);
  assert.match(failedTimer.error, /status 503: gateway failed after forwarding/);
  await assert.rejects(
    deployed.toggl.start.run({bookId: "book"}, authContext),
    (error) => hasError(error, "failed-precondition"),
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

  const failedTimer = activeTimer(store.book);
  assert.equal(failedTimer.state, "outcome-unknown");
  assert.ok(failedTimer.error);
  assert.match(failedTimer.error, /socket closed/);
  await assert.rejects(
    deployed.toggl.start.run({bookId: "book"}, authContext),
    (error) => hasError(error, "failed-precondition"),
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
  assert.equal(activeTimer(store.book).state, "outcome-unknown");
  await assert.rejects(
    deployed.toggl.start.run({bookId: "book"}, authContext),
    (error) => hasError(error, "failed-precondition"),
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

test("a stop refusal keeps the timer and reports Toggl's reason", async (t) => {
  const store = installBookStore(t, {
    activeTimer: {
      entryId: 12,
      start: "2026-08-24T12:00:00Z",
    },
  });
  t.mock.method(global, "fetch", async () =>
    new Response("Payment Required", {status: 402}),
  );

  await assert.rejects(
    deployed.toggl.stop.run({bookId: "book"}, authContext),
    (error) => hasError(
      error,
      "failed-precondition",
      /^Toggl stop failed with status 402: Payment Required$/,
    ),
  );
  assert.equal(activeTimer(store.book).entryId, 12);
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
  assert.equal(activeTimer(store.book).entryId, 13);
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

const verifiedContext = {auth: {uid: "owner", token: {email_verified: true}}};

// savetoken meters itself through users/owner/functionQuotas/togglToken
// (consumeQuota's own transaction); the mock serves that document and
// records what the quota transaction writes.
interface ConnectionRef {path:string;id:string;get():Promise<Snapshot & {ref:ConnectionRef}>;set(value:Record<string,unknown>):Promise<void>;delete():Promise<void>}
function installConnectionStore(t: TestContext) {
  const values=new Map<string,Record<string,unknown>>([
    ['users/owner',{uid:'owner',email:'owner@example.test'}],
    ['users/owner/timerLifecycle/current',{version:1,state:'idle',cleared:null}],
  ]);
  const credentials=new Map<string,Record<string,unknown>>();
  const writes:string[]=[];
  let staged:()=>void=()=>{};
  function reference(path:string, secret=false):ConnectionRef {
    const map=secret ? credentials : values;
    const ref:ConnectionRef={path,id:path.split('/').at(-1) ?? path,
      get:async()=>({...snapshot(map.get(path),map.has(path)),ref}),
      set:async(value)=>{map.set(path,value);writes.push(`${secret ? 'secret:' : ''}${path}`);if(secret) staged();},
      delete:async()=>{map.delete(path);writes.push(`delete:${secret ? 'secret:' : ''}${path}`);},
    };
    return ref;
  }
  t.mock.method(db,'doc',(path:string)=>reference(path));
  t.mock.method(secretsDb,'doc',(path:string)=>reference(path,true));
  t.mock.method(db,'collection',(path:string)=>{
    const queryRef={where:()=>queryRef,limit:()=>queryRef,get:async()=>({size:0,empty:true,docs:[]}),path};return queryRef;
  });
  t.mock.method(db,'runTransaction',async(work:(tx:unknown)=>Promise<unknown>)=>{
    const changes:Array<()=>void>=[];
    const result=await work({get:async(ref:{get():Promise<unknown>})=>ref.get(),
      set:(ref:ConnectionRef,value:Record<string,unknown>)=>changes.push(()=>{values.set(ref.path,value);writes.push(ref.path);}),
      update:(ref:ConnectionRef,patch:Record<string,unknown>)=>changes.push(()=>{
        const value={...values.get(ref.path)};
        for(const [key,next] of Object.entries(patch)) {if(next instanceof FieldValue && next.isEqual(FieldValue.delete())) delete value[key];else value[key]=next;}
        values.set(ref.path,value);writes.push(ref.path);
      }),
    });
    changes.forEach(apply=>apply());return result;
  });
  return {values,credentials,writes,onStage(callback:()=>void){staged=callback;}};
}
function mockConnectionResponses(t:TestContext) {
  t.mock.method(global,'fetch',async(url:string|URL|Request)=>String(url).endsWith('/me') ? new Response(JSON.stringify({id:9}),{status:200}) : new Response(JSON.stringify([{id:7,workspace_id:6,name:'Reading'}]),{status:200}));
}
test('savetoken initializes one revision with credentials staged before activation',async t=>{
  const store=installConnectionStore(t);mockConnectionResponses(t);
  assert.deepEqual(await deployed.toggl.savetoken.run({token:'valid-token'},verifiedContext),{workspaceId:6,projectId:7});
  const user=store.values.get('users/owner');assert.ok(user);
  const config=recordValue(user.timeTracking);assert.equal(config.provider,'toggl');assert.equal(config.accountId,'9');
  assert.equal(store.credentials.get(`timeTrackingTokens/owner/revisions/${config.revision}`)?.apiToken,'valid-token');
  assert.ok(store.writes.findIndex(path=>path.startsWith('secret:'))<store.writes.lastIndexOf('users/owner'));
  assert.equal(JSON.stringify(user).includes('valid-token'),false);
});
test('legacy savetoken refuses an explicit destination and never overwrites it',async t=>{
  const store=installConnectionStore(t);mockConnectionResponses(t);
  const selected={provider:'none',revision:'chosen'};store.values.set('users/owner',{uid:'owner',timeTracking:selected});
  await assert.rejects(deployed.toggl.savetoken.run({token:'valid-token'},verifiedContext),error=>hasError(error,'failed-precondition'));
  assert.deepEqual(store.values.get('users/owner')?.timeTracking,selected);assert.equal(store.credentials.size,0);
});
test('savetoken refuses unverified accounts before a credential or quota is touched',async t=>{
  const store=installConnectionStore(t);
  await assert.rejects(deployed.toggl.savetoken.run({token:'valid-token'},authContext),error=>hasError(error,'failed-precondition',/Verify your email/));assert.equal(store.writes.length,0);
});
test('connection validation is rate limited before making outbound calls',async t=>{
  const store=installConnectionStore(t);store.values.set('users/owner/functionQuotas/timeTrackingConnection',{windowStartedAt:Timestamp.now(),count:10});
  await assert.rejects(deployed.toggl.savetoken.run({token:'valid-token'},verifiedContext),error=>hasError(error,'resource-exhausted'));
  assert.equal(store.credentials.size,0);
});
test('the emulator initializes a deterministic Toggl project without outbound fetch',async t=>{
  enableFunctionsEmulator(t);const store=installConnectionStore(t);
  assert.deepEqual(await deployed.toggl.savetoken.run({token:'snapshot-token'},verifiedContext),{workspaceId:900001,projectId:900002});assert.equal(store.credentials.size,1);
});
test('cleartoken changes the default database revision before removing the credential',async t=>{
  const store=installConnectionStore(t);
  store.values.set('users/owner',{uid:'owner',toggl:{workspaceId:3,projectId:4},timeTracking:{provider:'toggl',revision:'old',accountId:'9',workspaceId:3,projectId:4}});
  store.credentials.set('timeTrackingTokens/owner/revisions/old',{apiToken:'token'});
  assert.deepEqual(await deployed.toggl.cleartoken.run({},verifiedContext),{cleared:true});
  assert.equal(recordValue(store.values.get('users/owner')?.timeTracking).provider,'none');assert.equal(store.credentials.size,0);
  assert.ok(store.writes.indexOf('users/owner')<store.writes.indexOf('delete:secret:timeTrackingTokens/owner/revisions/old'));
});
test('a token staged during account deletion is removed without activating it',async t=>{
  const store=installConnectionStore(t);mockConnectionResponses(t);store.onStage(()=>store.values.set('users/owner',{uid:'owner',deletedAt:Timestamp.now()}));
  await assert.rejects(deployed.toggl.savetoken.run({token:'valid-token'},verifiedContext),error=>hasError(error,'failed-precondition',/deleted/));assert.equal(store.credentials.size,0);
});
test('a running timer prevents disconnect and retains the only credential',async t=>{
  const store=installConnectionStore(t);store.values.set('users/owner',{uid:'owner',toggl:{workspaceId:3,projectId:4}});store.values.set('users/owner/timerLifecycle/current',{version:1,state:'starting'});store.credentials.set('togglTokens/owner',{apiToken:'token'});
  await assert.rejects(deployed.toggl.cleartoken.run({},verifiedContext),error=>hasError(error,'failed-precondition',/Stop your timer/));assert.equal(store.credentials.size,1);
});
