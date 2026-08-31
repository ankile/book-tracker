require("./setup.cts");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test").test = require("node:test");
const {getAuth}: typeof import("firebase-admin/auth") = require("firebase-admin/auth");
const {getFirestore, Timestamp}: typeof import("firebase-admin/firestore") = require("firebase-admin/firestore");
const {logger}: typeof import("firebase-functions") = require("firebase-functions");

type TestContext = import("node:test").TestContext;
type AdminIssueRow = import("../src/adminIssues").AdminIssueRow;
type Filter = [field: string, op: string, value: unknown];
interface IssueQueryCall {
  filters: Filter[];
  order: [field: string, direction: string] | null;
  limit: number | null;
}
interface InstallOptions {
  failFor?: string[];
  rowsPerUid?: number;
  failAnonymous?: boolean;
  tombstoned?: string[];
  docs?: string[];
}
interface EmptyQuery {
  where(...args: unknown[]): EmptyQuery;
  orderBy(...args: unknown[]): EmptyQuery;
  limit(...args: unknown[]): EmptyQuery;
  get(): Promise<{docs: never[]}>;
  count(): {get(): Promise<{data(): Record<string, number>}>};
  aggregate(spec: Record<string, unknown>): {
    get(): Promise<{data(): Record<string, number>}>;
  };
}
interface OverviewResult {
  users: Array<{uid: string; anomaly: string | null}>;
  issues: AdminIssueRow[];
  issueCaps: {
    perAccount: number;
    cappedAccounts: number;
    anonymous: number;
    anonymousCapped: boolean;
    shown: number;
    total: number;
    groupsWithRows: number;
    groupsShown: number;
    unreadAccounts: number;
    anonymousUnread: boolean;
  };
}
interface Deployed {
  admin: {overview: {run(data: unknown, context: unknown): Promise<OverviewResult>}};
}

const deployed: Deployed = require("../lib");
const {
  ANONYMOUS_ISSUE_LIMIT,
  FEED_LIMIT,
  ISSUES_PER_UID,
}: typeof import("../src/adminIssues") = require("../lib/adminIssues");

const db = getFirestore();
const auth = getAuth();
const adminContext = {
  auth: {uid: "1Cf0CaNfgnVSvTrF5dYjzRd9Xri2", token: {email_verified: true}},
};

