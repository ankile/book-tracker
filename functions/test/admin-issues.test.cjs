require("./setup.cjs");

const assert = require("node:assert/strict");
const test = require("node:test");
const {Timestamp} = require("firebase-admin/firestore");
const {ANONYMOUS_ISSUE_LIMIT, assembleIssueFeed, FEED_LIMIT, ISSUES_PER_UID} = require("../lib/adminIssues");

const createdAt = Timestamp.fromMillis(1_700_000_000_000);
const fallbackAt = 1_600_000_000_000;

const validIssue = (overrides = {}) => ({
  createdAt,
  level: "warn",
  event: "toggl.sync_stuck",
  message: "The sync is stuck.",
  code: null,
  uid: "owner",
  detail: null,
  ...overrides,
});

const document = (id, value, metadataAt = fallbackAt) => ({
  id,
  value,
  fallbackAt: metadataAt,
});

const identities = new Map([
  ["owner", {email: "owner@example.test", verified: true}],
]);

// Rows for one account (or uid-null) as the feed query would return them.
const group = (uid, documents) => ({uid, documents});
const feedOf = (documents, limit = 10) =>
  assembleIssueFeed([group("owner", documents)], limit, limit, 1000, identities);

test("valid issue rows retain decoded fields and resolve identities", () => {
  const {rows, cappedAccounts, anonymousCapped} = feedOf([
    document("known", validIssue({code: "deadline-exceeded"})),
    document("deleted", validIssue({uid: "deleted"})),
    document("anonymous", validIssue({uid: null, detail: {email: "claim@example.test"}})),
  ]);

  assert.equal(cappedAccounts, 0);
  assert.equal(anonymousCapped, false);
  assert.deepEqual(rows.map(({email, emailVerified, malformed}) => ({
    email,
    emailVerified,
    malformed,
  })), [
    {
      email: "owner@example.test",
      emailVerified: true,
      malformed: false,
    },
    {
      email: "(deleted user)",
      emailVerified: false,
      malformed: false,
    },
    {
      email: "(anonymous)",
      emailVerified: false,
      malformed: false,
    },
  ]);
  assert.equal(rows[0].at, createdAt.toMillis());
  assert.equal(rows[0].message, "The sync is stuck.");
  assert.equal(rows[0].code, "deadline-exceeded");
  assert.doesNotMatch(JSON.stringify(rows), /claim@example\.test/);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  for (const row of rows) assert.match(row.id, /^[a-f0-9]{64}$/);
});

test("every malformed field shape becomes the same fixed placeholder", () => {
  const malformedValues = [
    validIssue({level: "debug"}),
    validIssue({event: {secret: "event-secret"}}),
    validIssue({message: {secret: "message-secret"}}),
    validIssue({message: "message-secret".repeat(100)}),
    validIssue({code: {secret: "code-secret"}}),
    validIssue({code: "code-secret".repeat(20)}),
    validIssue({uid: {secret: "uid-secret"}}),
    validIssue({uid: ""}),
    validIssue({uid: "u".repeat(129)}),
    validIssue({detail: {email: {secret: "detail-secret"}}}),
    validIssue({detail: {email: "safe@example.test", password: "detail-secret"}}),
    validIssue({detail: {email: "detail-secret".repeat(40)}}),
    validIssue({createdAt: "timestamp-secret"}),
  ];
  const rows = feedOf(
    malformedValues.map((value, index) => document(`malformed-${index}`, value)),
    malformedValues.length,
  ).rows;

  assert.equal(rows.length, malformedValues.length);
  for (const [index, row] of rows.entries()) {
    const {id, ...safeFields} = row;
    assert.match(id, /^[a-f0-9]{64}$/);
    assert.notEqual(id, `malformed-${index}`);
    assert.deepEqual(safeFields, {
      at: index === malformedValues.length - 1 ? fallbackAt : createdAt.toMillis(),
      level: "error",
      event: "logEvents.malformed",
      code: "MALFORMED_STORED_ISSUE",
      message: "Stored issue record is malformed. Its fields were hidden.",
      uid: null,
      email: "(malformed issue)",
      emailVerified: false,
      malformed: true,
    });
  }
  const rendered = JSON.stringify(rows);
  for (const secret of [
    "message-secret",
    "code-secret",
    "event-secret",
    "uid-secret",
    "detail-secret",
    "timestamp-secret",
  ]) {
    assert.doesNotMatch(rendered, new RegExp(secret));
  }
});

