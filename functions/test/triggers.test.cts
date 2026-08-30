require("./setup.cts");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const {readFileSync}: typeof import("node:fs") = require("node:fs");
const {join}: typeof import("node:path") = require("node:path");
const test: typeof import("node:test").test = require("node:test");
const {getFirestore}: typeof import("firebase-admin/firestore") = require("firebase-admin/firestore");

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
  admin: {overview: DeployedFunction};
  booksapi: {lookupisbn: DeployedFunction};
  createUserDocument: DeployedFunction;
  deleteUserDocument: DeployedFunction;
  deletebookupdates: DeployedFunction;
  publicweb: EndpointFunction;
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

const functions: FunctionsBundle = require("../lib");
const db = getFirestore();
const secretsDb = getFirestore("secrets");

test("preserves the deployed function export names", () => {
  assert.deepEqual(Object.keys(functions).sort(), [
    "admin",
    "booksapi",
    "createUserDocument",
    "deleteUserDocument",
    "deletebookupdates",
    "publicweb",
    "telemetry",
    "toggl",
  ]);
  assert.deepEqual(Object.keys(functions.admin), ["overview"]);
  assert.deepEqual(Object.keys(functions.booksapi), ["lookupisbn"]);
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
    functions.createUserDocument,
    functions.deleteUserDocument,
    functions.booksapi.lookupisbn,
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
    commit: async () => { commits += 1; },
  }));

  // Two full pages and a partial one; page 2's first profile is already
  // tombstoned (a retried delivery) and must not be stamped again, but its
  // marker is still deleted.
  const names = Array.from({length: 250}, (_, i) => `user-${String(i).padStart(3, "0")}`);
  pages.push(names.slice(0, 100).map((n) => profileDoc(n, undefined)));
  pages.push(names.slice(100, 200).map((n, i) => profileDoc(n, i === 0 ? {seconds: 1} : undefined)));
  pages.push(names.slice(200).map((n) => profileDoc(n, undefined)));
  await functions.deleteUserDocument.run({uid: "owner"});

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
  assert.deepEqual(sets, []);
  assert.deepEqual(deletes, []);
  assert.equal(commits, 0);

  // Redelivery: the user document is already tombstoned, so nothing is
  // written for it.
  sets.length = 0; deletes.length = 0; commits = 0; markerOwner = "owner";
  await functions.deleteUserDocument.run({uid: "owner"});
  assert.deepEqual(sets, []);

  // A uid whose document never existed still gets a tombstone, so the
  // admin overview can tell "deleted" from "orphaned".
  userValue = undefined;
  await functions.deleteUserDocument.run({uid: "owner"});
  assert.equal(sets.length, 1);
  const tombstoneWrite = firstPathWrite(sets);
  assert.equal(tombstoneWrite[1].uid, "owner");

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
    functions.booksapi.lookupisbn,
    functions.createUserDocument,
    functions.deleteUserDocument,
    functions.deletebookupdates,
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
  assert.match(packageJson.scripts.build, /^npm run clean && tsc$/);
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
    createUserDocument: functions.createUserDocument,
    deleteUserDocument: functions.deleteUserDocument,
    "admin.overview": functions.admin.overview,
    "booksapi.lookupisbn": functions.booksapi.lookupisbn,
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
  const internalOnly = new Set(["functions.deletebookupdates", "functions.toggl.syncqueue"]);
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
    "functions.booksapi.lookupisbn": 10,
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
    "functions.publicweb": 2,
  };
  for (const [name, deployedFunction] of exported) {
    assert.equal(deployedFunction.__endpoint.maxInstances, caps[name], `${name} maxInstances`);
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
