import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  decodeConnection,
  decodeTimerV2,
  decodeClaimV2,
  decodeTimerIntent,
  decodeQueueV2,
  effectiveConnection,
  initialQueue,
  claimV2,
  idleV2,
  sameConnection,
} from "../shared/timeTracking.ts";
import type {
  Connection,
  TimerIntent,
  TimerV2,
} from "../shared/timeTracking.ts";
import {
  decodeTimeTrackingRequest,
  decodeTimeTrackingResponse,
} from "../shared/time-tracking-api.ts";
import { auditTimerClaimState } from "../timer-claim-migration.ts";
const connection: Connection = {
  provider: "threeggle",
  revision: "revision-a",
  serviceId: "service-a",
  accountId: "account-a",
  projectId: "reading",
};
const intent: TimerIntent = {
  version: 2,
  operationId: randomUUID(),
  timerId: randomUUID(),
  bookId: "book",
  connection,
  action: "stop",
  start: "2026-09-13T12:00:00.000Z",
  end: "2026-09-13T13:00:00.000Z",
  description: "A private book title",
  remote: null,
};
const timer: TimerV2 = {
  version: 2,
  timerId: intent.timerId,
  operationId: randomUUID(),
  connection,
  state: "local",
  start: intent.start,
  claimedAt: Date.parse(intent.start),
  remote: null,
  queueId: null,
  errorCode: null,
};

test("explicit None and Threeggle choices override old Toggl mirrors", () => {
  assert.equal(
    effectiveConnection({ toggl: { workspaceId: 1, projectId: 2 } }).provider,
    "toggl",
  );
  assert.equal(
    effectiveConnection({
      timeTracking: { provider: "none", revision: "selected" },
      toggl: { workspaceId: 1, projectId: 2 },
    }).provider,
    "none",
  );
  assert.deepEqual(
    effectiveConnection({
      timeTracking: connection,
      toggl: { workspaceId: 1, projectId: 2 },
    }),
    connection,
  );
  assert.deepEqual(effectiveConnection({}), {
    provider: "none",
    revision: "legacy",
  });
});
test("connection revisions, account identities and project types remain distinct", () => {
  assert.equal(
    sameConnection(connection, { ...connection, revision: "new" }),
    false,
  );
  assert.equal(
    sameConnection(connection, { ...connection, accountId: "other" }),
    false,
  );
  assert.equal(
    sameConnection(connection, { ...connection, projectId: "other" }),
    false,
  );
  assert.throws(() => decodeConnection({ ...connection, projectId: 4 }));
  assert.throws(() =>
    decodeConnection({
      provider: "toggl",
      revision: "r",
      accountId: "a",
      workspaceId: 1,
      projectId: "2",
    }),
  );
  assert.throws(() =>
    decodeConnection({ ...connection, apiToken: "never in user documents" }),
  );
});
test("v2 timers and claims decode known states and reject provider-reference confusion", () => {
  assert.deepEqual(decodeTimerV2(timer), timer);
  assert.deepEqual(
    decodeClaimV2(claimV2("book", timer)),
    claimV2("book", timer),
  );
  assert.deepEqual(decodeClaimV2(idleV2("book", timer)), idleV2("book", timer));
  assert.throws(() =>
    decodeTimerV2({
      ...timer,
      state: "remote",
      remote: { provider: "toggl", entryId: 1 },
    }),
  );
  assert.throws(() =>
    decodeTimerV2({ ...timer, state: "remote", remote: null }),
  );
  assert.throws(() =>
    decodeTimerV2({
      ...timer,
      state: "stopping",
      remote: { provider: "threeggle", entryKey: "key" },
    }),
  );
  assert.throws(() => decodeTimerV2({ ...timer, entryId: "key" }));
  assert.throws(() =>
    decodeClaimV2({ version: 3, state: "idle", cleared: null }),
  );
});
test("retained queues keep original intent independently of normalized frozen requests", () => {
  const row = initialQueue(intent, Date.now());
  row.prepared = {
    provider: "threeggle",
    request: {
      client: "book-tracker",
      action: "create_interval",
      requestId: intent.operationId,
      description: intent.description,
      projectId: connection.projectId,
      startTime: Date.parse(intent.start) - 60000,
      endTime: Date.parse(intent.end ?? "") - 60000,
    },
  };
  row.status = "terminal";
  row.errorCode = "interval_overlap";
  assert.deepEqual(decodeQueueV2(row), row);
  assert.equal(row.intent.start, intent.start);
  assert.throws(() => decodeQueueV2({ ...row, status: "garbage" }));
  assert.throws(() => decodeQueueV2({ ...row, secret: "token" }));
  assert.throws(() =>
    decodeTimerIntent({ ...intent, remote: { provider: "toggl", entryId: 5 } }),
  );
});
test("the audit reads v2 timers, checks correlation and never prints a private title", () => {
  assert.deepEqual(
    auditTimerClaimState([{ id: "book", data: { activeTimer: timer } }], {
      exists: true,
      data: claimV2("book", timer),
    }),
    [],
  );
  assert.deepEqual(
    auditTimerClaimState([{ id: "book", data: { activeTimer: null } }], {
      exists: true,
      data: idleV2("book", timer),
    }),
    [],
  );
  const findings = auditTimerClaimState(
    [{ id: "book", data: { activeTimer: timer, title: intent.description } }],
    { exists: true, data: claimV2("other", timer) },
  );
  assert.equal(findings[0].cls, "timer-lifecycle.mismatch");
  assert.equal(JSON.stringify(findings).includes(intent.description), false);
});
test("both repositories keep the same protocol module and shared fixtures", async () => {
  const source = await readFile(
    new URL("../shared/time-tracking-api.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /Version 1 wire contract/);
  const fixtures: unknown = JSON.parse(
    await readFile(
      new URL("../shared/time-tracking-fixtures.json", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(Array.isArray(fixtures));
  for (const fixture of fixtures) {
    assert.ok(
      typeof fixture === "object" &&
        fixture !== null &&
        "request" in fixture &&
        "response" in fixture,
    );
    assert.ok(decodeTimeTrackingRequest(fixture.request));
    assert.ok(decodeTimeTrackingResponse(fixture.response));
  }
});
test("the protocol rejects extra request fields, bad operation IDs and malformed entry responses", () => {
  assert.equal(
    decodeTimeTrackingRequest({
      client: "book-tracker",
      action: "start",
      requestId: "not-uuid",
    }),
    null,
  );
  assert.equal(
    decodeTimeTrackingRequest({
      client: "book-tracker",
      action: "context",
      token: "secret",
    }),
    null,
  );
  assert.throws(() =>
    decodeTimeTrackingResponse({
      apiVersion: 1,
      ok: true,
      result: { entry: { key: 1 } },
    }),
  );
  assert.throws(() =>
    decodeTimeTrackingResponse({
      apiVersion: 2,
      ok: false,
      error: { code: "unauthorized", message: "denied" },
    }),
  );
});
