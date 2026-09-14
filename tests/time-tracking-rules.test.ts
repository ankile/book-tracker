import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from "@firebase/rules-unit-testing";
import type { RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { doc, setDoc, updateDoc, getDoc, writeBatch } from "firebase/firestore";
import {
  claimV2,
  idleV2,
  initialQueue,
  operationAck,
} from "../shared/timeTracking.ts";
import type {
  Connection,
  TimerIntent,
  TimerV2,
} from "../shared/timeTracking.ts";
let env: RulesTestEnvironment;
const uid = "timer-owner";
const connection: Connection = {
  provider: "threeggle",
  revision: "revision-a",
  serviceId: "isolated",
  accountId: "owner",
  projectId: "reading",
};
const start = "2026-09-13T12:00:00.000Z";
const makeIntent = (config: Connection = connection): TimerIntent => ({
  version: 2,
  action: "start",
  operationId: randomUUID(),
  timerId: randomUUID(),
  bookId: "book",
  connection: config,
  start,
  end: null,
  description: "Reading book",
  remote: null,
});
const localTimer = (intent: TimerIntent): TimerV2 => ({
  version: 2,
  timerId: intent.timerId,
  operationId: intent.operationId,
  connection: intent.connection,
  state: "local",
  start: intent.start,
  claimedAt: Date.parse(intent.start),
  remote: null,
  queueId: null,
  errorCode: null,
});
const client = () =>
  env.authenticatedContext(uid, { email_verified: true }).firestore();
async function seed(
  config: Connection = connection,
  active: TimerV2 | null = null,
) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "users", uid), {
      uid,
      email: "timer@example.test",
      timeTracking: config,
    });
    await setDoc(doc(db, "users", uid, "books", "book"), {
      title: "Reading book",
      activeTimer: active,
      currentPage: 20,
      currentPageUpdateId: "session",
      pageCount: 100,
      finished: false,
      pagesRead: 20,
      timeRead: 60,
    });
    await setDoc(
      doc(db, "users", uid, "timerLifecycle", "current"),
      active
        ? claimV2("book", active)
        : { version: 1, state: "idle", cleared: null },
    );
    await setDoc(doc(db, "configuration", "timeTracking"), {
      timerWriteVersion: 2,
      threeggleEnabled: true,
    });
  });
}
function startBatch(intent: TimerIntent, omitAck = false) {
  const db = client(),
    batch = writeBatch(db),
    timer = localTimer(intent);
  batch.update(doc(db, "users", uid, "books", "book"), { activeTimer: timer });
  batch.set(
    doc(db, "users", uid, "timerLifecycle", "current"),
    claimV2("book", timer),
  );
  if (!omitAck)
    batch.set(doc(db, "users", uid, "timerOperations", intent.operationId), {
      ...operationAck(intent, Date.now()),
      intent,
    });
  return batch.commit();
}
function stopBatch(
  timer: TimerV2,
  options: {
    omitQueue?: boolean;
    omitAck?: boolean;
    forgeIntent?: boolean;
    clear?: boolean;
  } = {},
) {
  const intent: TimerIntent = {
    version: 2,
    action: options.clear ? "clear" : "stop",
    operationId: randomUUID(),
    timerId: timer.timerId,
    bookId: "book",
    connection: timer.connection,
    start: timer.start,
    end: options.clear ? null : "2026-09-13T12:30:00.000Z",
    description: "Reading book",
    remote: timer.remote,
  };
  const db = client(),
    batch = writeBatch(db);
  if (timer.remote !== null) {
    const stopping: TimerV2 = {
      ...timer,
      state: "stopping",
      queueId: intent.operationId,
      operationId: intent.operationId,
    };
    batch.update(doc(db, "users", uid, "books", "book"), {
      activeTimer: stopping,
    });
    batch.set(
      doc(db, "users", uid, "timerLifecycle", "current"),
      claimV2("book", stopping),
    );
  } else {
    batch.update(doc(db, "users", uid, "books", "book"), { activeTimer: null });
    batch.set(
      doc(db, "users", uid, "timerLifecycle", "current"),
      idleV2("book", { ...timer, operationId: intent.operationId }),
    );
  }
  if (!options.omitAck)
    batch.set(doc(db, "users", uid, "timerOperations", intent.operationId), {
      ...operationAck(intent, Date.now()),
      intent,
    });
  if (
    !options.omitQueue &&
    timer.connection.provider !== "none" &&
    !options.clear
  )
    batch.set(
      doc(db, "users", uid, "timeTrackingQueue", intent.operationId),
      initialQueue(
        options.forgeIntent
          ? { ...intent, description: "forged activity" }
          : intent,
        Date.now(),
      ),
    );
  return { intent, commit: () => batch.commit() };
}
before(async () => {
  env = await initializeTestEnvironment({
    projectId: "book-tracker-timer-v2-test",
    firestore: { rules: await readFile("firestore.rules", "utf8") },
  });
});
after(async () => {
  await env.cleanup();
});
beforeEach(async () => {
  await env.clearFirestore();
});

