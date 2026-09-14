import {
  doc,
  getDocFromServer,
  onSnapshot,
  waitForPendingWrites,
  writeBatch,
} from "firebase/firestore";
import type { Unsubscribe } from "firebase/firestore";
import { FirebaseError } from "firebase/app";
import { db } from "./db.ts";
import { auth } from "./auth.ts";
import { timerAccept, timerClear, timerReplace } from "./functions.ts";
import {
  listOutbox,
  putOutbox,
  removeOutbox,
  withTimerLock,
} from "./timerOutbox.ts";
import type { OutboxRecord } from "./timerOutbox.ts";
import {
  claimV2,
  decodeTimerControls,
  decodeTimerIntent,
  idleV2,
  initialQueue,
  operationAck,
} from "../../../shared/timeTracking.ts";
import type {
  Connection,
  TimerControls,
  TimerIntent,
  TimerV2,
} from "../../../shared/timeTracking.ts";
import {
  decodeTimeTrackingResponse,
  wireRecord,
} from "../../../shared/time-tracking-api.ts";
import type { TimeTrackingContext } from "../../../shared/time-tracking-api.ts";
import { addError } from "../stores/errors.ts";

export function isTimerV2(timer: unknown): timer is TimerV2 {
  return wireRecord(timer) && timer.version === 2;
}
export function watchTimerControls(
  next: (controls: TimerControls) => void,
  failed: (error: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(db, "configuration", "timeTracking"),
    (snap) => next(decodeTimerControls(snap.data())),
    failed,
  );
}
export function inspectResult(value: unknown): {
  context: TimeTrackingContext;
  projects: { id: string; name: string }[];
} {
  if (!wireRecord(value)) throw new TypeError("Invalid connection response.");
  const context = decodeTimeTrackingResponse({
    apiVersion: 1,
    ok: true,
    result: value.context,
  });
  const projects = decodeTimeTrackingResponse({
    apiVersion: 1,
    ok: true,
    result: { projects: value.projects },
  });
  if (
    !context?.ok ||
    !("serviceId" in context.result) ||
    !projects?.ok ||
    !("projects" in projects.result)
  )
    throw new TypeError("Invalid connection response.");
  return { context: context.result, projects: projects.result.projects };
}
export function newTimerIntent(
  bookId: string,
  description: string,
  connection: Connection,
): TimerIntent {
  return {
    version: 2,
    action: "start",
    operationId: crypto.randomUUID(),
    timerId: crypto.randomUUID(),
    bookId,
    connection,
    start: new Date().toISOString(),
    end: null,
    description,
    remote: null,
  };
}
export function stopTimerIntent(
  bookId: string,
  description: string,
  timer: TimerV2,
  now = Date.now(),
): TimerIntent {
  return decodeTimerIntent({
    version: 2,
    action: "stop",
    operationId: crypto.randomUUID(),
    timerId: timer.timerId,
    bookId,
    connection: timer.connection,
    start: timer.start,
    end: new Date(now).toISOString(),
    description,
    remote: timer.remote,
  });
}
function belongs(uid: string): void {
  if (auth.currentUser?.uid !== uid)
    throw new Error("Sign in to the account that owns this timer operation.");
}
function commitLocal(row: OutboxRecord): Promise<void> {
  belongs(row.uid);
  const intent = row.intent,
    book = doc(db, "users", row.uid, "books", intent.bookId),
    claim = doc(db, "users", row.uid, "timerLifecycle", "current");
  const batch = writeBatch(db),
    now = Date.now();
  if (intent.action === "start") {
    const timer: TimerV2 = {
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
    };
    batch.update(book, { activeTimer: timer });
    batch.set(claim, claimV2(intent.bookId, timer));
  } else {
    const timer = row.timer;
    if (!timer)
      throw new Error("A stop operation must preserve the timer it stopped.");
    if (timer.remote !== null && intent.action === "stop") {
      const stopping: TimerV2 = {
        ...timer,
        state: "stopping",
        operationId: intent.operationId,
        queueId: intent.operationId,
        errorCode: null,
      };
      batch.update(book, { activeTimer: stopping });
      batch.set(claim, claimV2(intent.bookId, stopping));
    } else {
      batch.update(book, { activeTimer: null });
      batch.set(
        claim,
        idleV2(intent.bookId, { ...timer, operationId: intent.operationId }),
      );
    }
    if (intent.action === "stop" && intent.connection.provider !== "none")
      batch.set(
        doc(db, "users", row.uid, "timeTrackingQueue", intent.operationId),
        initialQueue(intent, Date.parse(intent.end ?? intent.start)),
      );
  }
  // Store the full canonical intent: an acknowledgement cannot authorize a
  // second body that happens to reuse the same ID.
  batch.set(doc(db, "users", row.uid, "timerOperations", intent.operationId), {
    ...operationAck(intent, now),
    intent,
  });
  return batch.commit();
}
async function sendRow(row: OutboxRecord): Promise<void> {
  belongs(row.uid);
  if (row.method === "batch") return commitLocal(row);
  if (row.method === "accept") {
    await timerAccept({
      intent: row.intent,
      expectedRunning: row.expectedRunning,
    });
    return;
  }
  if (row.method === "clear") {
    await timerClear({ intent: row.intent, remoteChecked: true });
    return;
  }
  await timerReplace({
    sourceOperationId: row.sourceId,
    intent: row.intent,
    reviewed: true,
    ...(row.correctedProjectId === null
      ? {}
      : { correctedProjectId: row.correctedProjectId }),
  });
}
async function accepted(row: OutboxRecord): Promise<boolean> {
  belongs(row.uid);
  const ack = await getDocFromServer(
    doc(db, "users", row.uid, "timerOperations", row.id),
  );
  if (ack.exists()) {
    const intent = decodeTimerIntent(ack.get("intent"));
    if (
      JSON.stringify(intent) !== JSON.stringify(decodeTimerIntent(row.intent))
    )
      throw new Error("Timer acknowledgement does not match its saved intent.");
    return true;
  }
  // Retained queue rows provide another durable acceptance record. A missing
  // row is never by itself evidence that an earlier submission did not land.
  const queue = await getDocFromServer(
    doc(db, "users", row.uid, "timeTrackingQueue", row.id),
  );
  if (!queue.exists()) return false;
  if (
    JSON.stringify(decodeTimerIntent(queue.get("intent"))) !==
    JSON.stringify(decodeTimerIntent(row.intent))
  )
    throw new Error("Queue operation does not match its saved intent.");
  return true;
}
function permanent(error: unknown): boolean {
  return (
    error instanceof FirebaseError &&
    [
      "permission-denied",
      "failed-precondition",
      "functions/failed-precondition",
      "functions/invalid-argument",
      "functions/permission-denied",
      "functions/not-found",
      "functions/already-exists",
    ].includes(error.code)
  );
}
export async function submitTimerOperation(row: OutboxRecord): Promise<void> {
  belongs(row.uid);
  await putOutbox(row);
  // Do not await Firestore's offline commit in the UI. Its local timer
  // snapshot is immediate; reconciliation retains the interval on rejection.
  void deliverSavedOperation(row).catch(() => {
    addError(
      "Your timer operation is saved on this device and will retry when you reconnect.",
    );
  });
}
async function deliverSavedOperation(row: OutboxRecord): Promise<void> {
  await sendRow(row)
    .then(async () => {
      if (navigator.onLine && (await accepted(row)))
        await removeOutbox(row.uid, row.id);
    })
    .catch(async (error: unknown) => {
      if (permanent(error)) {
        if (navigator.onLine && (await accepted(row)))
          await removeOutbox(row.uid, row.id);
        else {
          await putOutbox({
            ...row,
            state: "recovery",
            errorCode: error instanceof FirebaseError ? error.code : "rejected",
          });
          addError(
            "Your timer operation was saved for recovery. Open Time tracking in settings.",
          );
        }
      } else {
        addError(
          "Your timer operation is saved on this device and will retry when you reconnect.",
        );
      }
    });
}
export async function reconcileTimerOutbox(uid: string): Promise<void> {
  if (!navigator.onLine) return;
  await withTimerLock(uid, async () => {
    belongs(uid);
    // Wait for this client's earlier Firestore submissions to settle before
    // looking up acknowledgements or attempting the identical batch again.
    try {
      await waitForPendingWrites(db);
    } catch (error) {
      // Rejected offline batches have settled too. Reconcile their durable
      // acknowledgements before classifying an operation as rejected.
      if (!permanent(error)) throw error;
    }
    belongs(uid);
    for (const row of await listOutbox(uid)) {
      if (await accepted(row)) {
        await removeOutbox(uid, row.id);
        continue;
      }
      if (row.state === "recovery") continue;
      try {
        await sendRow(row);
      } catch (error) {
        if (!permanent(error)) throw error;
        // A Rules rejection may race an already accepted delivery from a
        // different tab. Read durable proof again before offering recovery.
        if (await accepted(row)) {
          await removeOutbox(uid, row.id);
          continue;
        }
        await putOutbox({
          ...row,
          state: "recovery",
          errorCode: error instanceof FirebaseError ? error.code : "rejected",
        });
        continue;
      }
      if (await accepted(row)) await removeOutbox(uid, row.id);
    }
  });
}
export function pendingOperation(
  uid: string,
  intent: TimerIntent,
  method: OutboxRecord["method"],
  timer: TimerV2 | null = null,
  expectedRunning: OutboxRecord["expectedRunning"] = null,
): OutboxRecord {
  return {
    uid,
    id: intent.operationId,
    intent,
    timer,
    method,
    expectedRunning,
    sourceId: null,
    correctedProjectId: null,
    state: "pending",
    errorCode: null,
  };
}
