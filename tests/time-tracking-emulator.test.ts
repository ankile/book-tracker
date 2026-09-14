import './setup.ts';
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  initialQueue,
  decodeQueueV2,
  claimV2,
} from "../shared/timeTracking.ts";
import type {
  Connection,
  TimerIntent,
  TimerV2,
} from "../shared/timeTracking.ts";
import { decodeTimeTrackingRequest } from "../shared/time-tracking-api.ts";
import type {
  TimeTrackingEntry,
  TimeTrackingResponse,
} from "../shared/time-tracking-api.ts";
const requireFunctions = createRequire(
  new URL("../functions/package.json", import.meta.url),
);
requireFunctions("./lib");
const { getFirestore } = requireFunctions(
  "firebase-admin/firestore",
) as typeof import("firebase-admin/firestore");
const { acceptTimerIntent, processTimerQueue } = requireFunctions(
  "./lib/timeTrackingQueue",
) as {
  acceptTimerIntent: (
    uid: string,
    intent: TimerIntent,
    expected: { key: string; version: string } | null,
  ) => Promise<void>;
  processTimerQueue: (uid: string, id: string) => Promise<void>;
};
const { activateConnection } = requireFunctions(
  "./lib/timeTrackingConnections",
) as {
  activateConnection: (
    uid: string,
    input: { provider: "none"; expectedRevision: string },
  ) => Promise<Connection>;
};
const {
  retryTimerOperation,
  retryAsNewExport,
  acknowledgeLegacyTogglFailure,
  acknowledgeRecoveredReading,
} = requireFunctions("./lib/timeTrackingRecovery") as {
  retryTimerOperation: (uid: string, id: string) => Promise<void>;
  retryAsNewExport: (
    uid: string,
    source: string,
    intent: TimerIntent,
    project?: string,
  ) => Promise<void>;
  acknowledgeLegacyTogglFailure: (uid: string, id: string) => Promise<void>;
  acknowledgeRecoveredReading: (uid: string, id: string) => Promise<void>;
};
const db = getFirestore(),
  secrets = getFirestore("secrets"),
  uid = `threeggle-emulator-${randomUUID()}`;
const user = db.doc(`users/${uid}`),
  claim = user.collection("timerLifecycle").doc("current"),
  book = user.collection("books").doc("book");
const connection: Connection = {
  provider: "threeggle",
  revision: "revision-a",
  serviceId: "test-service",
  accountId: "test-account",
  projectId: "reading",
};
const queue = (id: string) => user.collection("timeTrackingQueue").doc(id);
const intent = (action: "start" | "stop" = "start"): TimerIntent => ({
  version: 2,
  action,
  operationId: randomUUID(),
  timerId: randomUUID(),
  bookId: "book",
  connection,
  start: new Date(Date.now() - 60000).toISOString(),
  end: action === "stop" ? new Date(Date.now() - 1000).toISOString() : null,
  description: "Private reading title",
  remote: null,
});
const entry = (key = "remote-1"): TimeTrackingEntry => ({
  key,
  version: "v1",
  description: "Private reading title",
  projectId: "reading",
  startTime: Date.now() - 60000,
  endTime: null,
});
const json = (value: TimeTrackingResponse, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", "Retry-After": "1" },
  });
