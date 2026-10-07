import { logger } from "firebase-functions";
import { logIssue } from "./logging";
import { phaseTimer } from "./phaseTiming";
import { wireRecord } from "./shared/time-tracking-api";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import type { DocumentData, Transaction } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v1/https";
import { assertLiveAccount } from "./callerGuards";
import { applyQuota } from "./quota";
import {
  assertCurrentConnection,
  timerCredential,
} from "./timeTrackingConnections";
import { threeggleRequest } from "./threeggleTransport";
import { togglFetch } from "./togglTransport";
import {
  decodeStartedTogglEntry,
  decodeCreatedTogglEntryId,
  decodeTogglTimerEntry,
} from "./decoders";
import {
  sameConnection,
  effectiveConnection,
  claimV2,
  decodeTimerIntent,
  decodeClaimV2,
  decodeQueueV2,
  decodeTimerControls,
  decodeTimerV2,
  idleV2,
  initialQueue,
  operationAck,
} from "./shared/timeTracking";
import type {
  PreparedRequest,
  QueueV2,
  RemoteReference,
  TimerIntent,
  TimerV2,
  TimerInterval,
} from "./shared/timeTracking";
import type {
  TimeTrackingEntry,
  TimeTrackingFailure,
  TimeTrackingHttpResult,
  TimeTrackingWriteResponse,
  TimeTrackingResponse,
} from "./shared/time-tracking-api";

