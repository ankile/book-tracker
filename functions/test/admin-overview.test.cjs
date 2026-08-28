require("./setup.cjs");

const assert = require("node:assert/strict");
const test = require("node:test");
const {getAuth} = require("firebase-admin/auth");
const {getFirestore} = require("firebase-admin/firestore");
const {logger} = require("firebase-functions");

const deployed = require("../lib");
const {ANONYMOUS_ISSUE_LIMIT, FEED_LIMIT, ISSUES_PER_UID} = require("../lib/adminIssues");

const db = getFirestore();
const auth = getAuth();
const adminContext = {
  auth: {uid: "1Cf0CaNfgnVSvTrF5dYjzRd9Xri2", token: {email_verified: true}},
};

const emptyAggregate = (value) => ({get: async () => ({data: () => value})});
const emptyQuery = () => {
  const query = {
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    get: async () => ({docs: []}),
    count: () => emptyAggregate({count: 0}),
    aggregate: (spec) => emptyAggregate(
      Object.fromEntries(Object.keys(spec).map((key) => [key, 0])),
    ),
  };
  return query;
};

// Records every logEvents query the overview builds. The per-account read
// is the whole of the SEC-038 mitigation, so the filters and the limit it
// sends to Firestore are the thing under test, not just how the rows are
// assembled afterwards (round-2 red-team: dropping the uid filter or the
// +1 survived the suite before this file existed).
function installOverviewStore(t, uids, {failFor = []} = {}) {
  const issueQueries = [];
  t.mock.method(auth, "listUsers", async () => ({
    users: uids.map((uid) => ({
      uid,
      email: `${uid}@example.test`,
      emailVerified: true,
      metadata: {},
    })),
    pageToken: undefined,
  }));
  t.mock.method(db, "doc", () => ({}));
  t.mock.method(db, "collectionGroup", () => emptyQuery());
  t.mock.method(db, "collection", (name) => {
    if (name === "adminAudit") return {add: async () => ({id: "audit"})};
    if (name === "users") {
      return {
        get: async () => ({docs: []}),
        listDocuments: async () => uids.map((uid) => ({id: uid})),
      };
    }
    if (name === "logEvents") {
      const call = {filters: [], order: null, limit: null};
      issueQueries.push(call);
      const query = {
        where: (field, op, value) => {
          call.filters.push([field, op, value]);
          return query;
        },
        orderBy: (field, direction) => {
          call.order = [field, direction];
          return query;
        },
        limit: (value) => {
          call.limit = value;
          return query;
        },
        get: async () => {
          const uid = call.filters.find(([field]) => field === "uid")?.[2];
          if (failFor.includes(uid)) throw new Error(`simulated failure for ${uid}`);
          return {docs: []};
        },
      };
      return query;
    }
    return emptyQuery();
  });
  return issueQueries;
}

test("the issue feed reads one uid-pinned, cap+1 query per account", async (t) => {
  const uids = ["owner", "stranger"];
  const issueQueries = installOverviewStore(t, uids);

  const result = await deployed.admin.overview.run({}, adminContext);

  // One query per account plus exactly one for uid-null rows: a shared
  // scan is what let a single flooding account age everyone else out
  // (SEC-038).
  assert.equal(issueQueries.length, uids.length + 1);
  const pinned = issueQueries.map((call) => {
    const uidFilter = call.filters.find(([field]) => field === "uid");
    assert.ok(uidFilter, "every issue query must pin a uid");
    assert.equal(uidFilter[1], "==");
    assert.ok(call.filters.some(([f, op]) => f === "createdAt" && op === ">="));
    assert.deepEqual(call.order, ["createdAt", "desc"]);
    return [uidFilter[2], call.limit];
  });
  // limit is cap + 1 so "exactly at the cap" is distinguishable from
  // "over it"; with .limit(cap), issueCaps.cappedAccounts could never
  // be true.
  assert.deepEqual(pinned, [
    ["owner", ISSUES_PER_UID + 1],
    ["stranger", ISSUES_PER_UID + 1],
    [null, ANONYMOUS_ISSUE_LIMIT + 1],
  ]);
  assert.deepEqual(result.issueCaps, {
    perAccount: ISSUES_PER_UID,
    cappedAccounts: 0,
    anonymous: ANONYMOUS_ISSUE_LIMIT,
    anonymousCapped: false,
    shown: 0,
    total: 0,
    unreadAccounts: 0,
  });
  assert.ok(FEED_LIMIT >= ISSUES_PER_UID);
});

test("one failed per-account read is dropped, logged and counted, not fatal", async (t) => {
  const uids = ["owner", "broken", "stranger"];
  installOverviewStore(t, uids, {failFor: ["broken"]});
  const errors = [];
  t.mock.method(logger, "error", (...args) => errors.push(args));

  const result = await deployed.admin.overview.run({}, adminContext);

  assert.equal(result.users.length, 3);
  assert.equal(result.issueCaps.unreadAccounts, 1);
  assert.deepEqual(errors, [[
    "admin.issues.read_failed",
    {uid: "broken", message: "simulated failure for broken"},
  ]]);
});
