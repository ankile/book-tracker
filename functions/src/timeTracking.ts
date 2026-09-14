import { consumeQuota } from "./quota";
import { logAppCheckPresence } from "./appCheck";
import * as functions from "firebase-functions/v1";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import {
  CALLABLE_MAX_INSTANCES,
  EVENT_INGRESS,
  FUNCTIONS_RUNTIME_SERVICE_ACCOUNT,
} from "./runtime";
import { requireVerifiedUid, requireLiveUser } from "./callerGuards";
import {
  activateConnection,
  connectionQuota,
  inspectThreeggle,
  timerCredential,
} from "./timeTrackingConnections";
import { acceptTimerIntent, processTimerQueue } from "./timeTrackingQueue";
import {
  acknowledgeTimerFailure,
  acknowledgeLegacyTogglFailure,
  clearReviewedTimer,
  retryAsNewExport,
  retryTimerOperation,
} from "./timeTrackingRecovery";
import { decodeConnection, decodeTimerIntent } from "./shared/timeTracking";
import { isOperationId, wireRecord } from "./shared/time-tracking-api";
import { getFirestore } from "firebase-admin/firestore";

const callable = functions
  .region("europe-west1")
  .runWith({
    serviceAccount: FUNCTIONS_RUNTIME_SERVICE_ACCOUNT,
    maxInstances: CALLABLE_MAX_INSTANCES,
    enforceAppCheck: true,
    timeoutSeconds: 120,
  });
function input(value: unknown): Record<string, unknown> {
  if (!wireRecord(value))
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Expected an object.",
    );
  return value;
}
function text(value: unknown, max = 500): string {
  if (typeof value !== "string" || !value.length || value.length > max)
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Invalid text field.",
    );
  return value;
}
function operation(value: unknown): string {
  if (!isOperationId(value))
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Invalid operation ID.",
    );
  return value;
}
exports.inspect = callable.https.onCall(async (data: unknown, context) => {
  logAppCheckPresence("timetracking.inspect", context);
  const uid = requireVerifiedUid(context),
    d = input(data);
  await connectionQuota(uid);
  return inspectThreeggle(text(d.token, 4096));
});
exports.connect = callable.https.onCall(async (data: unknown, context) => {
  logAppCheckPresence("timetracking.connect", context);
  const uid = requireVerifiedUid(context),
    d = input(data);
  if (
    d.provider !== "none" &&
    d.provider !== "toggl" &&
    d.provider !== "threeggle"
  )
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Invalid provider.",
    );
  if (
    d.projectId !== undefined &&
    typeof d.projectId !== "string" &&
    typeof d.projectId !== "number"
  )
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Invalid project.",
    );
  const connection = await activateConnection(uid, {
    provider: d.provider,
    expectedRevision: text(d.expectedRevision, 100),
    ...(d.token === undefined ? {} : { token: text(d.token, 4096) }),
    ...(d.projectId === undefined ? {} : { projectId: d.projectId }),
    repair: d.repair === true,
  });
  return { connection };
});
exports.context = callable.https.onCall(async (_data: unknown, context) => {
  logAppCheckPresence("timetracking.context", context);
  const uid = requireVerifiedUid(context);
  await requireLiveUser(uid);
  if (
    !(
      await consumeQuota(
        getFirestore(),
        `users/${uid}/functionQuotas/timeTrackingContext`,
        60,
        3600000,
      )
    ).granted
  )
    throw new functions.https.HttpsError(
      "resource-exhausted",
      "Too many timer context requests. Try again later.",
    );
  const user = await getFirestore().doc(`users/${uid}`).get();
  const connection = decodeConnection(user.get("timeTracking"));
  if (connection.provider !== "threeggle")
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Threeggle is not connected.",
    );
  const token = await timerCredential(uid, connection);
  if (!token)
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Repair your Threeggle credential in settings.",
    );
  const inspected = await inspectThreeggle(token);
  if (
    inspected.context.serviceId !== connection.serviceId ||
    inspected.context.accountId !== connection.accountId
  )
    throw new functions.https.HttpsError(
      "failed-precondition",
      "The remote identity changed. Repair your connection.",
    );
  return inspected;
});
exports.accept = callable.https.onCall(async (data: unknown, context) => {
  logAppCheckPresence("timetracking.accept", context);
  const uid = requireVerifiedUid(context),
    d = input(data),
    intent = decodeTimerIntent(d.intent);
  let expectedRunning: { key: string; version: string } | null = null;
  if (d.expectedRunning !== undefined && d.expectedRunning !== null) {
    const running = input(d.expectedRunning);
    expectedRunning = {
      key: text(running.key, 256),
      version: text(running.version, 256),
    };
  }
  await acceptTimerIntent(uid, intent, expectedRunning);
  if (intent.connection.provider !== "none")
    await processTimerQueue(uid, intent.operationId);
  return { accepted: true, operationId: intent.operationId };
});
exports.retry = callable.https.onCall(async (data: unknown, context) => {
  logAppCheckPresence("timetracking.retry", context);
  const uid = requireVerifiedUid(context),
    id = operation(input(data).operationId);
  await retryTimerOperation(uid, id);
  await processTimerQueue(uid, id);
  return { accepted: true };
});
exports.replace = callable.https.onCall(async (data: unknown, context) => {
  logAppCheckPresence("timetracking.replace", context);
  const uid = requireVerifiedUid(context),
    d = input(data);
  if (d.reviewed !== true)
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Review the replacement interval first.",
    );
  const intent = decodeTimerIntent(d.intent);
  await retryAsNewExport(
    uid,
    operation(d.sourceOperationId),
    intent,
    d.correctedProjectId === undefined ? undefined : text(d.correctedProjectId),
  );
  await processTimerQueue(uid, intent.operationId);
  return { accepted: true };
});
exports.clear = callable.https.onCall(async (data: unknown, context) => {
  logAppCheckPresence("timetracking.clear", context);
  const uid = requireVerifiedUid(context),
    d = input(data);
  if (d.remoteChecked !== true)
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Check the remote timer before clearing it.",
    );
  await clearReviewedTimer(uid, decodeTimerIntent(d.intent));
  return { accepted: true };
});
exports.acknowledgelegacy = callable.https.onCall(
  async (data: unknown, context) => {
    logAppCheckPresence("timetracking.acknowledgelegacy", context);
    const uid = requireVerifiedUid(context),
      d = input(data);
    if (d.remoteChecked !== true)
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Check the remote outcome first.",
      );
    const id = text(d.queueId, 600);
    if (id.includes("/") || id === "." || id === "..")
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Invalid queue ID.",
      );
    await acknowledgeLegacyTogglFailure(uid, id);
    return { accepted: true };
  },
);
exports.syncqueue = onDocumentWritten(
  {
    document: "users/{uid}/timeTrackingQueue/{operationId}",
    region: "europe-west1",
    timeoutSeconds: 120,
    maxInstances: 5,
    concurrency: 1,
    serviceAccount: FUNCTIONS_RUNTIME_SERVICE_ACCOUNT,
    ingressSettings: EVENT_INGRESS,
    retry: true,
  },
  async (event) => {
    if (
      !event.data?.after.exists ||
      event.data.after.get("status") !== "pending"
    )
      return;
    await requireLiveUser(event.params.uid);
    await processTimerQueue(event.params.uid, event.params.operationId);
    const current = await getFirestore()
      .doc(
        `users/${event.params.uid}/timeTrackingQueue/${event.params.operationId}`,
      )
      .get();
    if (
      current.exists &&
      !current.get("resolution") &&
      !current.get("successorId") &&
      ["pending", "processing"].includes(current.get("status"))
    ) {
      // Keep Eventarc delivery alive across retry windows, including when
      // the browser closes. Worker leases and retryAt prevent early sends.
      throw new Error(
        "Timer operation is awaiting its retry window or active worker.",
      );
    }
  },
);