const db = getFirestore();
const LEASE_MS = 180000;
const MAX_ATTEMPTS = 10;
function paths(uid: string) {
  return {
    user: db.doc(`users/${uid}`),
    claim: db.doc(`users/${uid}/timerLifecycle/current`),
    queues: db.collection(`users/${uid}/timeTrackingQueue`),
    acks: db.collection(`users/${uid}/timerOperations`),
    results: db.collection(`users/${uid}/timeTrackingResults`),
    quota: db.doc(`users/${uid}/functionQuotas/timeTrackingQueue`),
    rows: db.doc(`users/${uid}/functionQuotas/timeTrackingQueueRows`),
  };
}
// Claims one delivery attempt for a queue row inside the caller's
// transaction, after it has read both quota documents. A refused claim
// returns the deferred or paused row instead.
function claimRow(
  tx: Transaction,
  uid: string,
  row: QueueV2,
  quota: DocumentData | undefined,
  rows: DocumentData | undefined,
): { next: QueueV2; claimed: boolean } {
  const p = paths(uid);
  if (!row.rowCounted) {
    const rowQuota = applyQuota(tx, p.rows, rows, 60, 3600000, Timestamp.now());
    if (!rowQuota.granted)
      return {
        claimed: false,
        next: {
          ...row,
          status: "pending",
          retryAt: Date.now() + 3600000,
          errorCode: "row_limit",
        },
      };
  }
  const granted = applyQuota(
    tx,
    p.quota,
    quota,
    row.intent.remote !== null ? 60 : 30,
    3600000,
    Timestamp.now(),
  );
  if (!granted.granted)
    return {
      claimed: false,
      next: {
        ...row,
        rowCounted: true,
        status: "pending",
        retryAt: Date.now() + 3600000,
        errorCode: "rate_limited",
      },
    };
  if (row.attempts >= MAX_ATTEMPTS)
    return {
      claimed: false,
      next: {
        ...row,
        rowCounted: true,
        status: "paused",
        errorCode: "retry_limit",
      },
    };
  return {
    claimed: true,
    next: {
      ...row,
      rowCounted: true,
      status: "processing",
      attempts: row.attempts + 1,
      claimedAt: Date.now(),
      retryAt: null,
      errorCode: null,
    },
  };
}
// Accepting a remote operation also claims its first delivery in the same
// transaction. The callable then delivers it inline, and the queue trigger
// sees a leased row instead of racing the callable for a pending one.
export async function acceptTimerIntent(
  uid: string,
  submitted: TimerIntent,
  expectedRunning: { key: string; version: string } | null,
): Promise<QueueV2 | null> {
  const intent = decodeTimerIntent(submitted);
  const p = paths(uid),
    book = db.doc(`users/${uid}/books/${intent.bookId}`);
  return db.runTransaction(async (tx) => {
    const [ack, bookSnap, claimSnap, controlsSnap, user, quota, rows] =
      await Promise.all([
        tx.get(p.acks.doc(intent.operationId)),
        tx.get(book),
        tx.get(p.claim),
        tx.get(db.doc("configuration/timeTracking")),
        tx.get(p.user),
        tx.get(p.quota),
        tx.get(p.rows),
      ]);
    assertLiveAccount(user.exists, user.get("deletedAt"));
    if (ack.exists) {
      if (
        JSON.stringify(decodeTimerIntent(ack.get("intent"))) !==
        JSON.stringify(intent)
      )
        throw new HttpsError(
          "already-exists",
          "An operation ID cannot identify different timer actions.",
        );
      return null;
    }
    if (!sameConnection(effectiveConnection(user.data()), intent.connection))
      throw new HttpsError(
        "failed-precondition",
        "The time tracking connection changed. Reload before continuing.",
      );
    if (!bookSnap.exists) throw new HttpsError("not-found", "Book not found.");
    const controls = decodeTimerControls(controlsSnap.data());
    const now = Date.now();
    let queue: QueueV2 | null = null;
    if (intent.action === "start") {
      if (
        controls.timerWriteVersion !== 2 ||
        (intent.connection.provider === "threeggle" &&
          !controls.threeggleEnabled)
      )
        throw new HttpsError(
          "failed-precondition",
          "New timers are temporarily unavailable for this connection.",
        );
      if (
        !claimSnap.exists ||
        claimSnap.get("state") !== "idle" ||
        bookSnap.get("activeTimer")
      )
        throw new HttpsError(
          "failed-precondition",
          "A timer is already running or awaiting recovery.",
        );
      const local = intent.connection.provider === "none";
      const timer: TimerV2 = {
        version: 2,
        timerId: intent.timerId,
        operationId: intent.operationId,
        connection: intent.connection,
        state: local ? "local" : "starting",
        start: intent.start,
        claimedAt: now,
        remote: null,
        queueId: local ? null : intent.operationId,
        errorCode: null,
      };
      if (!local) {
        queue = initialQueue(intent, now);
        const start = new Date(now).toISOString();
        if (intent.connection.provider === "threeggle")
          queue.prepared = {
            provider: "threeggle",
            request: {
              client: "book-tracker",
              action: "start",
              requestId: intent.operationId,
              description: intent.description,
              projectId: intent.connection.projectId,
              startTime: now,
              expectedRunning,
            },
          };
        else
          queue.prepared = {
            provider: "toggl",
            action: "start",
            start,
            end: null,
            description: intent.description,
            entryId: null,
          };
      }
      tx.update(book, { activeTimer: timer });
      tx.set(p.claim, claimV2(intent.bookId, timer));
    } else {
      const current = decodeTimerV2(bookSnap.get("activeTimer"));
      const claim = decodeClaimV2(claimSnap.data());
      if (
        claim.state !== "active" ||
        claim.bookId !== intent.bookId ||
        JSON.stringify(claim.timer) !== JSON.stringify(current) ||
        current.timerId !== intent.timerId ||
        current.start !== intent.start ||
        JSON.stringify(current.remote) !== JSON.stringify(intent.remote)
      )
        throw new HttpsError(
          "failed-precondition",
          "This timer has changed. Reload before continuing.",
        );
      if (intent.action === "clear")
        throw new HttpsError(
          "failed-precondition",
          "Use the reviewed recovery action to clear a timer.",
        );
      if (current.state !== "local" && current.state !== "remote")
        throw new HttpsError(
          "failed-precondition",
          "Resolve this timer before stopping it.",
        );
      if (intent.connection.provider !== "none")
        queue = initialQueue(intent, now);
      // Callable stops happen online. Offline batches retain their recorded end.
      if (
        queue &&
        intent.connection.provider === "toggl" &&
        intent.remote?.provider === "toggl"
      )
        queue.prepared = {
          provider: "toggl",
          action: "stop_now",
          start: intent.start,
          end: intent.end,
          description: intent.description,
          entryId: intent.remote.entryId,
        };
      // An online stop ends now, so it targets the entry directly. Threeggle
      // still refuses a missing target or an end before its current start,
      // and returns already_stopped for a completed one.
      if (
        queue &&
        intent.end !== null &&
        intent.connection.provider === "threeggle" &&
        intent.remote?.provider === "threeggle"
      )
        queue.prepared = {
          provider: "threeggle",
          request: {
            client: "book-tracker",
            action: "stop",
            requestId: intent.operationId,
            entryKey: intent.remote.entryKey,
            endTime: Math.min(Date.parse(intent.end), now),
          },
        };
      if (current.remote !== null) {
        const stopping: TimerV2 = {
          ...current,
          state: "stopping",
          operationId: intent.operationId,
          queueId: intent.operationId,
          errorCode: null,
        };
        tx.update(book, { activeTimer: stopping });
        tx.set(p.claim, claimV2(intent.bookId, stopping));
      } else {
        tx.update(book, { activeTimer: null });
        tx.set(
          p.claim,
          idleV2(intent.bookId, {
            ...current,
            operationId: intent.operationId,
          }),
        );
      }
    }
    tx.create(p.acks.doc(intent.operationId), {
      ...operationAck(intent, now),
      intent,
    });
    if (queue === null) return null;
    const { next, claimed } = claimRow(
      tx,
      uid,
      queue,
      quota.data(),
      rows.data(),
    );
    tx.create(p.queues.doc(intent.operationId), next);
    return claimed ? next : null;
  });
}