test("the feed is newest-first across accounts and keeps identity per row", () => {
  const {rows} = assembleIssueFeed([
    group("owner", [
      document("owner-new", validIssue({createdAt: Timestamp.fromMillis(3_000), message: "owner new"})),
      document("owner-old", validIssue({createdAt: Timestamp.fromMillis(1_000), message: "owner old"})),
    ]),
    group("stranger", [
      document("stranger-mid", validIssue({uid: "stranger", createdAt: Timestamp.fromMillis(2_000), message: "stranger"})),
      document("stranger-bad", validIssue({level: "attacker-level", uid: "stranger", createdAt: Timestamp.fromMillis(500)})),
    ]),
  ], 10, 10, 1000, identities);

  assert.deepEqual(rows.map((row) => [row.message, row.email, row.at]), [
    ["owner new", "owner@example.test", 3_000],
    ["stranger", "(deleted user)", 2_000],
    ["owner old", "owner@example.test", 1_000],
    ["Stored issue record is malformed. Its fields were hidden.", "(malformed issue)", 500],
  ]);
  assert.equal(rows[3].malformed, true);
  assert.equal(rows[3].uid, null);
});

test("caller-controlled document ids never cross the callable boundary", () => {
  const secretId = "password=Secret1@example.com";
  const rows = feedOf([
    document(secretId, validIssue({level: "attacker-level"})),
  ]).rows;

  assert.equal(rows.length, 1);
  assert.match(rows[0].id, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(rows), /Secret1@example\.com/);
});

test("each account is capped at the per-account limit, uid-null rows at their own", () => {
  const flood = Array.from({length: 12}, (_, index) =>
    document(`flood-${index}`, validIssue({uid: "flooder", message: `flood ${index}`})));
  const anonymous = Array.from({length: 4}, (_, index) =>
    document(`anon-${index}`, validIssue({uid: null, message: `anon ${index}`})));
  const {rows, cappedAccounts, anonymousCapped} = assembleIssueFeed([
    group("flooder", flood.slice(0, 11)),
    group("owner", [document("owner-1", validIssue({message: "owner"}))]),
    group(null, anonymous),
  ], 10, 3, 1000, identities);

  assert.equal(cappedAccounts, 1);
  assert.equal(anonymousCapped, true);
  assert.equal(rows.filter((row) => row.uid === "flooder").length, 10);
  assert.equal(rows.filter((row) => row.uid === null).length, 3);
  assert.equal(rows.filter((row) => row.uid === "owner").length, 1);
  // Exactly at the cap is not capped: the query reads cap + 1 to tell.
  assert.deepEqual(
    assembleIssueFeed([group("flooder", flood.slice(0, 10))], 10, 3, 1000, identities).cappedAccounts,
    0,
  );
  // A malformed row that still names an account counts against it.
  const capped = assembleIssueFeed([group("flooder", [
    ...flood.slice(0, 10),
    document("bad", validIssue({level: "attacker-level", uid: "flooder"})),
  ])], 10, 3, 1000, identities);
  assert.equal(capped.cappedAccounts, 1);
  assert.equal(capped.rows.length, 10);
});

test("the shipped feed caps are the documented ones", () => {
  // README and the admin page copy state these numbers; the red-team of
  // fd4f0fd found the cap could be changed to anything without a test
  // noticing.
  assert.equal(ISSUES_PER_UID, 10);
  assert.equal(ANONYMOUS_ISSUE_LIMIT, 25);
  assert.equal(FEED_LIMIT, 200);
});

test("the feed limit bounds the response after the per-account caps and reports the total", () => {
  const groups = Array.from({length: 30}, (_, account) =>
    group(`account-${account}`, Array.from({length: 10}, (_, index) =>
      document(`row-${account}-${index}`, validIssue({
        uid: `account-${account}`,
        createdAt: Timestamp.fromMillis(1_000_000 - account * 10 - index),
        message: `${account}/${index}`,
      })))));
  const feed = assembleIssueFeed(groups, 10, 25, 200, identities);
  assert.equal(feed.total, 300);
  assert.equal(feed.rows.length, 200);
  // The cut keeps the newest rows across accounts, not the first accounts.
  assert.equal(feed.rows[0].message, "0/0");
  assert.equal(feed.rows[199].at, 1_000_000 - 19 * 10 - 9);
  assert.equal(feed.cappedAccounts, 0);
});