exports.acknowledge = callable.https.onCall(async (data: unknown, context) => {
  logAppCheckPresence("timetracking.acknowledge", context);
  const uid = requireVerifiedUid(context),
    d = input(data);
  if (d.remoteChecked !== true)
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Check the remote outcome first.",
    );
  await acknowledgeTimerFailure(uid, operation(d.operationId));
  return { accepted: true };
});

exports.sweep = callable.https.onCall(async (_data: unknown, context) => {
  logAppCheckPresence("timetracking.sweep", context);
  const uid = requireVerifiedUid(context);
  await requireLiveUser(uid);
  if (
    !(
      await consumeQuota(
        getFirestore(),
        `users/${uid}/functionQuotas/timeTrackingSweep`,
        30,
        3600000,
      )
    ).granted
  )
    return { processed: 0 };
  const rows = await getFirestore()
    .collection(`users/${uid}/timeTrackingQueue`)
    .where("status", "in", ["pending", "processing"])
    .limit(60)
    .get();
  let processed = 0;
  for (const row of rows.docs) {
    const retryAt: unknown = row.get("retryAt"),
      claimedAt: unknown = row.get("claimedAt");
    if (typeof retryAt === "number" && retryAt > Date.now()) continue;
    if (
      row.get("status") === "processing" &&
      typeof claimedAt === "number" &&
      claimedAt > Date.now() - 180000
    )
      continue;
    await processTimerQueue(uid, row.id);
    processed++;
  }
  return { processed };
});
