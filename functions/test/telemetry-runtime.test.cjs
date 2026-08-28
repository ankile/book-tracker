require("./setup.cjs");

const assert = require("node:assert/strict");
const test = require("node:test");
const {getFirestore, Timestamp} = require("firebase-admin/firestore");

const deployed = require("../lib");
const db = getFirestore();
const authContext = {auth: {uid: "owner", token: {}}};
const report = {
  level: "error",
  event: "firestore.listener_failed",
  message: "Couldn't load books",
  code: "permission-denied",
};

function snapshot(data) {
  return {data: () => data};
}

// Mirrors booksapi-runtime: the quota transaction and the logEvents add are
// the only Firestore calls the callable makes, and both go through the
// singleton getFirestore() instance, so mocking that instance captures them.
function installStore(t, initialQuota) {
  const quotaRef = {};
  let quota = initialQuota;
  const rows = [];
  t.mock.method(db, "doc", (path) => {
    assert.equal(path, "users/owner/functionQuotas/issueReports");
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
  t.mock.method(db, "collection", (name) => {
    assert.equal(name, "logEvents");
    return {
      add: async (row) => {
        rows.push(row);
        return {id: `row-${rows.length}`};
      },
    };
  });
  return {quota: () => quota, rows};
}

test("reportissue stores an allowlisted row under the caller's uid", async (t) => {
  const store = installStore(t);
  const before = Date.now();

  assert.deepEqual(
    await deployed.telemetry.reportissue.run(report, authContext),
    {recorded: true},
  );
  assert.equal(store.rows.length, 1);
  const [row] = store.rows;
  assert.deepEqual(Object.keys(row).sort(), [
    "code", "createdAt", "detail", "event", "expiresAt", "level", "message", "uid",
  ]);
  assert.equal(row.level, "error");
  assert.equal(row.event, "firestore.listener_failed");
  assert.equal(row.message, "Couldn't load books");
  assert.equal(row.code, "permission-denied");
  assert.equal(row.uid, "owner");
  assert.equal(row.detail, null);
  assert.ok(row.createdAt instanceof Timestamp);
  assert.ok(row.createdAt.toMillis() >= before);
  assert.equal(
    row.expiresAt.toMillis() - row.createdAt.toMillis(),
    90 * 24 * 60 * 60 * 1000,
  );
  assert.equal(store.quota().count, 1);
});

test("a null code is stored as null", async (t) => {
  const store = installStore(t);
  await deployed.telemetry.reportissue.run({...report, code: null}, authContext);
  assert.equal(store.rows[0].code, null);
});

test("reportissue refuses anonymous callers before touching Firestore", async (t) => {
  const store = installStore(t);
  await assert.rejects(
    deployed.telemetry.reportissue.run(report, {auth: undefined}),
    (error) => error.code === "unauthenticated",
  );
  assert.equal(store.rows.length, 0);
  assert.equal(store.quota(), undefined);
});

test("malformed reports are rejected before the quota is consumed", async (t) => {
  const store = installStore(t);
  for (const broken of [
    {...report, event: "toggl.sync_failed"},
    {...report, event: "auth.sign_in_failed"},
    {...report, uid: "someone-else"},
    {...report, detail: {email: "a@example.test"}},
    {...report, message: "x".repeat(1001)},
    {...report, level: "info"},
    "firestore.listener_failed",
  ]) {
    await assert.rejects(
      deployed.telemetry.reportissue.run(broken, authContext),
      (error) => error.code === "invalid-argument",
    );
  }
  assert.equal(store.rows.length, 0);
  assert.equal(store.quota(), undefined);
});

test("reportissue enforces the per-user hourly quota before storing", async (t) => {
  const store = installStore(t);
  for (let index = 0; index < 20; index += 1) {
    assert.deepEqual(
      await deployed.telemetry.reportissue.run(report, authContext),
      {recorded: true},
    );
  }
  await assert.rejects(
    deployed.telemetry.reportissue.run(report, authContext),
    (error) => error.code === "resource-exhausted",
  );
  assert.equal(store.rows.length, 20);
  assert.equal(store.quota().count, 20);
});

test("an expired or malformed quota window restarts at one", async (t) => {
  const expired = installStore(t, {
    windowStartedAt: Timestamp.fromMillis(Date.now() - 61 * 60 * 1000),
    count: 20,
  });
  await deployed.telemetry.reportissue.run(report, authContext);
  assert.equal(expired.quota().count, 1);
  assert.equal(expired.rows.length, 1);

  const malformed = installStore(t, {windowStartedAt: "yesterday", count: "many"});
  await deployed.telemetry.reportissue.run(report, authContext);
  assert.equal(malformed.quota().count, 1);
  assert.ok(malformed.quota().windowStartedAt instanceof Timestamp);
});
