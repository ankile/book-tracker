require("./setup.cjs");

const assert = require("node:assert/strict");
const test = require("node:test");
const {Timestamp} = require("firebase-admin/firestore");
const {applyQuota} = require("../lib/quota");

function transaction() {
  const writes = [];
  return {
    writes,
    set: (_ref, data) => writes.push({type: "set", data}),
    update: (_ref, data) => writes.push({type: "update", data}),
  };
}

test("weighted quotas count every admitted unit", () => {
  const now = Timestamp.now();
  const tx = transaction();
  assert.deepEqual(
    applyQuota(tx, {}, {windowStartedAt: now, count: 55}, 60, 3_600_000, now, 5),
    {granted: true},
  );
  assert.deepEqual(tx.writes, [{type: "update", data: {count: 60}}]);
});

test("a weighted request that crosses the limit records exactly one refusal", () => {
  const now = Timestamp.now();
  const first = transaction();
  assert.deepEqual(
    applyQuota(first, {}, {windowStartedAt: now, count: 55}, 60, 3_600_000, now, 6),
    {granted: false, firstRefusal: true},
  );
  assert.deepEqual(first.writes, [{type: "update", data: {count: 61}}]);

  const repeated = transaction();
  assert.deepEqual(
    applyQuota(repeated, {}, {windowStartedAt: now, count: 61}, 60, 3_600_000, now, 6),
    {granted: false, firstRefusal: false},
  );
  assert.deepEqual(repeated.writes, []);
});

test("a new weighted quota window starts at the requested amount", () => {
  const now = Timestamp.now();
  const tx = transaction();
  assert.deepEqual(applyQuota(tx, {}, undefined, 60, 3_600_000, now, 4), {granted: true});
  assert.equal(tx.writes[0].type, "set");
  assert.equal(tx.writes[0].data.count, 4);
  assert.equal(tx.writes[0].data.windowStartedAt, now);
});
