require("./setup.cjs");

const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {join} = require("node:path");
const test = require("node:test");
const {getFirestore} = require("firebase-admin/firestore");
const firebaseFunctions = require("firebase-functions/v1");

const functions = require("../lib");
const db = getFirestore();
const deploymentTarget = JSON.parse(readFileSync(
  join(__dirname, "..", "..", "deployment-target.json"),
  "utf8",
));

const exportedFunctions = new Map([
  ["admin-overview", functions.admin.overview],
  ["booksapi-lookupisbn", functions.booksapi.lookupisbn],
  ["createUserDocument", functions.createUserDocument],
  ["deleteUserDocument", functions.deleteUserDocument],
  ["deletebookupdates", functions.deletebookupdates],
  ["publicweb", functions.publicweb],
  ["toggl-clearstopping", functions.toggl.clearstopping],
  ["toggl-savetoken", functions.toggl.savetoken],
  ["toggl-start", functions.toggl.start],
  ["toggl-stop", functions.toggl.stop],
  ["toggl-syncqueue", functions.toggl.syncqueue],
]);

function endpointEventFilters(endpoint) {
  const trigger = endpoint.eventTrigger;
  if (trigger === undefined) return [];
  const filters = Object.entries(trigger.eventFilters ?? {}).map(
    ([attribute, rawValue]) => ({
      attribute,
      value: attribute === "resource" ?
        `projects/${deploymentTarget.projectId}` : rawValue,
    }),
  );
  for (const [attribute, value] of
    Object.entries(trigger.eventFilterPathPatterns ?? {})) {
    filters.push({attribute, value, operator: "match-path-pattern"});
  }
  return filters.sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function manifestEventFilters(event) {
  return [...event.filters].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function resolvedOption(value, defaultValue) {
  return value === null || value === firebaseFunctions.RESET_VALUE ?
    defaultValue : value;
}

test("preserves the deployed function export names", () => {
  assert.deepEqual(Object.keys(functions).sort(), [
    "admin",
    "booksapi",
    "createUserDocument",
    "deleteUserDocument",
    "deletebookupdates",
    "publicweb",
    "toggl",
  ]);
  assert.deepEqual(Object.keys(functions.admin), ["overview"]);
  assert.deepEqual(Object.keys(functions.booksapi), ["lookupisbn"]);
  assert.deepEqual(Object.keys(functions.toggl).sort(), [
    "clearstopping",
    "savetoken",
    "start",
    "stop",
    "syncqueue",
  ]);

  assert.equal(deploymentTarget.releaseId, "security-2026-08-26-01");
  assert.deepEqual(deploymentTarget.hostingOrigins, [
    "https://book-tracker-d8f24.web.app",
    "https://book-tracker-d8f24.firebaseapp.com",
    "https://book.ankile.com",
  ]);
  assert.deepEqual(deploymentTarget.functions.map(({name, generation, region}) => ({
    name,
    generation,
    region,
  })), [
    {name: "admin-overview", generation: "GEN_1", region: "europe-west1"},
    {name: "booksapi-lookupisbn", generation: "GEN_1", region: "europe-west1"},
    {name: "createUserDocument", generation: "GEN_1", region: "europe-west1"},
    {name: "deleteUserDocument", generation: "GEN_1", region: "europe-west1"},
    {name: "deletebookupdates", generation: "GEN_2", region: "europe-west1"},
    {name: "publicweb", generation: "GEN_2", region: "europe-west1"},
    {name: "toggl-clearstopping", generation: "GEN_1", region: "europe-west1"},
    {name: "toggl-savetoken", generation: "GEN_1", region: "europe-west1"},
    {name: "toggl-start", generation: "GEN_1", region: "europe-west1"},
    {name: "toggl-stop", generation: "GEN_1", region: "europe-west1"},
    {name: "toggl-syncqueue", generation: "GEN_2", region: "europe-west1"},
  ]);
  assert.deepEqual(deploymentTarget.functions.map(({name, access}) => ({name, access})), [
    {name: "admin-overview", access: "callable"},
    {name: "booksapi-lookupisbn", access: "callable"},
    {name: "createUserDocument", access: "event"},
    {name: "deleteUserDocument", access: "event"},
    {name: "deletebookupdates", access: "event"},
    {name: "publicweb", access: "http"},
    {name: "toggl-clearstopping", access: "callable"},
    {name: "toggl-savetoken", access: "callable"},
    {name: "toggl-start", access: "callable"},
    {name: "toggl-stop", access: "callable"},
    {name: "toggl-syncqueue", access: "event"},
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

  for (const deployedFunction of [...gen1Functions, ...gen2Functions, functions.publicweb]) {
    assert.equal(
      deployedFunction.__endpoint.labels["book-tracker-release"],
      deploymentTarget.releaseId,
    );
  }
});

test("binds every production function declaration to exported metadata", () => {
  assert.deepEqual(
    [...exportedFunctions.keys()].sort(),
    deploymentTarget.functions.map(({name}) => name).sort(),
  );

  for (const target of deploymentTarget.functions) {
    const deployedFunction = exportedFunctions.get(target.name);
    const endpoint = deployedFunction.__endpoint;
    const generation = endpoint.platform === "gcfv2" ? "GEN_2" : "GEN_1";
    const access = endpoint.eventTrigger !== undefined ? "event" :
      endpoint.callableTrigger !== undefined ? "callable" : "http";
    const defaultServiceAccount = generation === "GEN_2" ?
      `${deploymentTarget.projectNumber}-compute@developer.gserviceaccount.com` :
      `${deploymentTarget.projectId}@appspot.gserviceaccount.com`;
    const defaultMaxInstances = generation === "GEN_2" ? 20 :
      access === "event" ? 3000 : null;

    assert.equal(generation, target.generation, `${target.name} generation`);
    assert.deepEqual(endpoint.region, [target.region], `${target.name} region`);
    assert.equal(access, target.access, `${target.name} access`);
    assert.equal(
      resolvedOption(endpoint.timeoutSeconds, 60),
      target.timeoutSeconds,
      `${target.name} timeout`,
    );
    assert.equal(
      resolvedOption(endpoint.maxInstances, defaultMaxInstances),
      target.maxInstances,
      `${target.name} max instances`,
    );
    assert.equal(
      resolvedOption(endpoint.serviceAccountEmail, defaultServiceAccount),
      target.serviceAccount,
      `${target.name} service account`,
    );
    assert.deepEqual(
      (endpoint.secretEnvironmentVariables ?? []).map(({key}) => key).sort(),
      target.secrets.map(({key}) => key).sort(),
      `${target.name} secrets`,
    );
    assert.deepEqual(
      target.functionIam,
      generation === "GEN_1" && access !== "event" ? [{
        role: "roles/cloudfunctions.invoker",
        members: ["allUsers"],
      }] : [],
      `${target.name} Function IAM`,
    );
    assert.deepEqual(
      target.runIam,
      generation === "GEN_1" ? null : access === "http" ? [{
        role: "roles/run.invoker",
        members: ["allUsers"],
      }] : [],
      `${target.name} Cloud Run IAM`,
    );
    assert.equal(
      endpoint.labels["book-tracker-release"],
      deploymentTarget.releaseId,
      `${target.name} release`,
    );

    if (target.event === null) {
      assert.equal(endpoint.eventTrigger, undefined, `${target.name} event`);
    } else {
      assert.equal(
        endpoint.eventTrigger.eventType,
        target.event.type,
        `${target.name} event type`,
      );
      assert.equal(
        endpoint.eventTrigger.retry,
        target.event.retry,
        `${target.name} retry`,
      );
      assert.deepEqual(
        endpointEventFilters(endpoint),
        manifestEventFilters(target.event),
        `${target.name} event filters`,
      );
    }
  }
});

test("public web responses expose the deployed release id", async () => {
  const response = {
    body: undefined,
    headers: {},
    statusCode: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };

  await functions.publicweb(
    {method: "GET", path: "/not-a-public-route"},
    response,
  );

  assert.equal(response.statusCode, 404);
  assert.equal(
    response.headers["X-Book-Tracker-Release"],
    deploymentTarget.releaseId,
  );
  assert.match(response.body, /This profile was not found/);
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

test("user deletion removes public profiles and discovery markers atomically", async (t) => {
  const userRef = {path: "users/owner"};
  const profileRef = {path: "profiles/ada-lovelace"};
  const discoveryRef = {path: "profileDiscovery/ada-lovelace"};
  const deletes = [];
  let committed = false;
  const profiles = {
    where: (field, operator, value) => {
      assert.deepEqual([field, operator, value], ["uid", "==", "owner"]);
      return {get: async () => ({docs: [{id: "ada-lovelace", ref: profileRef}]})};
    },
  };
  t.mock.method(db, "collection", (path) => {
    if (path === "profiles") return profiles;
    if (path === "users") return {doc: (uid) => {
      assert.equal(uid, "owner");
      return userRef;
    }};
    assert.equal(path, "profileDiscovery");
    return {doc: (username) => {
      assert.equal(username, "ada-lovelace");
      return discoveryRef;
    }};
  });
  t.mock.method(db, "batch", () => ({
    delete: (ref) => deletes.push(ref),
    commit: async () => {
      committed = true;
    },
  }));

  await functions.deleteUserDocument.run({uid: "owner"});

  assert.deepEqual(deletes, [userRef, profileRef, discoveryRef]);
  assert.equal(committed, true);
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