const savedEnv = {
  url: process.env.THREEGGLE_API_URL,
  emulator: process.env.FUNCTIONS_EMULATOR,
  local: process.env.THREEGGLE_LOCAL_MODE,
};
before(async () => {
  process.env.THREEGGLE_API_URL =
    "https://integration.invalid/api/time-tracking/v1";
  delete process.env.FUNCTIONS_EMULATOR;
  delete process.env.THREEGGLE_LOCAL_MODE;
  await db
    .doc("configuration/timeTracking")
    .set({ timerWriteVersion: 2, threeggleEnabled: true });
});
beforeEach(async () => {
  await db.recursiveDelete(user);
  await user.set({
    uid,
    email: "timer@example.test",
    timeTracking: connection,
  });
  await claim.set({ version: 1, state: "idle", cleared: null });
  await book.set({ title: "Private reading title", activeTimer: null });
  await secrets
    .doc(`timeTrackingTokens/${uid}/revisions/revision-a`)
    .set({ apiToken: "isolated-test-token" });
});
after(async () => {
  await db.recursiveDelete(user);
  await secrets.recursiveDelete(secrets.doc(`timeTrackingTokens/${uid}`));
  for (const [name, value] of [
    ["THREEGGLE_API_URL", savedEnv.url],
    ["FUNCTIONS_EMULATOR", savedEnv.emulator],
    ["THREEGGLE_LOCAL_MODE", savedEnv.local],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("online start/stop each has its own retained receipt and releases only the matching timer", async (t) => {
  const remote = entry();
  let calls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      assert.equal(options.redirect, "error");
      const request = decodeTimeTrackingRequest(
        JSON.parse(String(options.body)),
      );
      assert.ok(request);
      calls++;
      if (request.action === "entry")
        return json({ apiVersion: 1, ok: true, result: { entry: remote } });
      assert.ok(request.action === "start" || request.action === "stop");
      return json({
        apiVersion: 1,
        ok: true,
        requestId: request.requestId,
        result: {
          disposition: request.action === "start" ? "started" : "stopped",
          ...(request.action === "start" ? { previousEntry: null } : {}),
          entry: {
            ...remote,
            endTime: request.action === "stop" ? request.endTime : null,
          },
        },
      });
    },
  );
  const start = intent();
  await acceptTimerIntent(uid, start, null);
  await processTimerQueue(uid, start.operationId);
  await acceptTimerIntent(uid, start, null);
  await processTimerQueue(uid, start.operationId);
  assert.equal(calls, 2);
  assert.equal(
    (await book.get()).get("activeTimer.remote.entryKey"),
    remote.key,
  );
  const stop: TimerIntent = {
    ...start,
    action: "stop",
    operationId: randomUUID(),
    start: new Date(remote.startTime).toISOString(),
    end: new Date().toISOString(),
    remote: { provider: "threeggle", entryKey: remote.key },
  };
  await acceptTimerIntent(uid, stop, null);
  await processTimerQueue(uid, stop.operationId);
  assert.equal((await book.get()).get("activeTimer"), null);
  assert.equal((await claim.get()).get("state"), "idle");
  assert.equal((await queue(start.operationId).get()).get("status"), "synced");
  assert.equal((await queue(stop.operationId).get()).get("status"), "synced");
  assert.equal((await user.collection("timerOperations").get()).size, 2);
});
test("start context skips project discovery while settings can still request it", async (t) => {
  const { inspectThreeggle } = requireFunctions(
    "./lib/timeTrackingConnections",
  ) as {
    inspectThreeggle: (
      token: string,
      includeProjects?: boolean,
    ) => Promise<{ projects: { id: string; name: string }[] }>;
  };
  const actions: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      const request = decodeTimeTrackingRequest(
        JSON.parse(String(options.body)),
      );
      assert.ok(request);
      actions.push(request.action);
      if (request.action === "projects")
        return json({
          apiVersion: 1,
          ok: true,
          result: { projects: [{ id: "reading", name: "Reading" }] },
        });
      assert.equal(request.action, "context");
      return json({
        apiVersion: 1,
        ok: true,
        result: {
          serviceId: "test-service",
          accountId: "test-account",
          actions: [
            "context",
            "projects",
            "entry",
            "operation",
            "start",
            "stop",
            "create_interval",
          ],
          serverTime: Date.now(),
          current: null,
          readiness: "ready",
          limits: {
            maxIntervalDurationMs: 2678400000,
            maxOverlapReadDocuments: 256,
          },
        },
      });
    },
  );
  assert.deepEqual(
    (await inspectThreeggle("isolated-test-token", false)).projects,
    [],
  );
  assert.deepEqual(actions, ["context"]);
  assert.deepEqual((await inspectThreeggle("isolated-test-token")).projects, [
    { id: "reading", name: "Reading" },
  ]);
  assert.deepEqual(actions, ["context", "context", "projects"]);
});
for (const state of ["running", "completed", "deleted"] as const) {
  test(`recovered Threeggle start reconciles the current ${state} entry`, async (t) => {
    const start = intent();
    const original = entry();
    const current: TimeTrackingEntry = {
      ...original,
      version: "edited",
      description: "Externally edited title",
      projectId: null,
      startTime: original.startTime - 300000,
      endTime: state === "completed" ? original.startTime + 30000 : null,
    };
    const receipt: TimeTrackingResponse = {
      apiVersion: 1,
      ok: true,
      requestId: start.operationId,
      result: { disposition: "started", entry: original, previousEntry: null },
    };
    const requests: string[] = [];
    const actions: string[] = [];
    t.mock.method(
      globalThis,
      "fetch",
      async (_url: unknown, options: RequestInit) => {
        const request = decodeTimeTrackingRequest(
          JSON.parse(String(options.body)),
        );
        assert.ok(request);
        actions.push(request.action);
        if (request.action === "start") {
          requests.push(String(options.body));
          if (requests.length === 1)
            throw new TypeError("Lost committed start response");
          return json(receipt);
        }
        assert.equal(request.action, "entry");
        assert.ok(request.action === "entry");
        assert.equal(request.entryKey, original.key);
        assert.equal((await book.get()).get("activeTimer.state"), "starting");
        return state === "deleted"
          ? json(
              {
                apiVersion: 1,
                ok: false,
                error: { code: "entry_not_found", message: "Deleted" },
              },
              404,
            )
          : json({ apiVersion: 1, ok: true, result: { entry: current } });
      },
    );
    await acceptTimerIntent(uid, start, null);
    await processTimerQueue(uid, start.operationId);
    assert.equal(
      (await queue(start.operationId).get()).get("status"),
      "pending",
    );
    await queue(start.operationId).update({ retryAt: null });
    await processTimerQueue(uid, start.operationId);
    assert.deepEqual(actions, ["start", "start", "entry"]);
    assert.equal(requests[0], requests[1]);
    const row = await queue(start.operationId).get();
    const result = await user
      .collection("timeTrackingResults")
      .doc(start.operationId)
      .get();
    assert.deepEqual(result.get("response"), receipt);
    if (state === "deleted") {
      assert.equal(row.get("status"), "terminal");
      assert.equal(row.get("errorCode"), "entry_not_found");
      assert.equal(result.get("observation.error.code"), "entry_not_found");
      assert.equal(result.get("interval"), undefined);
    } else {
      assert.equal(row.get("status"), "synced");
      assert.deepEqual(result.get("observation.result.entry"), current);
    }
    if (state === "running") {
      assert.equal((await book.get()).get("activeTimer.state"), "remote");
      assert.equal(
        (await book.get()).get("activeTimer.start"),
        new Date(current.startTime).toISOString(),
      );
      assert.equal(
        (await claim.get()).get("timer.remote.entryKey"),
        original.key,
      );
    } else {
      assert.equal((await book.get()).get("activeTimer"), null);
      assert.equal((await claim.get()).get("state"), "idle");
      if (state === "completed") {
        assert.equal(result.get("readingPending"), true);
        assert.equal(result.get("bookId"), start.bookId);
        assert.deepEqual(result.get("interval"), {
          start: new Date(current.startTime).toISOString(),
          end: new Date(current.endTime!).toISOString(),
        });
        await assert.rejects(
          acknowledgeRecoveredReading(uid, randomUUID()),
          /No completed reading/,
        );
        await acknowledgeRecoveredReading(uid, start.operationId);
        const acknowledged = await result.ref.get();
        assert.equal(acknowledged.get("readingPending"), false);
        assert.deepEqual(acknowledged.get("response"), receipt);
        await acknowledgeRecoveredReading(uid, start.operationId);
        assert.equal(
          (await result.ref.get()).get("readingAcknowledgedAt"),
          acknowledged.get("readingAcknowledgedAt"),
        );
      }
      // Re-delivery cannot recreate the old entry or acquire a new timer claim.
      await processTimerQueue(uid, start.operationId);
      assert.deepEqual(actions, ["start", "start", "entry"]);
      await acceptTimerIntent(uid, intent(), null);
    }
  });
}

