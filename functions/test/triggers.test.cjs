require("./setup.cjs");

const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const test = require("node:test");
const {getFirestore} = require("firebase-admin/firestore");

const functions = require("../lib");
const db = getFirestore();

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
  assert.equal(
    functions.createUserDocument.__trigger.eventTrigger.eventType,
    "providers/firebase.auth/eventTypes/user.create",
  );
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
  const writes = [];
  const lifecycleRef = {};
  const userRef = {
    collection: (name) => {
      assert.equal(name, "timerLifecycle");
      return {doc: (id) => {
        assert.equal(id, "current");
        return lifecycleRef;
      }};
    },
  };
  t.mock.method(db, "collection", (path) => {
    assert.equal(path, "users");
    return {
      doc: (uid) => {
        assert.equal(uid, "owner");
        return userRef;
      },
    };
  });
  t.mock.method(db, "runTransaction", async (handler) => handler({
    get: async (ref) => {
      assert.equal(ref, lifecycleRef);
      return {exists: false};
    },
    set: (ref, value, options) => writes.push([ref, value, options]),
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
  const writes = [];
  const lifecycleRef = {};
  const userRef = {
    collection: () => ({doc: () => lifecycleRef}),
  };
  t.mock.method(db, "collection", () => ({doc: () => userRef}));
  t.mock.method(db, "runTransaction", async (handler) => handler({
    get: async () => ({exists: true}),
    set: (ref, value, options) => writes.push([ref, value, options]),
  }));

  await functions.createUserDocument.run({
    uid: "owner",
    email: "owner@example.test",
  });

  assert.deepEqual(writes, [
    [userRef, {email: "owner@example.test", uid: "owner"}, {merge: true}],
  ]);
});

test("user deletion pages through profiles, deletes only markers it still owns, and retries", async (t) => {
  const userRef = {path: "users/owner", deleted: 0, delete: async function() { this.deleted += 1; }};
  const pages = [];
  const deletes = [];
  let commits = 0;
  let markerOwner = "owner";
  let getAllCount = 0;
  const profileRef = (name) => ({path: `profiles/${name}`});
  const discoveryRef = (name) => ({path: `profileDiscovery/${name}`});
  const profiles = {
    where: (field, operator, value) => {
      assert.deepEqual([field, operator, value], ["uid", "==", "owner"]);
      return {limit: (size) => {
        assert.equal(size, 100);
        return {get: async () => {
          const docs = pages.shift() ?? [];
          return {empty: docs.length === 0, size: docs.length, docs};
        }};
      }};
    },
  };
  const ownerRef = {path: "profileOwners/owner", deleted: 0, delete: async function() { this.deleted += 1; }};
  t.mock.method(db, "collection", (path) => {
    if (path === "profiles") return profiles;
    if (path === "users") return {doc: (uid) => {
      assert.equal(uid, "owner");
      return userRef;
    }};
    if (path === "profileOwners") return {doc: (uid) => {
      assert.equal(uid, "owner");
      return ownerRef;
    }};
    assert.equal(path, "profileDiscovery");
    return {doc: (username) => discoveryRef(username)};
  });
  t.mock.method(db, "getAll", async (...refs) => {
    getAllCount += 1;
    return refs.map((ref) => ({exists: true, ref, get: (field) => {
      assert.equal(field, "uid");
      return markerOwner;
    }}));
  });
  t.mock.method(db, "batch", () => ({
    delete: (ref) => deletes.push(ref.path),
    commit: async () => {
      commits += 1;
    },
  }));

  // Two full pages and a partial one: three batches, three marker lookups.
  const names = Array.from({length: 250}, (_, i) => `user-${String(i).padStart(3, "0")}`);
  pages.push(names.slice(0, 100).map((n) => ({id: n, ref: profileRef(n)})));
  pages.push(names.slice(100, 200).map((n) => ({id: n, ref: profileRef(n)})));
  pages.push(names.slice(200).map((n) => ({id: n, ref: profileRef(n)})));
  await functions.deleteUserDocument.run({uid: "owner"});
  assert.equal(userRef.deleted, 1);
  // The one-profile-per-account record goes with the user document.
  assert.equal(ownerRef.deleted, 1);
  assert.equal(commits, 3);
  assert.equal(getAllCount, 3);
  assert.equal(deletes.length, 500);
  assert.ok(deletes.includes("profiles/user-249") && deletes.includes("profileDiscovery/user-249"));

  // A marker under the same username that another account now owns (the
  // name was freed and re-claimed) is left alone.
  deletes.length = 0;
  markerOwner = "squatter";
  pages.push([{id: "ada-lovelace", ref: profileRef("ada-lovelace")}]);
  await functions.deleteUserDocument.run({uid: "owner"});
  assert.deepEqual(deletes, ["profiles/ada-lovelace"]);

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

  const packageJson = JSON.parse(readFileSync(
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
  const exported = [];
  const walk = (value, path) => {
    if (value && value.__endpoint) exported.push([path, value]);
    else if (value && (typeof value === "object" || typeof value === "function")) {
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
    }
  };
  walk(functions, "functions");
  const tiers = new Map([
    ["functions.publicweb", publicwebRuntime],
    ...Object.keys(authenticated).map((name) => [`functions.${name}`, functionsRuntime]),
  ]);
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
    assert.equal(deployedFunction.__endpoint.httpsTrigger.invoker, undefined, name);
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
  const caps = {
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
