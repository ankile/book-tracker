import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v1/https";
import {
  assertCurrentConnection,
  inspectThreeggle,
  timerCredential,
} from "./timeTrackingConnections";
import { decodeTogglQueueDocument } from "./decoders";
import {
  decodeTimerIntent,
  sameConnection,
  claimV2,
  decodeClaimV2,
  decodeQueueV2,
  decodeTimerV2,
  idleV2,
  initialQueue,
  operationAck,
} from "./shared/timeTracking";
import type { QueueV2, TimerIntent } from "./shared/timeTracking";
import { assertLiveAccount } from "./callerGuards";

const db = getFirestore();
export async function acknowledgeLegacyTogglFailure(
  uid: string,
  queueId: string,
): Promise<void> {
  await db.runTransaction(async (tx) => {
    const ref = db.doc(`users/${uid}/togglQueue/${queueId}`),
      user = await tx.get(db.doc(`users/${uid}`)),
      snap = await tx.get(ref);
    assertLiveAccount(user.exists, user.get("deletedAt"));
    if (!snap.exists)
      throw new HttpsError("not-found", "Queue item not found.");
    const row = decodeTogglQueueDocument(snap.data());
    if (row.legacyResolution) return;
    const eligible =
      (row.status === "outcome-unknown" &&
        row.claimedAt.toMillis() < Date.now() - 180000) ||
      (row.status === "error" && row.attempts >= 5) ||
      (row.status === "processing" &&
        row.attempts >= 5 &&
        row.claimedAt.toMillis() < Date.now() - 21600000);
    if (row.type !== "create" || !eligible)
      throw new HttpsError(
        "failed-precondition",
        "Only a terminal create may be acknowledged here. Resolve a failed stop from its timer.",
      );
    tx.update(ref, {
      legacyResolution: {
        acknowledgedAt: Timestamp.now(),
        reason: "remote_outcome_checked",
      },
      expiresAt: FieldValue.delete(),
    });
  });
}
export async function clearReviewedTimer(
  uid: string,
  intent: TimerIntent,
): Promise<void> {
  if (intent.action !== "clear")
    throw new HttpsError("invalid-argument", "Expected a clear operation.");
  await db.runTransaction(async (tx) => {
    const bookRef = db.doc(`users/${uid}/books/${intent.bookId}`),
      claimRef = db.doc(`users/${uid}/timerLifecycle/current`),
      ackRef = db.doc(`users/${uid}/timerOperations/${intent.operationId}`);
    const [book, claim, ack] = await Promise.all([
      tx.get(bookRef),
      tx.get(claimRef),
      tx.get(ackRef),
    ]);
    await assertCurrentConnection(tx, uid, intent.connection);
    if (ack.exists) {
      if (
        JSON.stringify(decodeTimerIntent(ack.get("intent"))) !==
        JSON.stringify(intent)
      )
        throw new HttpsError("already-exists", "Operation ID already used.");
      return;
    }
    const timer = decodeTimerV2(book.get("activeTimer")),
      lifecycle = decodeClaimV2(claim.data());
    if (
      timer.timerId !== intent.timerId ||
      timer.start !== intent.start ||
      lifecycle.state !== "active" ||
      lifecycle.bookId !== intent.bookId ||
      JSON.stringify(timer) !== JSON.stringify(lifecycle.timer)
    )
      throw new HttpsError(
        "failed-precondition",
        "Timer changed. Reload first.",
      );
    const queue =
      timer.queueId === null
        ? null
        : await tx.get(
            db.doc(`users/${uid}/timeTrackingQueue/${timer.queueId}`),
          );
    if (queue !== null) {
      const item = decodeQueueV2(queue.data());
      if (
        item.status === "outcome-unknown" &&
        item.claimedAt !== null &&
        item.claimedAt > Date.now() - 180000
      )
        throw new HttpsError(
          "failed-precondition",
          "The provider request may still be running. Wait before acknowledging its outcome.",
        );
      if (
        item.status !== "terminal" &&
        item.status !== "outcome-unknown" &&
        item.status !== "paused"
      )
        throw new HttpsError(
          "failed-precondition",
          "This operation is still retryable. Let it finish or repair its connection.",
        );
      tx.update(queue.ref, { resolution: "remote_outcome_checked" });
    } else if (timer.state !== "local")
      throw new HttpsError(
        "failed-precondition",
        "Stop the remote timer before clearing it.",
      );
    tx.update(bookRef, { activeTimer: null });
    tx.set(
      claimRef,
      idleV2(intent.bookId, { ...timer, operationId: intent.operationId }),
    );
    tx.create(ackRef, { ...operationAck(intent, Date.now()), intent });
  });
}
export async function retryTimerOperation(
  uid: string,
  operationId: string,
): Promise<void> {
  await db.runTransaction(async (tx) => {
    const ref = db.doc(`users/${uid}/timeTrackingQueue/${operationId}`),
      snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Operation not found.");
    const row = decodeQueueV2(snap.data());
    await assertCurrentConnection(tx, uid, row.intent.connection);
    if (row.status === "synced" || row.resolution || row.successorId) return;
    if (row.status === "outcome-unknown" || row.status === "terminal")
      throw new HttpsError(
        "failed-precondition",
        "Review this operation before creating a new export.",
      );
    if (
      row.status === "processing" &&
      row.claimedAt !== null &&
      row.claimedAt > Date.now() - 180000
    )
      return;
    if (row.retryAt !== null && row.retryAt > Date.now())
      throw new HttpsError(
        "resource-exhausted",
        "Wait until the retry window opens.",
      );
    tx.update(ref, {
      status: "pending",
      retryAt: null,
      errorCode: null,
      ...(row.status === "paused" ? { attempts: 0 } : {}),
    });
  });
}
export async function retryAsNewExport(
  uid: string,
  sourceId: string,
  intent: TimerIntent,
  correctedProjectId?: string,
): Promise<void> {
  const sourceRef = db.doc(`users/${uid}/timeTrackingQueue/${sourceId}`);
  const initial = decodeQueueV2((await sourceRef.get()).data());
  if (intent.action !== "stop" || initial.intent.action !== "stop")
    throw new HttpsError(
      "failed-precondition",
      "Start a fresh online timer after a failed start; historical intervals must be exported as completed activity.",
    );
  if (intent.connection.provider === "threeggle") {
    const token = await timerCredential(uid, intent.connection);
    if (!token)
      throw new HttpsError(
        "failed-precondition",
        "Repair the connection first.",
      );
    const connection = intent.connection;
    const available = await inspectThreeggle(token);
    if (
      available.context.serviceId !== intent.connection.serviceId ||
      available.context.accountId !== intent.connection.accountId ||
      (initial.intent.remote === null &&
        !available.projects.some(
          (p) => p.id === (correctedProjectId ?? connection.projectId),
        ))
    )
      throw new HttpsError(
        "failed-precondition",
        "Choose an active project in the same Threeggle account.",
      );
  }
  await db.runTransaction(async (tx) => {
    const source = await tx.get(sourceRef),
      row = decodeQueueV2(source.data());
    const bookRef = db.doc(`users/${uid}/books/${row.intent.bookId}`),
      claimRef = db.doc(`users/${uid}/timerLifecycle/current`);
    const [book, claim] = await Promise.all([
      tx.get(bookRef),
      tx.get(claimRef),
    ]);
    await assertCurrentConnection(tx, uid, row.intent.connection);
    if (row.successorId) {
      if (row.successorId === intent.operationId) return;
      throw new HttpsError(
        "already-exists",
        "This operation already has a replacement.",
      );
    }
    if (
      row.status !== "terminal" ||
      row.resolution ||
      row.errorCode === "delivery_unconfirmed"
    )
      throw new HttpsError(
        "failed-precondition",
        "Only a definitively rejected operation can be replaced.",
      );
    const old = row.intent;
    if (
      intent.timerId !== old.timerId ||
      intent.bookId !== old.bookId ||
      intent.description !== old.description ||
      JSON.stringify(intent.remote) !== JSON.stringify(old.remote) ||
      intent.operationId === sourceId
    )
      throw new HttpsError(
        "invalid-argument",
        "The replacement must preserve the original timer and activity.",
      );
    if (!sameConnection(old.connection, intent.connection))
      throw new HttpsError(
        "invalid-argument",
        "The replacement must preserve its connection identity.",
      );
    if (
      correctedProjectId !== undefined &&
      row.errorCode !== "project_unavailable" &&
      row.errorCode !== "project_not_found"
    )
      throw new HttpsError(
        "invalid-argument",
        "Project correction requires a rejected project on a new entry.",
      );
    if (old.remote !== null && correctedProjectId !== undefined)
      throw new HttpsError(
        "invalid-argument",
        "Repair a stopped entry's project in the remote app.",
      );
    const successor: QueueV2 = initialQueue(intent, Date.now());
    if (correctedProjectId !== undefined) {
      if (intent.connection.provider !== "threeggle" || intent.end === null)
        throw new HttpsError(
          "invalid-argument",
          "Only a completed Threeggle export can change project.",
        );
      const shift = Math.max(0, Date.parse(intent.end) - Date.now());
      successor.prepared = {
        provider: "threeggle",
        request: {
          client: "book-tracker",
          action: "create_interval",
          requestId: intent.operationId,
          description: intent.description,
          projectId: correctedProjectId,
          startTime: Date.parse(intent.start) - shift,
          endTime: Date.parse(intent.end) - shift,
        },
      };
    }
    if (old.remote !== null) {
      const timer = decodeTimerV2(book.get("activeTimer")),
        lifecycle = decodeClaimV2(claim.data());
      if (
        timer.state !== "stopping" ||
        timer.queueId !== sourceId ||
        lifecycle.state !== "active" ||
        JSON.stringify(timer) !== JSON.stringify(lifecycle.timer)
      )
        throw new HttpsError(
          "failed-precondition",
          "The queued stop no longer owns the timer.",
        );
      const replacement = {
        ...timer,
        operationId: intent.operationId,
        queueId: intent.operationId,
        errorCode: null,
      };
      tx.update(bookRef, { activeTimer: replacement });
      tx.set(claimRef, claimV2(intent.bookId, replacement));
    }
    tx.update(sourceRef, { successorId: intent.operationId });
    tx.create(
      db.doc(`users/${uid}/timeTrackingQueue/${intent.operationId}`),
      successor,
    );
    tx.create(db.doc(`users/${uid}/timerOperations/${intent.operationId}`), {
      ...operationAck(intent, Date.now()),
      intent,
    });
    tx.create(
      db.doc(`users/${uid}/timeTrackingResults/${intent.operationId}`),
      {
        review: {
          sourceOperationId: sourceId,
          originalIntent: old,
          correctedIntent: intent,
          ...(correctedProjectId === undefined
            ? {}
            : {
                originalProjectId:
                  old.connection.provider === "none"
                    ? null
                    : old.connection.projectId,
                correctedProjectId,
              }),
        },
        recordedAt: Date.now(),
      },
    );
  });
}