for (const failure of ["unauthorized", "unavailable", "wrong_entry"] as const) {
  test(`a ${failure} start lookup cannot promote a stale receipt, including after retry reset`, async (t) => {
    const start = intent();
    const original = entry();
    const current = { ...original, endTime: original.startTime + 30000 };
    let lookups = 0;
    const requests: string[] = [];
    t.mock.method(
      globalThis,
      "fetch",
      async (_url: unknown, options: RequestInit) => {
        const request = decodeTimeTrackingRequest(
          JSON.parse(String(options.body)),
        );
        assert.ok(request);
        if (request.action === "start") {
          requests.push(String(options.body));
          return json({
            apiVersion: 1,
            ok: true,
            requestId: request.requestId,
            result: {
              disposition: "started",
              entry: original,
              previousEntry: null,
            },
          });
        }
        assert.equal(request.action, "entry");
        lookups++;
        if (lookups === 1) {
          if (failure === "wrong_entry")
            return json({
              apiVersion: 1,
              ok: true,
              result: { entry: entry("unrelated") },
            });
          return json(
            {
              apiVersion: 1,
              ok: false,
              error: {
                code:
                  failure === "unauthorized" ? "unauthorized" : "rate_limited",
                message: "Lookup unavailable",
              },
            },
            failure === "unauthorized" ? 401 : 429,
          );
        }
        return json({ apiVersion: 1, ok: true, result: { entry: current } });
      },
    );
    await acceptTimerIntent(uid, start, null);
    await processTimerQueue(uid, start.operationId);
    assert.equal((await book.get()).get("activeTimer.state"), "starting");
    assert.equal(
      (await queue(start.operationId).get()).get("status"),
      failure === "unauthorized" ? "paused" : "pending",
    );
    await queue(start.operationId).update({ retryAt: null });
    await retryTimerOperation(uid, start.operationId);
    if (failure === "unauthorized")
      assert.equal((await queue(start.operationId).get()).get("attempts"), 0);
    await processTimerQueue(uid, start.operationId);
    assert.equal(lookups, 2);
    assert.equal(requests[0], requests[1]);
    assert.equal(
      (await queue(start.operationId).get()).get("status"),
      "synced",
    );
    assert.equal((await book.get()).get("activeTimer"), null);
    assert.equal((await claim.get()).get("state"), "idle");
  });
}