// The accept callable's path: accept, then deliver the claimed row inline.
// The credential read only names the submitted revision; acceptance verifies
// that revision is the active connection before the token is used.
export async function acceptAndDeliver(
  uid: string,
  intent: TimerIntent,
  expectedRunning: { key: string; version: string } | null,
): Promise<void> {
  const [claimed, token] = await Promise.all([
    acceptTimerIntent(uid, intent, expectedRunning),
    timerCredential(uid, intent.connection),
  ]);
  if (intent.connection.provider !== "none")
    await processTimerQueue(
      uid,
      intent.operationId,
      claimed === null ? undefined : { item: claimed, token },
    );
}

type Outcome = {
  status: QueueV2["status"];
  code: string | null;
  retryAt?: number;
  remote?: RemoteReference;
  start?: string;
  response?: TimeTrackingWriteResponse;
  interval?: TimerInterval;
  observation?: TimeTrackingResponse;
};
function failureOutcome(result: TimeTrackingHttpResult): Outcome {
  if (result.response.ok) throw new Error("Expected a Threeggle failure.");
  const code = result.response.error.code;
  const paused = result.status === 401 || result.status === 403;
  const retry = result.status === 429 || result.status >= 500;
  return {
    status: paused ? "paused" : retry ? "pending" : "terminal",
    code,
    retryAt: retry ? Date.now() + (result.retryAfter ?? 30) * 1000 : undefined,
    response: result.response,
  };
}
function writeOutcome(result: TimeTrackingHttpResult): Outcome {
  if (!result.response.ok) return failureOutcome(result);
  if (!("disposition" in result.response.result))
    throw new Error("Threeggle did not return a write result.");
  return {
    status: "synced",
    code: null,
    remote: {
      provider: "threeggle",
      entryKey: result.response.result.entry.key,
    },
    start: new Date(result.response.result.entry.startTime).toISOString(),
    response: { ...result.response, result: result.response.result },
    ...(result.response.result.entry.endTime === null
      ? {}
      : {
          interval: {
            start: new Date(
              result.response.result.entry.startTime,
            ).toISOString(),
            end: new Date(result.response.result.entry.endTime).toISOString(),
          },
        }),
  };
}
function normalizedInterval(
  intent: TimerIntent,
  now: number,
): { start: string; end: string } {
  if (intent.end === null)
    throw new Error("Completed interval requires an end.");
  const originalStart = Date.parse(intent.start),
    originalEnd = Date.parse(intent.end);
  const shift = Math.max(0, originalEnd - now);
  return {
    start: new Date(originalStart - shift).toISOString(),
    end: new Date(originalEnd - shift).toISOString(),
  };
}
async function prepare(
  item: QueueV2,
  token: string,
): Promise<PreparedRequest | Outcome> {
  if (item.prepared !== null) return item.prepared;
  const { intent } = item,
    connection = intent.connection;
  if (
    intent.action !== "stop" ||
    intent.end === null ||
    connection.provider === "none"
  )
    throw new Error("Invalid queued intent.");
  if (intent.remote === null) {
    if (Date.parse(intent.end) <= Date.parse(intent.start))
      return { status: "terminal", code: "invalid_time" };
    const interval = normalizedInterval(intent, Date.now());
    if (connection.provider === "threeggle")
      return {
        provider: "threeggle",
        request: {
          client: "book-tracker",
          action: "create_interval",
          requestId: intent.operationId,
          description: intent.description,
          projectId: connection.projectId,
          startTime: Date.parse(interval.start),
          endTime: Date.parse(interval.end),
        },
      };
    return {
      provider: "toggl",
      action: "create_interval",
      ...interval,
      description: intent.description,
      entryId: null,
    };
  }
  if (
    connection.provider === "threeggle" &&
    intent.remote.provider === "threeggle"
  ) {
    const lookup = await threeggleRequest(token, {
      client: "book-tracker",
      action: "entry",
      entryKey: intent.remote.entryKey,
    });
    if (!lookup.response.ok) return failureOutcome(lookup);
    if (!("entry" in lookup.response.result))
      throw new Error("Threeggle did not return an entry.");
    const entry = lookup.response.result.entry;
    // A completed target is sent to stop as well: its immutable receipt then
    // records already_stopped without changing the user's remote edits.
    const cappedEnd = Math.min(Date.parse(intent.end), Date.now());
    if (entry.endTime === null && cappedEnd <= entry.startTime)
      return { status: "paused", code: "end_before_start" };
    return {
      provider: "threeggle",
      request: {
        client: "book-tracker",
        action: "stop",
        requestId: intent.operationId,
        entryKey: intent.remote.entryKey,
        endTime: cappedEnd,
      },
    };
  }
  if (connection.provider !== "toggl" || intent.remote.provider !== "toggl")
    throw new Error("Timer provider mismatch.");
  const end = Math.min(Date.parse(intent.end), Date.now());
  if (end <= Date.parse(intent.start))
    return { status: "paused", code: "end_before_start" };
  return {
    provider: "toggl",
    action: "stop",
    start: intent.start,
    end: new Date(end).toISOString(),
    description: intent.description,
    entryId: intent.remote.entryId,
  };
}
function togglStopFailure(status: number): Outcome {
  if (status === 401 || status === 403)
    return { status: "paused", code: "unauthorized" };
  if (status === 429 || status >= 500)
    return {
      status: "pending",
      code: status === 429 ? "rate_limited" : "provider_unavailable",
      retryAt: Date.now() + 60000,
    };
  return { status: "terminal", code: `provider_${status}` };
}
async function stopToggl(
  token: string,
  item: QueueV2,
  prepared: Extract<PreparedRequest, { provider: "toggl" }>,
): Promise<Outcome> {
  const connection = item.intent.connection;
  if (
    connection.provider !== "toggl" ||
    prepared.entryId === null ||
    prepared.end === null
  )
    throw new Error("Invalid targeted Toggl stop.");
  const target = `/workspaces/${connection.workspaceId}/time_entries/${prepared.entryId}`;
  const lookup = () =>
    togglFetch(token, "GET", `/me/time_entries/${prepared.entryId}`);
  const completed = (value: unknown): Outcome => {
    const finalEntry = decodeTogglTimerEntry(value);
    if (finalEntry.id !== prepared.entryId || finalEntry.duration < 0)
      throw new Error("Toggl did not confirm the completed target.");
    return {
      status: "synced",
      code: null,
      remote: { provider: "toggl", entryId: finalEntry.id },
      interval: {
        start: new Date(finalEntry.start).toISOString(),
        end: new Date(
          Date.parse(finalEntry.start) + finalEntry.duration * 1000,
        ).toISOString(),
      },
    };
  };
  if (prepared.action === "stop_now") {
    let onlineReply = await togglFetch(token, "PATCH", `${target}/stop`);
    // Toggl's targeted stop refuses a completed entry. Read the existing
    // result instead of reopening or extending it after an external switch.
    if (onlineReply.status === 409) onlineReply = await lookup();
    if (!onlineReply.ok) return togglStopFailure(onlineReply.status);
    return completed(await onlineReply.json());
  }
  const existing = await lookup();
  if (!existing.ok) return togglStopFailure(existing.status);
  const entry = decodeTogglTimerEntry(await existing.json());
  if (entry.id !== prepared.entryId)
    throw new Error("Toggl returned a different target.");
  if (entry.duration >= 0) return completed(entry);
  if (Date.parse(prepared.end) <= Date.parse(entry.start))
    return { status: "paused", code: "end_before_start" };
  // A delayed offline stop keeps its recorded end, but never sends stale
  // description/project/start/duration fields. Toggl derives duration from
  // the current start. The provider offers no conditional update for this
  // offline timestamp; a concurrent external stop remains a provider limit.
  const reply = await togglFetch(token, "PUT", target, { stop: prepared.end });
  if (!reply.ok) return togglStopFailure(reply.status);
  return completed(await reply.json());
}
async function send(
  token: string,
  item: QueueV2,
  prepared: PreparedRequest,
  firstDelivery: boolean,
): Promise<Outcome> {
  if (prepared.provider === "threeggle") {
    const result = await threeggleRequest(token, prepared.request);
    if (
      !result.response.ok &&
      prepared.request.action === "stop" &&
      result.response.error.code === "invalid_time" &&
      result.response.error.details &&
      "reason" in result.response.error.details &&
      result.response.error.details.reason === "end_before_start"
    )
      return {
        status: "paused",
        code: "end_before_start",
        response: result.response,
      };
    if (
      result.response.requestId !== undefined &&
      result.response.requestId !== prepared.request.requestId
    )
      throw new Error("Threeggle returned a different operation.");
    if (result.response.ok) {
      if (!("disposition" in result.response.result))
        throw new Error("Threeggle returned a different action.");
      const receipt = result.response.result;
      const valid =
        prepared.request.action === "start"
          ? receipt.disposition === "started"
          : prepared.request.action === "create_interval"
            ? receipt.disposition === "created"
            : (receipt.disposition === "stopped" ||
                receipt.disposition === "already_stopped") &&
              receipt.entry.key === prepared.request.entryKey;
      if (!valid || result.response.requestId !== prepared.request.requestId)
        throw new Error("Threeggle returned a mismatched write receipt.");
      // A first delivery executed just now, so its receipt is current.
      if (prepared.request.action === "start" && !firstDelivery) {
        // Receipts retain execution-time state, even after an external stop or
        // deletion. Check every redelivered start, including retries whose
        // attempt counter was reset after credential repair.
        const lookup = await threeggleRequest(token, {
          client: "book-tracker",
          action: "entry",
          entryKey: receipt.entry.key,
        });
        const original = writeOutcome(result);
        if (!lookup.response.ok)
          return {
            ...failureOutcome(lookup),
            response: original.response,
            observation: lookup.response,
          };
        if (
          !("entry" in lookup.response.result) ||
          lookup.response.result.entry.key !== receipt.entry.key
        )
          throw new Error("Threeggle returned a different start entry.");
        const current = lookup.response.result.entry;
        return {
          ...original,
          start: new Date(current.startTime).toISOString(),
          observation: lookup.response,
          ...(current.endTime === null
            ? {}
            : {
                interval: {
                  start: new Date(current.startTime).toISOString(),
                  end: new Date(current.endTime).toISOString(),
                },
              }),
        };
      }
    }
    return writeOutcome(result);
  }
  const connection = item.intent.connection;
  if (connection.provider !== "toggl")
    throw new Error("Invalid Toggl connection.");
  if (prepared.action === "stop" || prepared.action === "stop_now")
    return stopToggl(token, item, prepared);
  const start = Math.floor(Date.parse(prepared.start) / 1000);
  const end =
    prepared.end === null ? null : Math.floor(Date.parse(prepared.end) / 1000);
  if (end !== null && end <= start)
    return { status: "terminal", code: "invalid_time" };
  const body = {
    created_with: "book-tracker",
    description: prepared.description,
    project_id: connection.projectId,
    workspace_id: connection.workspaceId,
    start: new Date(start * 1000).toISOString(),
    duration: end === null ? -start : end - start,
    ...(end === null ? {} : { stop: new Date(end * 1000).toISOString() }),
  };
  const reply = await togglFetch(
    token,
    "POST",
    `/workspaces/${connection.workspaceId}/time_entries`,
    body,
  );
  if (!reply.ok) {
    if (reply.status === 401 || reply.status === 403)
      return { status: "paused", code: "unauthorized" };
    if (reply.status === 429)
      return {
        status: "pending",
        code: "rate_limited",
        retryAt: Date.now() + 60000,
      };
    if (reply.status >= 500)
      return {
        status: "outcome-unknown",
        code: "provider_unavailable",
        retryAt: Date.now() + 60000,
      };
    return { status: "terminal", code: `provider_${reply.status}` };
  }
  const value: unknown = await reply.json();
  if (prepared.action === "start") {
    const entry = decodeStartedTogglEntry(value);
    return {
      status: "synced",
      code: null,
      remote: { provider: "toggl", entryId: entry.id },
      start: new Date(entry.start).toISOString(),
    };
  }
  return {
    status: "synced",
    code: null,
    remote: {
      provider: "toggl",
      entryId: decodeCreatedTogglEntryId(value),
    },
    interval: {
      start: new Date(start * 1000).toISOString(),
      end: new Date((end ?? start) * 1000).toISOString(),
    },
  };
}

