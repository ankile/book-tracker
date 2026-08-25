require("./setup.cjs");

const assert = require("node:assert/strict");
const test = require("node:test");
const {Timestamp} = require("firebase-admin/firestore");
const {mapIssueDocuments} = require("../lib/adminIssues");

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

test("valid issue rows retain decoded fields and resolve identities", () => {
  const {rows, truncated} = mapIssueDocuments([
    document("known", validIssue({code: "deadline-exceeded"})),
    document("deleted", validIssue({uid: "deleted"})),
    document("anonymous", validIssue({uid: null, detail: {email: "claim@example.test"}})),
  ], 10, identities);

  assert.equal(truncated, false);
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
  const rows = mapIssueDocuments(
    malformedValues.map((value, index) => document(`malformed-${index}`, value)),
    malformedValues.length,
    identities,
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

test("mapping preserves snapshot order, cardinality, identity, and truncation", () => {
  const {rows, truncated} = mapIssueDocuments([
    document("newest", validIssue({message: "newest"})),
    document("malformed-middle", validIssue({level: "attacker-level"})),
    document("older", validIssue({message: "older"})),
  ], 2, identities);

  assert.equal(truncated, true);
  assert.equal(rows[0].message, "newest");
  assert.equal(rows[1].event, "logEvents.malformed");
  assert.equal(rows.length, 2);
  assert.equal(rows[1].malformed, true);
});

test("caller-controlled document ids never cross the callable boundary", () => {
  const secretId = "password=Secret1@example.com";
  const rows = mapIssueDocuments([
    document(secretId, validIssue({level: "attacker-level"})),
  ], 1, identities).rows;

  assert.equal(rows.length, 1);
  assert.match(rows[0].id, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(rows), /Secret1@example\.com/);
});