test("a lost response replays the identical frozen request without a new timer or interval", async (t) => {
  const original = intent("stop");
  await queue(original.operationId).set(initialQueue(original, Date.now()));
  const sent: string[] = [];
  let first = true;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      sent.push(String(options.body));
      const request = decodeTimeTrackingRequest(
        JSON.parse(String(options.body)),
      );
      assert.ok(request && request.action === "create_interval");
      if (first) {
        first = false;
        throw new TypeError("Lost response after remote commit");
      }
      return json({
        apiVersion: 1,
        ok: true,
        requestId: request.requestId,
        result: {
          disposition: "created",
          entry: {
            ...entry(),
            startTime: request.startTime,
            endTime: request.endTime,
          },
        },
      });
    },
  );
  await processTimerQueue(uid, original.operationId);
  assert.equal(
    (await queue(original.operationId).get()).get("status"),
    "pending",
  );
  await queue(original.operationId).update({ retryAt: null });
  await processTimerQueue(uid, original.operationId);
  assert.equal(sent.length, 2);
  assert.equal(sent[0], sent[1]);
  assert.equal(
    (await queue(original.operationId).get()).get("status"),
    "synced",
  );
});
test("missing credentials pause visibly and cannot redirect saved work to another connection", async () => {
  const original = intent("stop");
  await queue(original.operationId).set(initialQueue(original, Date.now()));
  await secrets.doc(`timeTrackingTokens/${uid}/revisions/revision-a`).delete();
  await processTimerQueue(uid, original.operationId);
  const paused = decodeQueueV2(
    (await queue(original.operationId).get()).data(),
  );
  assert.equal(paused.status, "paused");
  assert.equal(paused.errorCode, "credential_missing");
  await assert.rejects(
    activateConnection(uid, {
      provider: "none",
      expectedRevision: "revision-a",
    }),
    /resolve queued activity/,
  );
  await user.update({ timeTracking: { provider: "none", revision: "new" } });
  await assert.rejects(
    retryTimerOperation(uid, original.operationId),
    /connection changed/,
  );
});
test("connection changes and simultaneous starts serialize against the same claim", async () => {
  const starts = [intent(), intent()];
  const results = await Promise.allSettled(
    starts.map((value) => acceptTimerIntent(uid, value, null)),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  await assert.rejects(
    activateConnection(uid, {
      provider: "none",
      expectedRevision: "revision-a",
    }),
    /Stop your timer/,
  );
  assert.equal((await user.get()).get("timeTracking.provider"), "threeggle");
});
test("a rejected export gets exactly one reviewed successor while preserving its connection", async (t) => {
  const original = intent("stop"),
    row = {
      ...initialQueue(original, Date.now()),
      status: "terminal",
      errorCode: "project_unavailable",
    };
  await queue(original.operationId).set(row);
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      const request = decodeTimeTrackingRequest(
        JSON.parse(String(options.body)),
      );
      assert.ok(request);
      if (request.action === "context")
        return json({
          apiVersion: 1,
          ok: true,
          result: {
            serviceId: connection.serviceId,
            accountId: connection.accountId,
            actions: [
              "context",
              "projects",
              "start",
              "stop",
              "create_interval",
              "entry",
              "operation",
            ],
            serverTime: Date.now(),
            current: null,
            readiness: "ready",
            limits: {
              maxIntervalDurationMs: 2678400000,
              maxOverlapReadDocuments: 256,
            },
          },
        });
      return json({
        apiVersion: 1,
        ok: true,
        result: { projects: [{ id: "new-reading", name: "New Reading" }] },
      });
    },
  );
  const replacement = { ...original, operationId: randomUUID() };
  await retryAsNewExport(uid, original.operationId, replacement, "new-reading");
  await retryAsNewExport(uid, original.operationId, replacement, "new-reading");
  await assert.rejects(
    retryAsNewExport(
      uid,
      original.operationId,
      { ...replacement, operationId: randomUUID() },
      "new-reading",
    ),
    /already has a replacement/,
  );
  const successor = decodeQueueV2(
    (await queue(replacement.operationId).get()).data(),
  );
  assert.deepEqual(successor.intent.connection, connection);
  assert.equal(successor.prepared?.provider, "threeggle");
  assert.equal(
    (await queue(replacement.operationId).get()).get(
      "prepared.request.projectId",
    ),
    "new-reading",
  );
});
test("disable controls preserve stops and replay while blocking new Threeggle starts", async () => {
  const start = intent();
  await acceptTimerIntent(uid, start, null);
  await db
    .doc("configuration/timeTracking")
    .update({ threeggleEnabled: false });
  await assert.rejects(
    acceptTimerIntent(uid, intent(), null),
    /temporarily unavailable/,
  );
  await acceptTimerIntent(uid, start, null);
  await db.doc("configuration/timeTracking").update({ threeggleEnabled: true });
});
test("legacy acknowledgements are terminal, immutable and reject retryable creates", async () => {
  const { Timestamp } = requireFunctions(
    "firebase-admin/firestore",
  ) as typeof import("firebase-admin/firestore");
  const base = {
    type: "create",
    bookTitle: "Private reading title",
    start: "2026-09-13T12:00:00.000Z",
    stop: "2026-09-13T12:30:00.000Z",
    createdAt: Timestamp.now(),
    claimedAt: Timestamp.now(),
    attempts: 5,
    status: "error",
    error: "failed",
  };
  const legacy = user.collection("togglQueue").doc("legacy");
  await legacy.set(base);
  await acknowledgeLegacyTogglFailure(uid, "legacy");
  const time = (await legacy.get()).get("legacyResolution.acknowledgedAt");
  await acknowledgeLegacyTogglFailure(uid, "legacy");
  assert.deepEqual(
    (await legacy.get()).get("legacyResolution.acknowledgedAt"),
    time,
  );
  assert.equal((await legacy.get()).get("status"), "acknowledged");
  assert.equal(
    (
      await user
        .collection("togglQueue")
        .where("status", "in", [
          "pending",
          "processing",
          "error",
          "outcome-unknown",
        ])
        .get()
    ).size,
    0,
  );
  await legacy.set({ ...base, attempts: 1 });
  await assert.rejects(
    acknowledgeLegacyTogglFailure(uid, "legacy"),
    /terminal create/,
  );
});

