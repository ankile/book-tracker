const assert = require("node:assert/strict");
const test = require("node:test");
const {getFirestore} = require("firebase-admin/firestore");

process.env.GCLOUD_PROJECT = "book-tracker-d8f24";
process.env.FUNCTIONS_CONFIG_EXPORT = JSON.stringify({
  booksapi: {url: "https://books.example/volumes", key: "secret"},
});

const deployed = require("../lib");
const db = getFirestore();
const authContext = {auth: {uid: "owner", token: {}}};

function snapshot(data) {
  return {data: () => data};
}

function installQuotaStore(t) {
  const quotaRef = {};
  let quota;
  t.mock.method(db, "doc", (path) => {
    assert.equal(path, "users/owner/functionQuotas/booksApi");
    return quotaRef;
  });
  t.mock.method(db, "runTransaction", async (handler) => handler({
    get: async (ref) => {
      assert.equal(ref, quotaRef);
      return snapshot(quota);
    },
    set: (ref, value) => {
      assert.equal(ref, quotaRef);
      quota = value;
    },
    update: (ref, patch) => {
      assert.equal(ref, quotaRef);
      quota = {...quota, ...patch};
    },
  }));
  return {quota: () => quota};
}

test("lookupisbn returns sanitized partial metadata", async (t) => {
  const quota = installQuotaStore(t);
  let requestedUrl;
  t.mock.method(global, "fetch", async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify({
      totalItems: 1,
      items: [{
        volumeInfo: {
          title: "The Book",
          authors: ["Ada", "", 7],
          pageCount: 0,
          publisher: null,
        },
      }],
    }), {status: 200});
  });

  assert.deepEqual(
    await deployed.booksapi.lookupisbn.run(
      {isbn: "9780000000002"},
      authContext,
    ),
    {volume: {title: "The Book", authors: ["Ada"], pageCount: 0}},
  );
  assert.equal(
    requestedUrl,
    "https://books.example/volumes?key=secret&q=isbn:9780000000002&country=NO",
  );
  assert.equal(quota.quota().count, 1);
});

test("lookupisbn enforces the per-user hourly quota before fetch", async (t) => {
  installQuotaStore(t);
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({totalItems: 0}), {status: 200});
  });

  for (let index = 0; index < 60; index += 1) {
    assert.deepEqual(
      await deployed.booksapi.lookupisbn.run(
        {isbn: "9780000000002"},
        authContext,
      ),
      {volume: null},
    );
  }
  await assert.rejects(
    deployed.booksapi.lookupisbn.run(
      {isbn: "9780000000002"},
      authContext,
    ),
    (error) => error.code === "resource-exhausted",
  );
  assert.equal(fetchCalls, 60);
});