test("v2 local start and completed export fit the Rules budgets with immutable acceptance", async () => {
  await seed();
  const intent = makeIntent();
  await assertSucceeds(startBatch(intent));
  const stop = stopBatch(localTimer(intent));
  await assertSucceeds(stop.commit());
  const db = client(),
    ack = doc(db, "users", uid, "timerOperations", stop.intent.operationId),
    queue = doc(db, "users", uid, "timeTrackingQueue", stop.intent.operationId);
  assert.equal((await getDoc(ack)).get("action"), "stop");
  await assertFails(updateDoc(ack, { acceptedAt: 0 }));
  await assertFails(updateDoc(queue, { status: "synced" }));
});
test("remote Threeggle and numeric Toggl stops retain a matching lock and fit the write budget", async () => {
  for (const config of [
    connection,
    {
      provider: "toggl",
      revision: "toggl-revision",
      accountId: "123",
      workspaceId: 1,
      projectId: 2,
    } satisfies Connection,
  ]) {
    const timer: TimerV2 = {
      ...localTimer(makeIntent(config)),
      state: "remote",
      remote:
        config.provider === "threeggle"
          ? { provider: "threeggle", entryKey: "timer:key" }
          : { provider: "toggl", entryId: 23 },
    };
    await seed(config, timer);
    await assertSucceeds(stopBatch(timer).commit());
    assert.equal(
      (
        await getDoc(doc(client(), "users", uid, "timerLifecycle", "current"))
      ).get("timer.state"),
      "stopping",
    );
  }
});
test("each None start, stop and explicit clear has an immutable acknowledgement", async () => {
  const config: Connection = { provider: "none", revision: "none-revision" };
  await seed(config);
  const intent = makeIntent(config);
  await assertSucceeds(startBatch(intent));
  await assertSucceeds(stopBatch(localTimer(intent)).commit());
  const next = makeIntent(config);
  await assertSucceeds(startBatch(next));
  await assertSucceeds(stopBatch(localTimer(next), { clear: true }).commit());
});
test("Rules reject missing acknowledgements, missing queue, and a fabricated export body", async () => {
  await seed();
  const intent = makeIntent();
  await assertFails(startBatch(intent, true));
  await assertSucceeds(startBatch(intent));
  await assertFails(stopBatch(localTimer(intent), { omitAck: true }).commit());
  await assertFails(
    stopBatch(localTimer(intent), { omitQueue: true }).commit(),
  );
  await assertFails(
    stopBatch(localTimer(intent), { forgeIntent: true }).commit(),
  );
});
test("disabling rollout rejects local starts but still lets an existing Threeggle timer stop", async () => {
  const intent = makeIntent();
  await seed(connection, localTimer(intent));
  await env.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(doc(ctx.firestore(), "configuration", "timeTracking"), {
      threeggleEnabled: false,
    });
  });
  await assertSucceeds(stopBatch(localTimer(intent)).commit());
  await assertFails(startBatch(makeIntent()));
});
test("stale connection revisions and foreign identities cannot authorize local writes", async () => {
  await seed();
  await assertFails(
    startBatch(makeIntent({ ...connection, revision: "old-revision" })),
  );
  await assertFails(
    startBatch(makeIntent({ ...connection, accountId: "different-account" })),
  );
  const none: Connection = { provider: "none", revision: "old-none" };
  const timer = localTimer(makeIntent(none));
  await seed(connection, timer);
  await assertFails(stopBatch(timer).commit());
});
test("an old client cannot start locally after an explicit destination choice", async () => {
  await seed();
  const db = client(),
    batch = writeBatch(db);
  const timer = { start, operationId: "old-client" };
  batch.update(doc(db, "users", uid, "books", "book"), { activeTimer: timer });
  batch.set(doc(db, "users", uid, "timerLifecycle", "current"), {
    version: 1,
    state: "local",
    bookId: "book",
    ...timer,
  });
  await assertFails(batch.commit());
});
test("an acknowledgement alone and a duplicate operation ID cannot create activity", async () => {
  await seed();
  const intent = makeIntent();
  await assertFails(
    setDoc(doc(client(), "users", uid, "timerOperations", intent.operationId), {
      ...operationAck(intent, Date.now()),
      intent,
    }),
  );
  await assertSucceeds(startBatch(intent));
  await assertFails(startBatch(intent));
});