const emptyAggregate = (value: Record<string, number>) => ({
  get: async () => ({data: () => value}),
});
const emptyQuery = (): EmptyQuery => {
  const query: EmptyQuery = {
    where: () => query,
    orderBy: () => query,
    limit: () => query,
    get: async () => ({docs: []}),
    count: () => emptyAggregate({count: 0}),
    aggregate: (spec: Record<string, unknown>) => emptyAggregate(
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
function installOverviewStore(
  t: TestContext,
  uids: string[],
  {
    failFor = [],
    rowsPerUid = 0,
    failAnonymous = false,
    tombstoned = [],
    docs = [],
  }: InstallOptions = {},
): IssueQueryCall[] {
  const issueQueries: IssueQueryCall[] = [];
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
  t.mock.method(db, "collection", (name: string) => {
    if (name === "adminAudit") return {add: async () => ({id: "audit"})};
    if (name === "users") {
      const userDoc = (uid: string) => ({
        id: uid,
        get: (field: string) => {
          if (field === "deletedAt") return tombstoned.includes(uid) ? Timestamp.fromMillis(1) : undefined;
          if (field === "email") return `${uid}@doc.test`;
          assert.fail(`unexpected user field ${field}`);
        },
      });
      const docIds = [...new Set([...docs, ...tombstoned])];
      return {
        doc: (uid: string) => ({
          get: async () => ({
            exists: true,
            get: (field: string) => field === "deletedAt" && tombstoned.includes(uid) ?
              Timestamp.fromMillis(1) : undefined,
          }),
        }),
        get: async () => ({docs: docIds.map(userDoc)}),
        listDocuments: async () => [...new Set([...uids, ...docIds])].map((uid) => ({id: uid})),
      };
    }
    if (name === "logEvents") {
      const call: IssueQueryCall = {filters: [], order: null, limit: null};
      issueQueries.push(call);
      const query = {
        where: (field: string, op: string, value: unknown) => {
          call.filters.push([field, op, value]);
          return query;
        },
        orderBy: (field: string, direction: string) => {
          call.order = [field, direction];
          return query;
        },
        limit: (value: number) => {
          call.limit = value;
          return query;
        },
        get: async () => {
          const uid = call.filters.find(([field]) => field === "uid")?.[2];
          if (typeof uid === "string" && failFor.includes(uid)) {
            throw new Error(`simulated failure for ${uid}`);
          }
          if (uid === null && failAnonymous) throw new Error("simulated anonymous failure");
          if (uid === null || rowsPerUid === 0) return {docs: []};
          assert.ok(typeof uid === "string");
          assert.ok(call.limit !== null);
          // Newest first, as Firestore would return them; the limit is honoured
          // so the test sees exactly what the callable asked for.
          return {docs: Array.from({length: Math.min(rowsPerUid, call.limit)}, (_, index) => ({
            id: `${uid}-${index}`,
            createTime: Timestamp.fromMillis(1),
            data: () => ({
              createdAt: Timestamp.fromMillis(2_000_000 - uids.indexOf(uid) * 100 - index),
              level: "error",
              event: "firestore.write_failed",
              message: `${uid}/${index}`,
              code: null,
              uid,
              detail: null,
            }),
          }))};
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
    groupsWithRows: 0,
    groupsShown: 0,
    unreadAccounts: 0,
    anonymousUnread: false,
  });
  assert.ok(FEED_LIMIT >= ISSUES_PER_UID);
});

test("the callable applies the shipped caps and the shipped feed limit to the wire", async (t) => {
  // 30 accounts x cap+1 rows read: over the per-account cap (so
  // cappedAccounts must count all 30) and over FEED_LIMIT once capped
  // (300 > 200), so the wire has to show the cut. The empty-feed test
  // above cannot see any of this: with zero documents, passing a literal
  // instead of FEED_LIMIT, swapping the two cap arguments, and reporting
  // `shown: feed.total` all produce the same wire (round-3 red-team).
  const uids = Array.from({length: 30}, (_, index) => `account-${index}`);
  installOverviewStore(t, uids, {rowsPerUid: ISSUES_PER_UID + 1});

  const result = await deployed.admin.overview.run({}, adminContext);

  assert.equal(result.issues.length, FEED_LIMIT);
  assert.equal(result.issueCaps.shown, FEED_LIMIT);
  assert.equal(result.issueCaps.total, uids.length * ISSUES_PER_UID);
  assert.equal(result.issueCaps.cappedAccounts, uids.length);
  assert.equal(result.issueCaps.anonymousCapped, false);
  assert.equal(result.issueCaps.groupsWithRows, uids.length);
  assert.equal(result.issueCaps.groupsShown, uids.length);
  const perUid = new Map<string | null, number>();
  for (const row of result.issues) perUid.set(row.uid, (perUid.get(row.uid) ?? 0) + 1);
  // Round-robin: every account is present and none exceeds its cap.
  assert.equal(perUid.size, uids.length);
  assert.ok(Math.max(...perUid.values()) <= ISSUES_PER_UID);
  for (let index = 1; index < result.issues.length; index += 1) {
    assert.ok(result.issues[index - 1].at >= result.issues[index].at);
  }
});

test("one failed per-account read is dropped, logged and counted, not fatal", async (t) => {
  const uids = ["owner", "broken", "stranger"];
  installOverviewStore(t, uids, {failFor: ["broken"]});
  const errors: unknown[][] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => errors.push(args));

  const result = await deployed.admin.overview.run({}, adminContext);

  assert.equal(result.users.length, 3);
  assert.equal(result.issueCaps.unreadAccounts, 1);
  assert.equal(result.issueCaps.anonymousUnread, false);
  assert.deepEqual(errors, [[
    "admin.issues.read_failed",
    {uid: "broken", message: "simulated failure for broken"},
  ]]);
});

test("a failed uid-null read is reported separately from failed accounts", async (t) => {
  installOverviewStore(t, ["owner"], {failAnonymous: true});
  t.mock.method(logger, "error", () => undefined);
  const result = await deployed.admin.overview.run({}, adminContext);
  assert.equal(result.issueCaps.unreadAccounts, 0);
  assert.equal(result.issueCaps.anonymousUnread, true);
});

test("when every read fails the feed is empty but the wire says why", async (t) => {
  // A missing composite index fails every per-account read at once; the
  // page must not read that as "all clear" (round-3 red-team).
  const uids = ["owner", "stranger", "third"];
  installOverviewStore(t, uids, {failFor: uids, failAnonymous: true});
  const errors: unknown[][] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => errors.push(args));
  const result = await deployed.admin.overview.run({}, adminContext);
  assert.deepEqual(result.issues, []);
  assert.equal(result.issueCaps.unreadAccounts, uids.length);
  assert.equal(result.issueCaps.anonymousUnread, true);
  assert.equal(errors.length, uids.length + 1);
});

// A deleted account keeps a tombstoned document (SEC-006). The overview
// must show it as the expected state of a deleted account, keep the
// pre-tombstone anomalies for documents that are merely orphaned, and
// flag a tombstone whose auth user still exists.
test("the overview labels tombstoned accounts and keeps orphan anomalies apart", async (t) => {
  installOverviewStore(t, ["live", "stale"], {
    tombstoned: ["gone", "stale"],
    docs: ["live", "orphan-doc"],
  });
  const result = await deployed.admin.overview.run({}, adminContext);
  const anomalies = Object.fromEntries(result.users.map((row) => [row.uid, row.anomaly]));
  assert.deepEqual(anomalies, {
    live: null,
    gone: "account deleted",
    stale: "tombstoned but auth user exists",
    "orphan-doc": "auth user deleted",
  });
});
