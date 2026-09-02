require("./setup.cts");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const {readFileSync}: typeof import("node:fs") = require("node:fs");
const {join}: typeof import("node:path") = require("node:path");
const test: typeof import("node:test").test = require("node:test");
const {getFirestore, Timestamp}: typeof import("firebase-admin/firestore") = require("firebase-admin/firestore");
const {logger}: typeof import("firebase-functions") = require("firebase-functions");
const {sharedWorkOwnerId}: typeof import("../src/catalogProjection") = require("../lib/catalogProjection");

interface EventTrigger {
  eventType: string;
  retry?: boolean;
  eventFilters: Record<string, string>;
  eventFilterPathPatterns: Record<string, string>;
}
interface Endpoint {
  platform: string;
  region: string[];
  eventTrigger: EventTrigger;
  httpsTrigger?: {invoker?: unknown};
  callableTrigger?: unknown;
  maxInstances?: number;
  availableMemoryMb?: number;
  timeoutSeconds?: number;
  concurrency?: number;
  serviceAccountEmail?: unknown;
  ingressSettings?: unknown;
  secretEnvironmentVariables?: Array<{key: string}>;
}
interface EndpointFunction {
  __endpoint: Endpoint;
  __trigger?: {eventTrigger: EventTrigger};
}
interface DeployedFunction extends EndpointFunction {
  run(...args: unknown[]): Promise<unknown>;
}
interface FunctionsBundle {
  admin: {
    catalogapply: DeployedFunction;
    catalogpreview: DeployedFunction;
    overview: DeployedFunction;
    review: DeployedFunction;
  };
  booksapi: {lookupisbn: DeployedFunction};
  catalog: {
    create: DeployedFunction;
    ensureauthors: DeployedFunction;
    search: DeployedFunction;
    addedition: DeployedFunction;
    workreaders: DeployedFunction;
  };
  createUserDocument: DeployedFunction;
  deleteUserDocument: DeployedFunction;
  deletebookupdates: DeployedFunction;
  publicweb: EndpointFunction;
  syncbooksharingprojection: DeployedFunction;
  syncsharingaccountprojection: DeployedFunction;
  syncsharingsettingprojection: DeployedFunction;
  telemetry: {reportissue: DeployedFunction};
  toggl: {
    clearstopping: DeployedFunction;
    cleartoken: DeployedFunction;
    savetoken: DeployedFunction;
    start: DeployedFunction;
    stop: DeployedFunction;
    syncqueue: DeployedFunction;
  };
}
type Write = [
  ref: object,
  value: Record<string, unknown>,
  options: Record<string, unknown> | undefined,
];
type PathWrite = [
  path: string,
  value: Record<string, unknown>,
  options: Record<string, unknown>,
];
type Row = Record<string, unknown>;

const functions: FunctionsBundle = require("../lib");
const db = getFirestore();
const secretsDb = getFirestore("secrets");

test("preserves the deployed function export names", () => {
  assert.deepEqual(Object.keys(functions).sort(), [
    "admin",
    "booksapi",
    "catalog",
    "createUserDocument",
    "deleteUserDocument",
    "deletebookupdates",
    "publicweb",
    "syncbooksharingprojection",
    "syncsharingaccountprojection",
    "syncsharingsettingprojection",
    "telemetry",
    "toggl",
  ]);
  assert.deepEqual(Object.keys(functions.admin).sort(), [
    "catalogapply",
    "catalogpreview",
    "overview",
    "review",
  ]);
  assert.deepEqual(Object.keys(functions.booksapi), ["lookupisbn"]);
  assert.deepEqual(Object.keys(functions.catalog).sort(), [
    "addedition",
    "create",
    "ensureauthors",
    "search",
    "workreaders",
  ]);
  assert.deepEqual(Object.keys(functions.telemetry), ["reportissue"]);
  assert.deepEqual(Object.keys(functions.toggl).sort(), [
    "clearstopping",
    "cleartoken",
    "savetoken",
    "start",
    "stop",
    "syncqueue",
  ]);
});

test("keeps every function in europe-west1 on its required generation", () => {
  // The eur3 multi-region database rejects newly created gen1 Firestore
  // triggers, so the two triggers added for offline support must be gen2;
  // everything that predates that constraint stays gen1.
  const gen1Functions = [
    functions.admin.overview,
    functions.admin.catalogapply,
    functions.admin.catalogpreview,
    functions.admin.review,
    functions.createUserDocument,
    functions.deleteUserDocument,
    functions.booksapi.lookupisbn,
    functions.catalog.create,
    functions.catalog.ensureauthors,
    functions.catalog.search,
    functions.catalog.workreaders,
    functions.telemetry.reportissue,
    functions.toggl.savetoken,
    functions.toggl.clearstopping,
    functions.toggl.start,
    functions.toggl.stop,
  ];
  for (const deployedFunction of gen1Functions) {
    assert.equal(deployedFunction.__endpoint.platform, "gcfv1");
    assert.deepEqual(deployedFunction.__endpoint.region, ["europe-west1"]);
  }

  const gen2Functions = [
    functions.deletebookupdates,
    functions.syncbooksharingprojection,
    functions.syncsharingaccountprojection,
    functions.syncsharingsettingprojection,
    functions.toggl.syncqueue,
  ];
  for (const deployedFunction of gen2Functions) {
    assert.equal(deployedFunction.__endpoint.platform, "gcfv2");
    assert.deepEqual(deployedFunction.__endpoint.region, ["europe-west1"]);
    // Guards the id/location confusion: DocumentOptions.database takes a
    // database id, and "eur3" (a location) would deploy fine but bind a
    // trigger to a nonexistent database that silently never fires.
    assert.deepEqual(deployedFunction.__endpoint.eventTrigger.eventFilters, {
      database: "(default)",
      namespace: "(default)",
    });
  }

  assert.equal(functions.publicweb.__endpoint.platform, "gcfv2");
  assert.deepEqual(functions.publicweb.__endpoint.region, ["europe-west1"]);
  assert.notEqual(functions.publicweb.__endpoint.httpsTrigger, undefined);
  // The public renderer is the one endpoint strangers and crawlers can hit
  // without an account; an explicit instance cap is its cost ceiling.
  assert.equal(functions.publicweb.__endpoint.maxInstances, 2);
});