test("an in-flight uncertain create cannot be acknowledged, but a settled one can", async () => {
  const { acknowledgeTimerFailure } = requireFunctions(
    "./lib/timeTrackingRecovery",
  ) as { acknowledgeTimerFailure: (uid: string, id: string) => Promise<void> };
  const original = intent("stop");
  await queue(original.operationId).set({
    ...initialQueue(original, Date.now()),
    status: "outcome-unknown",
    attempts: 1,
    claimedAt: Date.now(),
    errorCode: "delivery_unconfirmed",
  });
  await assert.rejects(
    acknowledgeTimerFailure(uid, original.operationId),
    /still be running/,
  );
  await queue(original.operationId).update({ claimedAt: Date.now() - 180001 });
  await acknowledgeTimerFailure(uid, original.operationId);
  assert.equal(
    (await queue(original.operationId).get()).get("resolution"),
    "remote_outcome_checked",
  );
});

test("fast device intervals retain duration, and invalid ordering is never silently repaired", async (t) => {
  const now = Date.now(),
    original = {
      ...intent("stop"),
      start: new Date(now + 60000).toISOString(),
      end: new Date(now + 120000).toISOString(),
    };
  await queue(original.operationId).set(initialQueue(original, now));
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      const request = decodeTimeTrackingRequest(
        JSON.parse(String(options.body)),
      );
      assert.ok(request && request.action === "create_interval");
      assert.equal(request.endTime - request.startTime, 60000);
      assert.ok(request.endTime <= Date.now());
      return json({
        apiVersion: 1,
        ok: true,
        requestId: request.requestId,
        result: {
          disposition: "created",
          entry: {
            ...entry(),
            startTime: request.startTime,
            endTime: request.endTime,
          },
        },
      });
    },
  );
  await processTimerQueue(uid, original.operationId);
  assert.equal(
    (await queue(original.operationId).get()).get("intent.end"),
    original.end,
  );
  const invalid = {
    ...original,
    operationId: randomUUID(),
    end: original.start,
  };
  await queue(invalid.operationId).set(initialQueue(invalid, now));
  await processTimerQueue(uid, invalid.operationId);
  assert.equal(
    (await queue(invalid.operationId).get()).get("errorCode"),
    "invalid_time",
  );
});

