const assert = require("node:assert/strict");
const test = require("node:test");

process.env.GCLOUD_PROJECT = "book-tracker-d8f24";

const functions = require("../lib");

test("preserves the deployed function export names", () => {
  assert.deepEqual(Object.keys(functions).sort(), [
    "bookIsFinished",
    "booksapi",
    "createUserDocument",
    "deleteUserDocument",
    "toggl",
  ]);
  assert.deepEqual(Object.keys(functions.booksapi), ["searchisbn"]);
  assert.deepEqual(Object.keys(functions.toggl).sort(), [
    "savetoken",
    "start",
    "stop",
  ]);
});

test("keeps every function on first generation in europe-west1", () => {
  const deployedFunctions = [
    functions.bookIsFinished,
    functions.createUserDocument,
    functions.deleteUserDocument,
    functions.booksapi.searchisbn,
    functions.toggl.savetoken,
    functions.toggl.start,
    functions.toggl.stop,
  ];

  for (const deployedFunction of deployedFunctions) {
    assert.equal(deployedFunction.__endpoint.platform, "gcfv1");
    assert.deepEqual(deployedFunction.__endpoint.region, ["europe-west1"]);
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
    assert.notEqual(togglFunction.__endpoint.callableTrigger, undefined);
  }
});