test("preserves the Firestore and Authentication event contracts", () => {
  assert.ok(functions.createUserDocument.__trigger);
  assert.equal(
    functions.createUserDocument.__trigger.eventTrigger.eventType,
    "providers/firebase.auth/eventTypes/user.create",
  );
  assert.ok(functions.deleteUserDocument.__trigger);
  assert.equal(
    functions.deleteUserDocument.__trigger.eventTrigger.eventType,
    "providers/firebase.auth/eventTypes/user.delete",
  );
  assert.equal(
    functions.toggl.syncqueue.__endpoint.eventTrigger.eventType,
    "google.cloud.firestore.document.v1.written",
  );
  assert.equal(
    functions.toggl.syncqueue.__endpoint.eventTrigger.retry,
    true,
  );
  assert.equal(
    functions.toggl.syncqueue.__endpoint.eventTrigger
      .eventFilterPathPatterns.document,
    "users/{uid}/togglQueue/{queueId}",
  );
  assert.equal(
    functions.deletebookupdates.__endpoint.eventTrigger.eventType,
    "google.cloud.firestore.document.v1.deleted",
  );
  assert.equal(
    functions.deletebookupdates.__endpoint.eventTrigger
      .eventFilterPathPatterns.document,
    "users/{userId}/books/{bookId}",
  );
  const projectionTriggers: Array<[DeployedFunction, string]> = [
    [functions.syncbooksharingprojection, "users/{userId}/books/{bookId}"],
    [functions.syncsharingsettingprojection, "users/{userId}/settings/bookSharing"],
    [functions.syncsharingaccountprojection, "users/{userId}"],
  ];
  for (const [deployedFunction, path] of projectionTriggers) {
    assert.equal(
      deployedFunction.__endpoint.eventTrigger.eventType,
      "google.cloud.firestore.document.v1.written",
    );
    assert.equal(deployedFunction.__endpoint.eventTrigger.retry, true);
    assert.equal(
      deployedFunction.__endpoint.eventTrigger.eventFilterPathPatterns.document,
      path,
    );
  }
});

test("a linked book write creates the work-owner projection for a live account", async (t) => {
  interface Ref {
    path: string;
    id: string;
    kind: string;
  }
  interface ProjectionWrite {
    type: "set" | "delete";
    reference: Ref;
    data?: Row;
  }
  const writes: ProjectionWrite[] = [];
  const refs = new Map<string, Ref>();
  const ref = (path: string, kind = "doc"): Ref => {
    const existing = refs.get(path);
    if (existing !== undefined) return existing;
    const created: Ref = {path, id: path.slice(path.lastIndexOf("/") + 1), kind};
    refs.set(path, created);
    return created;
  };
  const query = {kind: "books-query"};
  // No setting at all: sharing is on by default, so nothing but the
  // account and the linked book decides the row.
  t.mock.method(db, "doc", (path: string) => ref(path));
  t.mock.method(db, "collection", (name: string) => {
    if (name === "sharedWorkOwners" || name === "users") {
      return {doc: (id: string) => ref(`${name}/${id}`)};
    }
    if (name === "users/reader/books") {
      return {where: (field: string, operator: string, value: unknown) => {
        assert.deepEqual([field, operator, value], ["workId", "==", "work-one"]);
        return {limit: (limit: number) => {
          assert.equal(limit, 1);
          return query;
        }};
      }};
    }
    assert.fail(`unexpected collection ${name}`);
  });
  t.mock.method(db, "runTransaction", async (handler: (transaction: {
    get(value: {path?: string; kind: string}): Promise<unknown>;
    set(reference: Ref, data: Row): void;
    delete(reference: Ref): void;
  }) => Promise<unknown>) => handler({
    get: async (value: {path?: string; kind: string}) => {
      if (value === query) return {empty: false};
      if (value.path === "users/reader/settings/bookSharing") return {
        exists: false,
        data: () => undefined,
        get: () => undefined,
      };
      if (value.path === "users/reader") return {
        exists: true,
        get: () => undefined,
      };
      assert.fail(`unexpected transaction read ${value.path}`);
    },
    set: (reference: Ref, data: Row) => writes.push({type: "set", reference, data}),
    delete: (reference: Ref) => writes.push({type: "delete", reference}),
  }));
  await functions.syncbooksharingprojection.run({
    params: {userId: "reader", bookId: "book"},
    data: {
      before: {get: () => null},
      after: {get: () => "work-one"},
    },
  });
  const id = sharedWorkOwnerId("work-one", "reader");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].reference.path, `sharedWorkOwners/${id}`);
  assert.equal(writes[0].data?.workId, "work-one");
  assert.equal(writes[0].data?.uid, "reader");
  assert.equal(writes[0].data?.updatedAt instanceof Timestamp, true);
});