test("a retained acceptance remains replayable after an intentional connection revision change", async () => {
  const local: TimerIntent = {
    ...intent(),
    connection: { provider: "none", revision: "none-a" },
  };
  await user.update({ timeTracking: local.connection });
  await acceptTimerIntent(uid, local, null);
  const stop: TimerIntent = {
    ...local,
    action: "stop",
    operationId: randomUUID(),
    end: new Date().toISOString(),
  };
  await acceptTimerIntent(uid, stop, null);
  await activateConnection(uid, {
    provider: "none",
    expectedRevision: "none-a",
  });
  await acceptTimerIntent(uid, local, null);
  await acceptTimerIntent(uid, stop, null);
  assert.equal((await book.get()).get("activeTimer"), null);
  assert.equal((await user.collection("timerOperations").get()).size, 2);
});

test("a full row budget defers new work without falsely counting it or making a request", async (t) => {
  const { Timestamp } = requireFunctions(
    "firebase-admin/firestore",
  ) as typeof import("firebase-admin/firestore");
  const original = intent("stop");
  await queue(original.operationId).set(initialQueue(original, Date.now()));
  await user
    .collection("functionQuotas")
    .doc("timeTrackingQueueRows")
    .set({ count: 60, windowStartedAt: Timestamp.now() });
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error(
      "No provider request is allowed while the row budget is full.",
    );
  });
  await processTimerQueue(uid, original.operationId);
  const row = decodeQueueV2((await queue(original.operationId).get()).data());
  assert.equal(row.status, "pending");
  assert.equal(row.rowCounted, false);
  assert.equal(row.attempts, 0);
  assert.equal(row.errorCode, "row_limit");
});