// `inline` carries a row claimed by the transaction that created it, so its
// request has never crossed the remote boundary and is already persisted.
export async function processTimerQueue(
  uid: string,
  operationId: string,
  inline?: { item: QueueV2; token: string | null },
): Promise<void> {
  const p = paths(uid),
    ref = p.queues.doc(operationId),
    timing = phaseTimer("timetracking.queue_timing");
  const item =
    inline?.item ??
    (await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.get("resolution")) return null;
      const row = decodeQueueV2(snap.data());
      if (
        row.successorId ||
        row.status === "synced" ||
        row.status === "terminal" ||
        row.status === "outcome-unknown" ||
        row.status === "paused"
      )
        return null;
      if (
        row.status === "processing" &&
        row.claimedAt !== null &&
        row.claimedAt > Date.now() - LEASE_MS
      )
        return null;
      if (row.retryAt !== null && row.retryAt > Date.now()) return null;
      await assertCurrentConnection(tx, uid, row.intent.connection);
      const [quota, rows] = await Promise.all([
        tx.get(p.quota),
        tx.get(p.rows),
      ]);
      const { next, claimed } = claimRow(
        tx,
        uid,
        row,
        quota.data(),
        rows.data(),
      );
      tx.set(ref, next);
      return claimed ? next : null;
    }));
  timing.mark("claim");
  if (item === null) {
    timing.log({ operationId, status: "skipped" });
    return;
  }
  const token = inline
    ? inline.token
    : await timerCredential(uid, item.intent.connection);
  timing.mark("credential");
  let outcome: Outcome;
  if (token === null)
    outcome = { status: "paused", code: "credential_missing" };
  else {
    const prepared = await prepare(item, token);
    timing.mark("prepare");
    if (!("provider" in prepared)) outcome = prepared;
    else {
      const ambiguous =
        prepared.provider === "toggl" &&
        (prepared.action === "start" || prepared.action === "create_interval");
      // An inline row was claimed and its request persisted by the
      // transaction that created it, so only an ambiguous Toggl POST still
      // needs its outcome-unknown marker before the request.
      const allowed =
        (inline !== undefined && item.prepared !== null && !ambiguous) ||
        (await db.runTransaction(async (tx) => {
          const current = await tx.get(ref);
          await assertCurrentConnection(tx, uid, item.intent.connection);
          if (
            current.get("claimedAt") !== item.claimedAt ||
            current.get("attempts") !== item.attempts ||
            current.get("status") !== "processing" ||
            current.get("resolution")
          )
            return false;
          // Persist the canonical request before crossing the remote boundary.
          // A Toggl POST is ambiguous until its successful response is saved.
          tx.update(ref, {
            prepared,
            ...(ambiguous
              ? { status: "outcome-unknown", errorCode: "delivery_unconfirmed" }
              : {}),
          });
          return true;
        }));
      timing.mark("persist");
      if (!allowed) {
        timing.log({ operationId, status: "lease_lost" });
        return;
      }
      try {
        outcome = await send(token, item, prepared, inline !== undefined);
      } catch (error) {
        // Transport and response-validation failures leave delivery unconfirmed.
        // This includes mismatched provider receipts; database transactions and
        // invariants outside send() still propagate without being reclassified.
        if (!(error instanceof Error)) throw error;
        outcome = {
          status: ambiguous ? "outcome-unknown" : "pending",
          code: "delivery_unconfirmed",
          retryAt: Date.now() + 30000,
        };
      }
      timing.mark("remote");
    }
  }
  const bookRef = db.doc(`users/${uid}/books/${item.intent.bookId}`);
  const recorded = await db.runTransaction(async (tx) => {
    const [current, user, book, claim] = await Promise.all([
      tx.get(ref),
      tx.get(p.user),
      tx.get(bookRef),
      tx.get(p.claim),
    ]);
    assertLiveAccount(user.exists, user.get("deletedAt"));
    if (
      current.get("claimedAt") !== item.claimedAt ||
      current.get("attempts") !== item.attempts ||
      current.get("resolution")
    )
      return;
    const raw: unknown = book.get("activeTimer");
    const timer =
      wireRecord(raw) && raw.version === 2 ? decodeTimerV2(raw) : null;
    const matching =
      timer !== null &&
      timer.timerId === item.intent.timerId &&
      timer.queueId === operationId;
    if (matching) {
      const currentClaim = decodeClaimV2(claim.data());
      if (
        currentClaim.state !== "active" ||
        currentClaim.bookId !== book.id ||
        JSON.stringify(currentClaim.timer) !== JSON.stringify(timer)
      )
        throw new Error("Timer and lifecycle diverged.");
      if (outcome.status === "synced") {
        if (item.intent.action === "start" && !outcome.interval) {
          if (!outcome.remote || !outcome.start)
            throw new Error("Remote start response is incomplete.");
          const remote: TimerV2 = {
            ...timer,
            state: "remote",
            remote: outcome.remote,
            start: outcome.start,
            queueId: null,
            errorCode: null,
          };
          tx.update(bookRef, { activeTimer: remote });
          tx.set(p.claim, claimV2(book.id, remote));
        } else {
          tx.update(bookRef, { activeTimer: null });
          tx.set(p.claim, idleV2(book.id, timer));
        }
      } else if (
        item.intent.action === "start" &&
        outcome.status === "terminal"
      ) {
        tx.update(bookRef, { activeTimer: null });
        tx.set(p.claim, idleV2(book.id, timer));
      } else {
        const stalled: TimerV2 = {
          ...timer,
          errorCode: outcome.code,
          ...(outcome.status === "outcome-unknown"
            ? { state: "outcome-unknown" as const }
            : {}),
        };
        tx.update(bookRef, { activeTimer: stalled });
        tx.set(p.claim, claimV2(book.id, stalled));
      }
    }
    tx.update(ref, {
      status: outcome.status,
      errorCode: outcome.code,
      retryAt: outcome.retryAt ?? null,
    });
    if (outcome.response || outcome.interval)
      tx.set(
        p.results.doc(operationId),
        {
          ...(outcome.response ? { response: outcome.response } : {}),
          ...(outcome.interval ? { interval: outcome.interval } : {}),
          ...(outcome.observation ? { observation: outcome.observation } : {}),
          ...(item.intent.action === "start" &&
          outcome.status === "synced" &&
          outcome.interval
            ? {
                readingPending: true,
                bookId: item.intent.bookId,
                description: item.intent.description,
              }
            : {}),
          recordedAt: Date.now(),
        },
        { merge: true },
      );
    return true;
  });
  timing.mark("record");
  timing.log({
    operationId,
    action: item.intent.action,
    provider: item.intent.connection.provider,
    status: outcome.status,
  });
  if (
    recorded &&
    ["terminal", "paused", "outcome-unknown"].includes(outcome.status)
  ) {
    const failed = { ...item, status: outcome.status, errorCode: outcome.code };
    logger.warn(
      "time_tracking.operation_failed",
      projectedQueueFailure(failed),
    );
    await logIssue({ ...timerFailureIssue(failed), uid });
  }
}

export function projectedQueueFailure(item: QueueV2): {
  provider: string;
  operationId: string;
  errorCode: string | null;
  attempts: number;
  entryKeys: string[];
} {
  return {
    provider: item.intent.connection.provider,
    operationId: item.intent.operationId,
    errorCode:
      item.errorCode !== null && /^[a-z0-9_]{1,64}$/.test(item.errorCode)
        ? item.errorCode
        : null,
    attempts: item.attempts,
    entryKeys:
      item.intent.remote?.provider === "threeggle"
        ? [item.intent.remote.entryKey]
        : [],
  };
}
export function conflictEntries(
  response: TimeTrackingFailure,
): TimeTrackingEntry[] {
  return response.error.details && "entries" in response.error.details
    ? response.error.details.entries
    : [];
}

export function timerFailureIssue(item: QueueV2) {
  const safe = projectedQueueFailure(item);
  return {
    level: "warn" as const,
    event: "time_tracking.operation_failed",
    code: safe.errorCode ?? "unknown",
    message: JSON.stringify(safe),
  };
}