test("projection handlers converge across opt-out, tombstone, retry, and last-book changes", async (t) => {
  interface Reference {
    path: string;
    id: string;
    get(): Promise<Snap>;
  }
  interface Snap {
    exists: boolean;
    ref: Reference;
    id: string;
    data(): Row | undefined;
    get(field: string): unknown;
  }
  type Filter = [field: string, operator: string, value: unknown];
  interface Query {
    _query: true;
    name: string;
    filters: Filter[];
    maximum: number;
    afterPath: string | null;
    where(field: string, operator: string, value: unknown): Query;
    limit(maximum: number): Query;
    orderBy(): Query;
    startAfter(snapshot: Snap): Query;
    get(): Promise<{docs: Snap[]; size: number; empty: boolean}>;
    doc(id: string): Reference;
  }
  const rows = new Map<string, Row>();
  const refs = new Map<string, Reference>();
  const ref = (path: string): Reference => {
    const existing = refs.get(path);
    if (existing !== undefined) return existing;
    const reference: Reference = {
      path,
      id: path.slice(path.lastIndexOf("/") + 1),
      get: async () => snap(reference),
    };
    refs.set(path, reference);
    return reference;
  };
  const snap = (reference: Reference): Snap => ({
    exists: rows.has(reference.path),
    ref: reference,
    id: reference.id,
    data: () => rows.get(reference.path),
    get: (field: string) => rows.get(reference.path)?.[field],
  });
  const querySnapshot = (query: Query): {docs: Snap[]; size: number; empty: boolean} => {
    const prefix = `${query.name}/`;
    const docs = [...rows.keys()]
      .filter((path) => path.startsWith(prefix) &&
        !path.slice(prefix.length).includes("/"))
      .sort()
      .filter((path) => query.afterPath === null || path > query.afterPath)
      .map(ref)
      .filter((reference) => query.filters.every(([field, operator, value]) =>
        operator === "==" ? rows.get(reference.path)?.[field] === value :
          rows.get(reference.path)?.[field] !== value))
      .slice(0, query.maximum)
      .map(snap);
    return {docs, size: docs.length, empty: docs.length === 0};
  };
  const query = (name: string): Query => {
    const result: Query = {
      _query: true,
      name,
      filters: [],
      maximum: Infinity,
      afterPath: null,
      where: (field: string, operator: string, value: unknown) => {
        assert.ok(operator === "==" || operator === "!=");
        result.filters.push([field, operator, value]);
        return result;
      },
      limit: (maximum: number) => {
        result.maximum = maximum;
        return result;
      },
      orderBy: () => result,
      startAfter: (snapshot: Snap) => {
        result.afterPath = snapshot.ref.path;
        return result;
      },
      get: async () => querySnapshot(result),
      doc: (id: string) => ref(`${name}/${id}`),
    };
    return result;
  };
  t.mock.method(db, "doc", ref);
  t.mock.method(db, "collection", query);
  t.mock.method(db, "runTransaction", async (handler: (transaction: {
    get(value: Query | Reference): Promise<unknown>;
    set(reference: Reference, data: Row): void;
    delete(reference: Reference): void;
  }) => Promise<unknown>) => handler({
    get: async (value: Query | Reference) => "_query" in value ? querySnapshot(value) : snap(value),
    set: (reference: Reference, data: Row) => rows.set(reference.path, data),
    delete: (reference: Reference) => rows.delete(reference.path),
  }));
  const change = (before: Row | undefined, after: Row | undefined) => ({
    before: {data: () => before, get: (field: string) => before?.[field]},
    after: {data: () => after, get: (field: string) => after?.[field]},
  });
  const uid = "reader";
  const workId = "work-one";
  const projectionPath = `sharedWorkOwners/${sharedWorkOwnerId(workId, uid)}`;
  const on = {enabled: true, timeZone: "UTC"};
  const off = {enabled: false, timeZone: "UTC"};
  rows.set(`users/${uid}`, {uid});
  rows.set(`works/${workId}`, {status: "active"});

  // Sharing is on by default: with no setting at all, the book event and
  // its retry both converge on the same deterministic row.
  rows.set(`users/${uid}/books/book-one`, {workId});
  const linkEvent = {
    params: {userId: uid, bookId: "book-one"},
    data: change({workId: null}, {workId}),
  };
  await functions.syncbooksharingprojection.run(linkEvent);
  await functions.syncbooksharingprojection.run(linkEvent);
  assert.deepEqual({
    workId: rows.get(projectionPath)?.workId,
    uid: rows.get(projectionPath)?.uid,
  }, {workId, uid});

  // Opting out removes it; opting back in recreates it from the setting
  // handler. A time-zone-only edit is not a consent change.
  rows.set(`users/${uid}/settings/bookSharing`, off);
  await functions.syncsharingsettingprojection.run({
    params: {userId: uid},
    data: change(undefined, off),
  });
  assert.equal(rows.has(projectionPath), false);
  rows.set(`users/${uid}/settings/bookSharing`, on);
  await functions.syncsharingsettingprojection.run({
    params: {userId: uid},
    data: change(off, on),
  });
  assert.equal(rows.has(projectionPath), true);
  rows.delete(projectionPath);
  await functions.syncsharingsettingprojection.run({
    params: {userId: uid},
    data: change(on, {enabled: true, timeZone: "Asia/Kolkata"}),
  });
  assert.equal(rows.has(projectionPath), false, "a time-zone edit must not refresh");
  rows.set(projectionPath, {workId, uid, updatedAt: Timestamp.now()});

  // A tombstoned account stops sharing through the account handler; other
  // account writes (the Toggl mirror, sign-up) are ignored.
  rows.set(`users/${uid}`, {uid, deletedAt: Timestamp.fromMillis(5)});
  await functions.syncsharingaccountprojection.run({
    params: {userId: uid},
    data: change({uid}, {uid, deletedAt: Timestamp.fromMillis(5)}),
  });
  assert.equal(rows.has(projectionPath), false);
  rows.set(`users/${uid}`, {uid});
  rows.set(projectionPath, {workId, uid, updatedAt: Timestamp.now()});
  rows.delete(projectionPath);
  await functions.syncsharingaccountprojection.run({
    params: {userId: uid},
    data: change({uid}, {uid, toggl: {status: "connected"}}),
  });
  assert.equal(rows.has(projectionPath), false, "an unrelated account write must not refresh");

  // Removing the final reread deletes membership, and opting out also
  // deletes a recreated row even when the linked book still exists.
  rows.set(projectionPath, {workId, uid, updatedAt: Timestamp.now()});
  rows.delete(`users/${uid}/books/book-one`);
  await functions.syncbooksharingprojection.run({
    params: {userId: uid, bookId: "book-one"},
    data: change({workId}, undefined),
  });
  assert.equal(rows.has(projectionPath), false);
  rows.set(`users/${uid}/books/book-two`, {workId});
  await functions.syncbooksharingprojection.run({
    params: {userId: uid, bookId: "book-two"},
    data: change(undefined, {workId}),
  });
  assert.equal(rows.has(projectionPath), true);
  rows.set(`users/${uid}/settings/bookSharing`, off);
  await functions.syncsharingsettingprojection.run({
    params: {userId: uid},
    data: change(on, off),
  });
  assert.equal(rows.has(projectionPath), false);

  // Owner-wide refreshes query only linked books and converge beyond the old
  // 100-row boundary; unlinked attacker rows add no reads to this query.
  rows.set(`users/${uid}/settings/bookSharing`, on);
  for (let index = 0; index < 105; index += 1) {
    rows.set(`works/bulk-work-${String(index).padStart(3, "0")}`, {status: "active"});
    rows.set(`users/${uid}/books/bulk-${String(index).padStart(3, "0")}`, {
      workId: `bulk-work-${String(index).padStart(3, "0")}`,
    });
  }
  await functions.syncsharingsettingprojection.run({
    params: {userId: uid},
    data: change(off, on),
  });
  assert.equal([...rows.keys()].filter((path) =>
    path.startsWith("sharedWorkOwners/")).length, 106);
  rows.set(`users/${uid}/settings/bookSharing`, off);
  await functions.syncsharingsettingprojection.run({
    params: {userId: uid},
    data: change(on, off),
  });
  assert.equal([...rows.keys()].some((path) => path.startsWith("sharedWorkOwners/")), false);

  // Many rereads of the same works do not consume the distinct-work bound.
  for (let index = 0; index < 300; index += 1) {
    rows.set(`users/${uid}/books/reread-${String(index).padStart(3, "0")}`, {workId});
  }
  rows.set(`users/${uid}/settings/bookSharing`, on);
  await functions.syncsharingsettingprojection.run({
    params: {userId: uid},
    data: change(off, on),
  });
  assert.equal(rows.has(projectionPath), true);
  rows.set(`users/${uid}/settings/bookSharing`, off);
  await functions.syncsharingsettingprojection.run({
    params: {userId: uid},
    data: change(on, off),
  });
  for (let index = 0; index < 300; index += 1) {
    rows.delete(`users/${uid}/books/reread-${String(index).padStart(3, "0")}`);
  }

  // Granting consent is not bounded either: an owner with more linked works
  // than one page is projected in full. Refusing above a bound wrote none of
  // their rows and left their sharing silently doing nothing, forever.
  const errors: unknown[][] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => errors.push(args));
  for (let index = 105; index < 201; index += 1) {
    rows.set(`users/${uid}/books/bulk-${String(index).padStart(3, "0")}`, {
      workId: `bulk-work-${String(index).padStart(3, "0")}`,
    });
  }
  rows.set(`users/${uid}/settings/bookSharing`, on);
  await functions.syncsharingsettingprojection.run({
    params: {userId: uid},
    data: change(off, on),
  });
  // 201 bulk works plus the still-linked book-two.
  assert.equal([...rows.keys()].filter((path) =>
    path.startsWith("sharedWorkOwners/")).length, 202);
  assert.deepEqual(errors, []);

  // Withdrawn consent is not bounded: a reader who accumulated more rows
  // than the fan-out bound, one link at a time, loses every one of them,
  // not none (the old revoke path refused above 200 and left them all).
  rows.set(`users/${uid}/settings/bookSharing`, off);
  for (let index = 0; index < 201; index += 1) {
    const staleWorkId = `stale-work-${String(index).padStart(3, "0")}`;
    rows.set(`sharedWorkOwners/${sharedWorkOwnerId(staleWorkId, uid)}`, {
      workId: staleWorkId, uid, updatedAt: Timestamp.now(),
    });
  }
  errors.length = 0;
  await functions.syncsharingsettingprojection.run({
    params: {userId: uid},
    data: change(on, off),
  });
  assert.equal([...rows.keys()].some((path) => path.startsWith("sharedWorkOwners/")), false);
  assert.deepEqual(errors, []);
});

