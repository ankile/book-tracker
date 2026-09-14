import './setup.ts';
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import type { Connection, TimerIntent } from "../shared/timeTracking.ts";
import { decodeQueueV2, initialQueue } from "../shared/timeTracking.ts";
import { decodeTimeTrackingResponse } from "../shared/time-tracking-api.ts";

// Explicit opt-in only: this suite writes disposable activity in the dedicated
// local Threeggle instance. It is never included in the ordinary test command.
const endpoint = process.env.THREEGGLE_API_URL;
const token = process.env.THREEGGLE_TEST_TOKEN;
assert.equal(process.env.THREEGGLE_LOCAL_MODE, "isolated");
assert.ok(
  endpoint &&
    /^http:\/\/127\.0\.0\.1:\d+\/api\/time-tracking\/v1$/.test(endpoint),
);
assert.ok(token);
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:8080");
process.env.FUNCTIONS_EMULATOR = "true";
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
    expected: null,
  ) => Promise<void>;
  processTimerQueue: (uid: string, id: string) => Promise<void>;
};
const { activateConnection } = requireFunctions(
  "./lib/timeTrackingConnections",
) as {
  activateConnection: (
    uid: string,
    input: {
      provider: "threeggle";
      expectedRevision: string;
      token: string;
      projectId: string;
    },
  ) => Promise<Connection>;
};
async function request(body: unknown) {
  const response = await fetch(endpoint!, {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: decodeTimeTrackingResponse(await response.json()),
  };
}
test("real Firestore and isolated Convex preserve start/stop receipts and completed-interval replay", async () => {
  const context = await request({ client: "book-tracker", action: "context" });
  assert.ok(context.body?.ok && "serviceId" in context.body.result);
  assert.equal(context.body.result.serviceId, "book-tracker-integration-local");
  assert.equal(context.body.result.current, null);
  const projects = await request({
    client: "book-tracker",
    action: "projects",
  });
  assert.ok(projects.body?.ok && "projects" in projects.body.result);
  const project = projects.body.result.projects.find(
    (p) => p.name === "Reading",
  );
  assert.ok(project);
  const uid = `live-two-backend-${randomUUID()}`,
    db = getFirestore(),
    user = db.doc(`users/${uid}`),
    book = user.collection("books").doc("book");
  await user.set({ uid, email: "isolated-two-backend@example.test" });
  await book.set({ title: "Isolated API test", activeTimer: null });
  await user
    .collection("timerLifecycle")
    .doc("current")
    .set({ version: 1, state: "idle", cleared: null });
  await db
    .doc("configuration/timeTracking")
    .set({ timerWriteVersion: 2, threeggleEnabled: true });
  const connection = await activateConnection(uid, {
    provider: "threeggle",
    expectedRevision: "legacy",
    token: token!,
    projectId: project.id,
  });
  try {
    const start: TimerIntent = {
      version: 2,
      action: "start",
      operationId: randomUUID(),
      timerId: randomUUID(),
      bookId: "book",
      connection,
      start: new Date().toISOString(),
      end: null,
      description: "Isolated two-backend reading",
      remote: null,
    };
    await acceptTimerIntent(uid, start, null);
    await processTimerQueue(uid, start.operationId);
    const active = (await book.get()).get("activeTimer");
    assert.equal(active.state, "remote");
    const stop: TimerIntent = {
      ...start,
      action: "stop",
      operationId: randomUUID(),
      start: active.start,
      end: new Date().toISOString(),
      remote: active.remote,
    };
    await acceptTimerIntent(uid, stop, null);
    await processTimerQueue(uid, stop.operationId);
    assert.equal((await book.get()).get("activeTimer"), null);
    for (const id of [start.operationId, stop.operationId]) {
      const receipt = await request({
        client: "book-tracker",
        action: "operation",
        requestId: id,
      });
      assert.equal(receipt.status, 200);
      assert.ok(receipt.body?.ok && "status" in receipt.body.result);
      assert.equal(receipt.body.result.status, 200);
    }
    const interval: TimerIntent = {
      ...stop,
      operationId: randomUUID(),
      remote: null,
      start: new Date(Date.now() - 60000).toISOString(),
      end: new Date(Date.now() - 30000).toISOString(),
    };
    const row = user.collection("timeTrackingQueue").doc(interval.operationId);
    await row.set(initialQueue(interval, Date.now()));
    await processTimerQueue(uid, interval.operationId);
    const done = decodeQueueV2((await row.get()).data());
    assert.equal(done.status, "synced");
    assert.ok(done.prepared?.provider === "threeggle");
    const first = await request(done.prepared.request),
      replay = await request(done.prepared.request);
    assert.deepEqual(replay, first);
    assert.ok(first.body?.ok && "disposition" in first.body.result);
    assert.equal(first.body.result.disposition, "created");
    const conflict = await request({
      ...done.prepared.request,
      requestId: randomUUID(),
    });
    assert.equal(conflict.status, 409);
    assert.ok(conflict.body && !conflict.body.ok);
    assert.equal(conflict.body.error.code, "interval_overlap");
  } finally {
    await db.recursiveDelete(user);
    await getFirestore("secrets").recursiveDelete(
      getFirestore("secrets").doc(`timeTrackingTokens/${uid}`),
    );
  }
});
