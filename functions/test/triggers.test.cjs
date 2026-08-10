const assert = require("node:assert/strict");
const test = require("node:test");

process.env.GCLOUD_PROJECT = "book-tracker-d8f24";

const functions = require("../lib");

test("preserves the deployed function export names", () => {
  assert.deepEqual(Object.keys(functions).sort(), [
    "admin",
    "bookIsFinished",
    "booksapi",
    "createUserDocument",
    "deleteUserDocument",
    "deletebookupdates",
    "toggl",
  ]);
  assert.deepEqual(Object.keys(functions.admin), ["overview"]);
  assert.deepEqual(Object.keys(functions.booksapi), ["searchisbn"]);
  assert.deepEqual(Object.keys(functions.toggl).sort(), [
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
    functions.bookIsFinished,
    functions.createUserDocument,
    functions.deleteUserDocument,
    functions.booksapi.searchisbn,
    functions.toggl.savetoken,
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
});

test("preserves the Firestore and Authentication event contracts", () => {
  assert.equal(
    functions.bookIsFinished.__trigger.eventTrigger.eventType,
    "providers/cloud.firestore/eventTypes/document.update",
  );
  assert.match(
    functions.bookIsFinished.__trigger.eventTrigger.resource,
    /documents\/users\/\{userId\}\/books\/\{bookId\}$/,
  );
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

test("binds the migrated Runtime Config secret only to booksapi", () => {
  assert.deepEqual(
    functions.booksapi.searchisbn.__endpoint.secretEnvironmentVariables,
    [{key: "FUNCTIONS_CONFIG_EXPORT"}],
  );
  assert.deepEqual(
    functions.booksapi.searchisbn.__endpoint.httpsTrigger.invoker,
    ["public"],
  );
  assert.equal(
    functions.bookIsFinished.__endpoint.secretEnvironmentVariables,
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