test("user creation merges identity without erasing concurrent setup", async (t) => {
  const writes: Write[] = [];
  const lifecycleRef = {};
  const userRef = {
    collection: (name: string) => {
      assert.equal(name, "timerLifecycle");
      return {doc: (id: string) => {
        assert.equal(id, "current");
        return lifecycleRef;
      }};
    },
  };
  t.mock.method(db, "collection", (path: string) => {
    assert.equal(path, "users");
    return {
      doc: (uid: string) => {
        assert.equal(uid, "owner");
        return userRef;
      },
    };
  });
  t.mock.method(db, "runTransaction", async (handler: (transaction: {
    get(ref: object): Promise<{exists: boolean}>;
    set(ref: object, value: Record<string, unknown>, options?: Record<string, unknown>): void;
  }) => Promise<unknown>) => handler({
    get: async (ref: object) => {
      assert.equal(ref, lifecycleRef);
      return {exists: false};
    },
    set: (ref: object, value: Record<string, unknown>, options?: Record<string, unknown>) =>
      writes.push([ref, value, options]),
  }));

  await functions.createUserDocument.run({
    uid: "owner",
    email: "owner@example.test",
  });

  assert.deepEqual(writes, [
    [userRef, {email: "owner@example.test", uid: "owner"}, {merge: true}],
    [lifecycleRef, {version: 1, state: "idle", cleared: null}, undefined],
  ]);
});