test("background delivery remains retryable after a deferred operation, even without an open client", async () => {
  const deployed = requireFunctions("./lib") as {
    timetracking: { syncqueue: { run: (event: unknown) => Promise<void> } };
  };
  const original = intent("stop"),
    ref = queue(original.operationId);
  await ref.set({
    ...initialQueue(original, Date.now()),
    retryAt: Date.now() + 60000,
  });
  const event = {
    params: { uid, operationId: original.operationId },
    data: { after: await ref.get() },
  };
  await assert.rejects(
    deployed.timetracking.syncqueue.run(event),
    /awaiting its retry window/,
  );
  await ref.update({ status: "terminal", errorCode: "invalid_time" });
  await deployed.timetracking.syncqueue.run(event);
});

async function seedRemoteStop(provider: "toggl" | "threeggle", online = true) {
  const selected: Connection =
    provider === "toggl"
      ? {
          provider,
          revision: "revision-a",
          accountId: "1",
          workspaceId: 123,
          projectId: 456,
        }
      : connection;
  await user.update({ timeTracking: selected });
  const original = {
    ...intent("stop"),
    connection: selected,
    start: new Date(Date.now() - 3600000).toISOString(),
    remote:
      provider === "toggl"
        ? ({ provider, entryId: 678 } as const)
        : ({ provider, entryKey: "repair-target" } as const),
  };
  const timer: TimerV2 = {
    version: 2,
    timerId: original.timerId,
    operationId: randomUUID(),
    connection: selected,
    state: "remote",
    start: original.start,
    claimedAt: Date.now() - 3600000,
    remote: original.remote,
    queueId: null,
    errorCode: null,
  };
  await book.update({ activeTimer: timer });
  await claim.set(claimV2("book", timer));
  if (online) await acceptTimerIntent(uid, original, null);
  else {
    const stopping: TimerV2 = {
      ...timer,
      state: "stopping",
      operationId: original.operationId,
      queueId: original.operationId,
    };
    await book.update({ activeTimer: stopping });
    await claim.set(claimV2("book", stopping));
    await queue(original.operationId).set(initialQueue(original, Date.now()));
  }
  return original;
}
for (const online of [true, false])
  test(`${online ? "online" : "offline"} Toggl stop preserves an external completion and its edited interval`, async (t) => {
    const original = await seedRemoteStop("toggl", online);
    const edited = {
      id: 678,
      start: new Date(Date.parse(original.start) + 300000).toISOString(),
      duration: 600,
      description: "External title",
      project_id: 999,
    };
    const methods: string[] = [];
    t.mock.method(
      globalThis,
      "fetch",
      async (url: unknown, options: RequestInit) => {
        const method = String(options.method);
        methods.push(method);
        assert.equal(options.body, undefined);
        if (method === "PATCH") {
          assert.match(String(url), /\/678\/stop$/);
          return new Response("already stopped", { status: 409 });
        }
        assert.equal(method, "GET");
        assert.match(String(url), /\/me\/time_entries\/678$/);
        return new Response(JSON.stringify(edited));
      },
    );
    await processTimerQueue(uid, original.operationId);
    assert.deepEqual(methods, online ? ["PATCH", "GET"] : ["GET"]);
    assert.equal(
      (await queue(original.operationId).get()).get("status"),
      "synced",
    );
    assert.deepEqual(
      (
        await user
          .collection("timeTrackingResults")
          .doc(original.operationId)
          .get()
      ).get("interval"),
      {
        start: edited.start,
        end: new Date(Date.parse(edited.start) + 600000).toISOString(),
      },
    );
    assert.equal((await book.get()).get("activeTimer"), null);
  });