export async function acknowledgeTimerFailure(
  uid: string,
  operationId: string,
): Promise<void> {
  await db.runTransaction(async (tx) => {
    const ref = db.doc(`users/${uid}/timeTrackingQueue/${operationId}`),
      snap = await tx.get(ref),
      claim = await tx.get(db.doc(`users/${uid}/timerLifecycle/current`));
    const row = decodeQueueV2(snap.data());
    await assertCurrentConnection(tx, uid, row.intent.connection);
    if (row.resolution) return;
    if (
      row.status === "outcome-unknown" &&
      row.claimedAt !== null &&
      row.claimedAt > Date.now() - 180000
    )
      throw new HttpsError(
        "failed-precondition",
        "The provider request may still be running. Wait before acknowledging its outcome.",
      );
    if (
      row.status !== "terminal" &&
      row.status !== "outcome-unknown" &&
      row.status !== "paused"
    )
      throw new HttpsError(
        "failed-precondition",
        "This operation is still retryable.",
      );
    if (claim.get("version") === 2 && claim.get("state") === "active") {
      const lifecycle = decodeClaimV2(claim.data());
      if (
        lifecycle.state === "active" &&
        lifecycle.timer.queueId === operationId
      )
        throw new HttpsError(
          "failed-precondition",
          "Clear the matching timer to acknowledge this failure.",
        );
    }
    tx.update(ref, { resolution: "remote_outcome_checked" });
  });
}