test("a retried user creation never overwrites an existing timer lifecycle", async (t) => {
  const writes: Write[] = [];
  const lifecycleRef = {};
  const userRef = {
    collection: () => ({doc: () => lifecycleRef}),
  };
  t.mock.method(db, "collection", () => ({doc: () => userRef}));
  t.mock.method(db, "runTransaction", async (handler: (transaction: {
    get(): Promise<{exists: boolean}>;
    set(ref: object, value: Record<string, unknown>, options?: Record<string, unknown>): void;
  }) => Promise<unknown>) => handler({
    get: async () => ({exists: true}),
    set: (ref: object, value: Record<string, unknown>, options?: Record<string, unknown>) =>
      writes.push([ref, value, options]),
  }));

  await functions.createUserDocument.run({
    uid: "owner",
    email: "owner@example.test",
  });

  assert.deepEqual(writes, [
    [userRef, {email: "owner@example.test", uid: "owner"}, {merge: true}],
  ]);
});

test("user deletion tombstones the user document and its profiles, deletes only uid-matched markers, and pages by id", async (t) => {
  const noDeleteUser = (): never => assert.fail("the user document and profiles must never be deleted");
  const cleanupEvents: string[] = [];
  const sets: PathWrite[] = [];
  const deletes: string[] = [];

  let userValue: Record<string, unknown> | undefined = {
    email: "owner@example.test",
    uid: "owner",
    toggl: {workspaceId: 3, projectId: 4},
  };
  const userRef = {path: "users/owner", delete: noDeleteUser};
  // The credential in the secrets database is deleted (SEC-004) — the one
  // per-account document deletion runs, and it is idempotent, so a
  // redelivery repeats the no-op delete.
  const credentialDeletes: string[] = [];
  let credentialFailure = false;
  t.mock.method(secretsDb, "doc", (path: string) => {
    assert.equal(path, "togglTokens/owner");
    return {delete: async () => {
      // Order pin (SEC-004 review F4): the tombstone must already be on
      // the user document when the credential is deleted, so a
      // concurrent savetoken's post-write re-check always sees it.
      assert.ok(userValue);
      assert.ok(
        userValue.deletedAt !== undefined,
        "the tombstone must be set before the credential is deleted",
      );
      credentialDeletes.push(path);
      cleanupEvents.push("credential");
      if (credentialFailure) throw new Error("secrets database unavailable");
    }};
  });
  interface ProfileDoc {
    id: string;
    ref: {path: string; delete(): never};
    get(field: string): unknown;
  }
  interface QueryCall {
    orderBy: object | null;
    limit: number | null;
    startAfter: string | null;
  }
  const queries: QueryCall[] = [];
  const pages: ProfileDoc[][] = [];
  let markerOwner = "owner";
  const profileDoc = (name: string, deletedAt: unknown): ProfileDoc => ({
    id: name,
    ref: {path: `profiles/${name}`, delete: noDeleteUser},
    get: (field: string) => {
      assert.equal(field, "deletedAt");
      return deletedAt;
    },
  });
  const profiles = {
    where: (field: string, operator: string, value: unknown) => {
      assert.deepEqual([field, operator, value], ["uid", "==", "owner"]);
      const call: QueryCall = {orderBy: null, limit: null, startAfter: null};
      queries.push(call);
      const query = {
        orderBy: (path: object) => { call.orderBy = path; return query; },
        limit: (size: number) => { call.limit = size; return query; },
        startAfter: (cursor: ProfileDoc) => { call.startAfter = cursor.id; return query; },
        get: async () => {
          const docs = pages.shift() ?? [];
          return {empty: docs.length === 0, size: docs.length, docs};
        },
      };
      return query;
    },
  };
  const discoveryRef = (name: string) => ({path: `profileDiscovery/${name}`});
  t.mock.method(db, "collection", (path: string) => {
    if (path === "profiles") return profiles;
    if (path === "users") return {doc: (uid: string) => { assert.equal(uid, "owner"); return userRef; }};
    assert.equal(path, "profileDiscovery");
    return {doc: (name: string) => discoveryRef(name)};
  });
  // Soft delete: the sharing setting is kept like every other document, and
  // the profile tombstone withdraws consent through the projection trigger.
  t.mock.method(db, "doc", (path: string): never =>
    assert.fail(`account deletion must not touch ${path}`));
  t.mock.method(db, "runTransaction", async (handler: (transaction: {
    get(ref: object): Promise<{exists: boolean; get(field: string): unknown}>;
    set(ref: object, value: Record<string, unknown>, options: Record<string, unknown>): void;
    update(): never;
    delete(): never;
  }) => Promise<unknown>) => handler({
    get: async (ref: object) => {
      assert.equal(ref, userRef);
      return {exists: userValue !== undefined, get: (field: string) => userValue?.[field]};
    },
    set: (ref: object, value: Record<string, unknown>, options: Record<string, unknown>) => {
      assert.equal(ref, userRef);
      sets.push([ref.path, value, options]);
      userValue = {...userValue, ...value};
      cleanupEvents.push("user");
    },
    update: noDeleteUser,
    delete: noDeleteUser,
  }));
  let getAllCount = 0;
  t.mock.method(db, "getAll", async (...refs: Array<{path: string}>) => {
    getAllCount += 1;
    // Every marker exists; its uid is markerOwner (a freed-and-reclaimed
    // name would report a different owner and must be left alone).
    return refs.map((ref) => ({exists: true, ref, get: (field: string) => {
      assert.equal(field, "uid");
      return markerOwner;
    }}));
  });
  let commits = 0;
  t.mock.method(db, "batch", () => ({
    set: (ref: {path: string}, value: Record<string, unknown>, options: Record<string, unknown>) =>
      sets.push([ref.path, value, options]),
    delete: (ref: {path: string}) => deletes.push(ref.path),
    update: noDeleteUser,
    commit: async () => { commits += 1; cleanupEvents.push("profiles"); },
  }));

  // Two full pages and a partial one; page 2's first profile is already
  // tombstoned (a retried delivery) and must not be stamped again, but its
  // marker is still deleted.
  const names = Array.from({length: 250}, (_, i) => `user-${String(i).padStart(3, "0")}`);
  pages.push(names.slice(0, 100).map((n) => profileDoc(n, undefined)));
  pages.push(names.slice(100, 200).map((n, i) => profileDoc(n, i === 0 ? {seconds: 1} : undefined)));
  pages.push(names.slice(200).map((n) => profileDoc(n, undefined)));
  await functions.deleteUserDocument.run({uid: "owner"});
  assert.equal(cleanupEvents[0], "user");
  assert.equal(cleanupEvents.filter((event) => event === "profiles").length, 3);
  assert.ok(cleanupEvents.includes("credential"));

  // The user document keeps every field and gains the tombstone.
  assert.equal(sets[0][0], "users/owner");
  assert.deepEqual(Object.keys(sets[0][1]).sort(), ["deletedAt", "uid"]);
  assert.deepEqual(sets[0][2], {merge: true});
  assert.deepEqual(userValue.toggl, {workspaceId: 3, projectId: 4});
  assert.equal(credentialDeletes.length, 1);
  // Profiles: 249 tombstoned (one already was); three batches; cursor
  // paging by document id.
  const profileSets = sets.slice(1);
  assert.equal(profileSets.length, 249);
  assert.ok(profileSets.every(([path, value, options]) =>
    path.startsWith("profiles/") && Object.keys(value).join() === "deletedAt" && options.merge === true));
  assert.ok(!profileSets.some(([path]) => path === "profiles/user-100"));
  // Markers: all 250 deleted (the already-tombstoned profile's marker too),
  // one getAll per page.
  assert.equal(deletes.length, 250);
  assert.ok(deletes.includes("profileDiscovery/user-100") && deletes.includes("profileDiscovery/user-249"));
  assert.equal(getAllCount, 3);
  assert.equal(commits, 3);
  assert.deepEqual(queries.map((q) => {
    assert.ok(q.orderBy);
    return [q.orderBy.constructor.name, q.limit, q.startAfter];
  }), [
    ["FieldPath", 100, null],
    ["FieldPath", 100, "user-099"],
    ["FieldPath", 100, "user-199"],
  ]);

  // A marker under a freed username that another account now owns is left
  // alone; if its profile is already tombstoned the page commits nothing.
  sets.length = 0; deletes.length = 0; commits = 0;
  markerOwner = "squatter";
  pages.push([profileDoc("ada-lovelace", {seconds: 1})]);
  await functions.deleteUserDocument.run({uid: "owner"});
  assert.deepEqual(sets, [] as PathWrite[]);
  assert.deepEqual(deletes, [] as string[]);
  assert.equal(commits, 0);

  // Redelivery: the user document is already tombstoned, so nothing is
  // written for it.
  sets.length = 0; deletes.length = 0; commits = 0; markerOwner = "owner";
  await functions.deleteUserDocument.run({uid: "owner"});
  assert.deepEqual(sets, [] as PathWrite[]);

  // A uid whose document never existed still gets a tombstone, so the
  // admin overview can tell "deleted" from "orphaned".
  userValue = undefined;
  await functions.deleteUserDocument.run({uid: "owner"});
  assert.equal(sets.length, 1);
  const tombstoneWrite = firstPathWrite(sets);
  assert.equal(tombstoneWrite[1].uid, "owner");

  // A failure in one cleanup subsystem does not prevent the other two from
  // converging, and the retryable trigger still reports the failure.
  sets.length = 0; deletes.length = 0; commits = 0;
  credentialFailure = true;
  pages.push([profileDoc("cleanup-survivor", undefined)]);
  await assert.rejects(
    functions.deleteUserDocument.run({uid: "owner"}),
    /Account deletion cleanup failed/,
  );
  assert.ok(sets.some(([path]) => path === "profiles/cleanup-survivor"));
  assert.ok(deletes.includes("profileDiscovery/cleanup-survivor"));

  // A delivery that fails is retried rather than dropped — for both Auth
  // triggers: nothing else can create users/{uid}.
  assert.equal(functions.deleteUserDocument.__endpoint.eventTrigger.retry, true);
  assert.equal(functions.createUserDocument.__endpoint.eventTrigger.retry, true);
});