test("online Toggl stop uses the provider's edited start and duration without writing metadata", async (t) => {
  const original = await seedRemoteStop("toggl");
  const edited = {
    id: 678,
    start: new Date(Date.now() - 120000).toISOString(),
    duration: 120,
    description: "Edited",
    project_id: 999,
  };
  t.mock.method(
    globalThis,
    "fetch",
    async (url: unknown, options: RequestInit) => {
      assert.equal(options.method, "PATCH");
      assert.match(String(url), /\/678\/stop$/);
      assert.equal(options.body, undefined);
      return new Response(JSON.stringify(edited));
    },
  );
  await processTimerQueue(uid, original.operationId);
  const interval = (
    await user.collection("timeTrackingResults").doc(original.operationId).get()
  ).get("interval");
  assert.equal(interval.start, edited.start);
  assert.equal(Date.parse(interval.end) - Date.parse(interval.start), 120000);
});
test("offline Toggl stop sends only its recorded end and reconciles a lost update response", async (t) => {
  const original = await seedRemoteStop("toggl", false);
  const editedStart = new Date(
    Date.parse(original.start) + 300000,
  ).toISOString();
  let duration = -1,
    updates = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      if (options.method === "GET")
        return new Response(
          JSON.stringify({
            id: 678,
            start: editedStart,
            duration,
            description: "Edited",
            project_id: 999,
          }),
        );
      assert.equal(options.method, "PUT");
      assert.deepEqual(JSON.parse(String(options.body)), {
        stop: original.end,
      });
      updates++;
      duration = Math.floor(
        (Date.parse(original.end ?? "") - Date.parse(editedStart)) / 1000,
      );
      throw new Error("lost response after committed update");
    },
  );
  await processTimerQueue(uid, original.operationId);
  assert.equal(
    (await queue(original.operationId).get()).get("status"),
    "pending",
  );
  await queue(original.operationId).update({ retryAt: 0 });
  await processTimerQueue(uid, original.operationId);
  assert.equal(updates, 1);
  assert.equal(
    (await queue(original.operationId).get()).get("status"),
    "synced",
  );
  assert.equal(
    (
      await user
        .collection("timeTrackingResults")
        .doc(original.operationId)
        .get()
    ).get("interval.start"),
    editedStart,
  );
});
for (const alreadyStopped of [false, true])
  test(`targeted Threeggle stop recovery works without the configured project (${alreadyStopped ? "completed" : "running"} target)`, async (t) => {
    const original = await seedRemoteStop("threeggle");
    await queue(original.operationId).update({
      status: "terminal",
      errorCode: "project_unavailable",
    });
    const remote = {
      ...entry("repair-target"),
      projectId: alreadyStopped ? null : "new-project",
      startTime: Date.parse(original.start) + 300000,
      endTime: alreadyStopped ? Date.parse(original.start) + 900000 : null,
    };
    t.mock.method(
      globalThis,
      "fetch",
      async (_url: unknown, options: RequestInit) => {
        const request = decodeTimeTrackingRequest(
          JSON.parse(String(options.body)),
        );
        assert.ok(request);
        if (request.action === "context")
          return json({
            apiVersion: 1,
            ok: true,
            result: {
              serviceId: connection.serviceId,
              accountId: connection.accountId,
              actions: [
                "context",
                "projects",
                "start",
                "stop",
                "create_interval",
                "entry",
                "operation",
              ],
              serverTime: Date.now(),
              current: null,
              readiness: "ready",
              limits: {
                maxIntervalDurationMs: 2678400000,
                maxOverlapReadDocuments: 256,
              },
            },
          });
        if (request.action === "projects")
          return json({ apiVersion: 1, ok: true, result: { projects: [] } });
        if (request.action === "entry")
          return json({ apiVersion: 1, ok: true, result: { entry: remote } });
        assert.equal(request.action, "stop");
        return json({
          apiVersion: 1,
          ok: true,
          requestId: request.requestId,
          result: {
            disposition: alreadyStopped ? "already_stopped" : "stopped",
            entry: { ...remote, endTime: remote.endTime ?? request.endTime },
          },
        });
      },
    );
    const successor = { ...original, operationId: randomUUID() };
    await retryAsNewExport(uid, original.operationId, successor);
    assert.equal(
      (await claim.get()).get("timer.queueId"),
      successor.operationId,
    );
    await processTimerQueue(uid, successor.operationId);
    assert.equal(
      (await queue(original.operationId).get()).get("errorCode"),
      "project_unavailable",
    );
    assert.equal(
      (await queue(original.operationId).get()).get("successorId"),
      successor.operationId,
    );
    assert.equal(
      (await queue(successor.operationId).get()).get("status"),
      "synced",
    );
    assert.equal((await claim.get()).get("state"), "idle");
    const interval = (
      await user
        .collection("timeTrackingResults")
        .doc(successor.operationId)
        .get()
    ).get("interval");
    assert.equal(interval.start, new Date(remote.startTime).toISOString());
    if (alreadyStopped)
      assert.equal(
        Date.parse(interval.end) - Date.parse(interval.start),
        600000,
      );
  });