test("binds the migrated Runtime Config secret only to booksapi", () => {
  assert.deepEqual(
    functions.booksapi.lookupisbn.__endpoint.secretEnvironmentVariables,
    [{key: "FUNCTIONS_CONFIG_EXPORT"}],
  );
  // The ISBN lookup proxies a metered API key, so it must stay a callable
  // (authenticated) and must never regain the public invoker its
  // predecessor `searchisbn` had.
  assert.notEqual(
    functions.booksapi.lookupisbn.__endpoint.callableTrigger,
    undefined,
  );
  assert.equal(
    functions.booksapi.lookupisbn.__endpoint.httpsTrigger,
    undefined,
  );
  for (const togglFunction of Object.values(functions.toggl)) {
    assert.equal(
      togglFunction.__endpoint.secretEnvironmentVariables,
      undefined,
    );
  }
  for (const callable of [
    functions.toggl.savetoken,
    functions.toggl.start,
    functions.toggl.stop,
  ]) {
    assert.notEqual(callable.__endpoint.callableTrigger, undefined);
  }
});

test("the emulator fixture covers every bound secret with loopback-only data", () => {
  const fixtureLine = readFileSync(
    join(__dirname, "..", ".secret.emulator"),
    "utf8",
  ).trim();
  const separator = fixtureLine.indexOf("=");
  assert.ok(separator > 0);
  const fixtureKey = fixtureLine.slice(0, separator);
  const fixtureValue = JSON.parse(fixtureLine.slice(separator + 1));
  assert.deepEqual(fixtureValue, {
    booksapi: {
      key: "emulator-unused",
      url: "http://127.0.0.1:9/google-books-emulator-must-not-fetch",
    },
  });

  const deployedFunctions = [
    functions.admin.overview,
    functions.admin.catalogapply,
    functions.admin.catalogpreview,
    functions.admin.review,
    functions.booksapi.lookupisbn,
    functions.catalog.search,
    functions.catalog.workreaders,
    functions.createUserDocument,
    functions.deleteUserDocument,
    functions.deletebookupdates,
    functions.syncbooksharingprojection,
    functions.syncsharingaccountprojection,
    functions.syncsharingsettingprojection,
    functions.publicweb,
    functions.telemetry.reportissue,
    ...Object.values(functions.toggl),
  ];
  const boundKeys = deployedFunctions.flatMap((deployedFunction) =>
    (deployedFunction.__endpoint.secretEnvironmentVariables ?? [])
      .map(({key}) => key),
  );
  assert.deepEqual([...new Set(boundKeys)].sort(), [fixtureKey]);

  const packageJson: {scripts: Record<string, string>} = JSON.parse(readFileSync(
    join(__dirname, "..", "package.json"),
    "utf8",
  ));
  const serve = packageJson.scripts.serve;
  assert.match(packageJson.scripts.build, /^npm run clean && npm run sync-shared && tsc$/);
  assert.match(packageJson.scripts.clean, /rmSync\('lib'/);
  assert.ok(
    serve.indexOf("stage-emulator-secrets.js") <
      serve.indexOf("firebase emulators:start"),
  );
  assert.equal(packageJson.scripts.start, "npm run serve");
  assert.equal(packageJson.scripts.shell, "npm run serve");
});

test("runs every function as its dedicated least-privilege identity", () => {
  const publicwebRuntime = "publicweb-runtime@book-tracker-d8f24.iam.gserviceaccount.com";
  const functionsRuntime = "functions-runtime@book-tracker-d8f24.iam.gserviceaccount.com";
  // The one stranger-reachable function reads Firestore and nothing else.
  assert.equal(functions.publicweb.__endpoint.serviceAccountEmail, publicwebRuntime);
  const authenticated = {
    deletebookupdates: functions.deletebookupdates,
    syncbooksharingprojection: functions.syncbooksharingprojection,
    syncsharingaccountprojection: functions.syncsharingaccountprojection,
    syncsharingsettingprojection: functions.syncsharingsettingprojection,
    createUserDocument: functions.createUserDocument,
    deleteUserDocument: functions.deleteUserDocument,
    "admin.overview": functions.admin.overview,
    "admin.catalogapply": functions.admin.catalogapply,
    "admin.review": functions.admin.review,
    "admin.catalogpreview": functions.admin.catalogpreview,
    "booksapi.lookupisbn": functions.booksapi.lookupisbn,
    "catalog.search": functions.catalog.search,
    "catalog.create": functions.catalog.create,
    "catalog.addedition": functions.catalog.addedition,
    "catalog.ensureauthors": functions.catalog.ensureauthors,
    "catalog.workreaders": functions.catalog.workreaders,
    "telemetry.reportissue": functions.telemetry.reportissue,
    "toggl.savetoken": functions.toggl.savetoken,
    "toggl.start": functions.toggl.start,
    "toggl.stop": functions.toggl.stop,
    "toggl.clearstopping": functions.toggl.clearstopping,
    "toggl.cleartoken": functions.toggl.cleartoken,
    "toggl.syncqueue": functions.toggl.syncqueue,
  };
  for (const [name, deployedFunction] of Object.entries(authenticated)) {
    assert.equal(deployedFunction.__endpoint.serviceAccountEmail, functionsRuntime, name);
  }
  // Nothing exported may fall back to a project-default (Editor) identity,
  // including any function added later without a serviceAccount. An unset
  // option is a ResetValue sentinel object, not undefined, hence the
  // typeof check (which also names the offender). Every export must also be
  // named in the tier map above: a new function is assigned a tier here
  // deliberately, not by matching a pattern.
  const exported: Array<[string, EndpointFunction]> = [];
  const walk = (value: unknown, path: string): void => {
    if (isDeployedFunction(value)) {
      exported.push([path, value]);
    } else if (value && (typeof value === "object" || typeof value === "function")) {
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
    }
  };
  walk(functions, "functions");
  const tierEntries: Array<[string, string]> = [
    ["functions.publicweb", publicwebRuntime],
    ...Object.keys(authenticated).map((name): [string, string] =>
      [`functions.${name}`, functionsRuntime]),
  ];
  const tiers = new Map(tierEntries);
  assert.deepEqual(exported.map(([name]) => name).sort(), [...tiers.keys()].sort());
  for (const [name, deployedFunction] of exported) {
    const identity = deployedFunction.__endpoint.serviceAccountEmail;
    assert.equal(typeof identity, "string", `${name} has no serviceAccount`);
    assert.equal(identity, tiers.get(name), name);
  }
  // A raw HTTP surface (httpsTrigger without callableTrigger) is reachable
  // by strangers with no Firebase auth at all, so it must stay on the
  // read-only tier and must not widen its invoker. Callables are HTTP too,
  // but the SDK checks the ID token before any handler runs.
  const raw = exported.filter(([, deployedFunction]) =>
    deployedFunction.__endpoint.httpsTrigger !== undefined &&
    deployedFunction.__endpoint.callableTrigger === undefined);
  assert.deepEqual(raw.map(([name]) => name), ["functions.publicweb"]);
  for (const [name, deployedFunction] of raw) {
    assert.equal(deployedFunction.__endpoint.serviceAccountEmail, publicwebRuntime, name);
    const httpsTrigger = deployedFunction.__endpoint.httpsTrigger;
    assert.ok(httpsTrigger);
    assert.equal(httpsTrigger.invoker, undefined, name);
  }
  // Eventarc delivers from Google's network: exactly the two event-driven
  // gen2 services accept no public ingress. Everything else — callables,
  // the Hosting-rewritten publicweb, and gen1 Auth triggers, which Google
  // invokes over the public endpoint — keeps the default.
  const internalOnly = new Set([
    "functions.deletebookupdates",
    "functions.syncbooksharingprojection",
    "functions.syncsharingaccountprojection",
    "functions.syncsharingsettingprojection",
    "functions.toggl.syncqueue",
  ]);
  for (const [name, deployedFunction] of exported) {
    const ingress = deployedFunction.__endpoint.ingressSettings;
    if (internalOnly.has(name)) assert.equal(ingress, "ALLOW_INTERNAL_ONLY", name);
    else assert.notEqual(typeof ingress, "string", `${name} sets ingress ${String(ingress)}`);
  }
  // The cascade delete is idempotent and must not orphan a subcollection
  // on one failed delivery.
  assert.equal(functions.deletebookupdates.__endpoint.eventTrigger.retry, true);
  // In-flight publicweb requests are part of its memory bound.
  assert.equal(functions.publicweb.__endpoint.concurrency, 16);
  // The cascade delete is stranger-triggerable at will; its spend rate is capped.
  assert.equal(functions.deletebookupdates.__endpoint.maxInstances, 5);
  // Every gen-1 function is invokable (or triggerable) by strangers and is
  // billed before it rejects them: each carries an explicit instance cap.
  const caps: Record<string, number> = {
    "functions.admin.overview": 2,
    "functions.admin.catalogapply": 2,
    "functions.admin.review": 2,
    "functions.admin.catalogpreview": 2,
    "functions.booksapi.lookupisbn": 10,
    "functions.catalog.create": 10,
    "functions.catalog.addedition": 10,
    "functions.catalog.ensureauthors": 10,
    "functions.catalog.search": 10,
    "functions.catalog.workreaders": 10,
    "functions.telemetry.reportissue": 10,
    "functions.toggl.savetoken": 10,
    "functions.toggl.start": 10,
    "functions.toggl.stop": 10,
    "functions.toggl.clearstopping": 10,
    "functions.toggl.cleartoken": 10,
    "functions.createUserDocument": 10,
    "functions.deleteUserDocument": 10,
    "functions.toggl.syncqueue": 5,
    "functions.deletebookupdates": 5,
    "functions.syncbooksharingprojection": 5,
    "functions.syncsharingaccountprojection": 5,
    "functions.syncsharingsettingprojection": 5,
    "functions.publicweb": 2,
  };
  for (const [name, deployedFunction] of exported) {
    assert.equal(deployedFunction.__endpoint.maxInstances, caps[name], `${name} maxInstances`);
  }
  // The admin callables are CPU-bound (gen-1 CPU scales with memory) and
  // the overview is the slowest call in the project; everything else keeps
  // the defaults so a stranger-invokable function never costs more.
  for (const adminFunction of [
    functions.admin.overview,
    functions.admin.catalogapply,
    functions.admin.catalogpreview,
    functions.admin.review,
  ]) {
    assert.equal(adminFunction.__endpoint.availableMemoryMb, 1024);
    assert.equal(adminFunction.__endpoint.timeoutSeconds, 120);
  }
  for (const [name, deployedFunction] of exported) {
    if (name.startsWith("functions.admin.") || deployedFunction.__endpoint.platform !== "gcfv1") continue;
    // Unset memory is a ResetValue sentinel, never a number.
    assert.notEqual(typeof deployedFunction.__endpoint.availableMemoryMb, "number", `${name} memory`);
  }
});

function isDeployedFunction(value: unknown): value is EndpointFunction {
  return (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "__endpoint" in value;
}

function firstPathWrite(writes: PathWrite[]): PathWrite {
  const first = writes[0];
  assert.ok(first);
  return first;
}
