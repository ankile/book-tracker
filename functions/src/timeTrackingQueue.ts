import { logger } from "firebase-functions";
import { logIssue } from "./logging";
import { wireRecord } from "./shared/time-tracking-api";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
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
  };
}
export async function acceptTimerIntent(
  uid: string,
  submitted: TimerIntent,
  expectedRunning: { key: string; version: string } | null,
): Promise<void> {
  const intent = decodeTimerIntent(submitted);
  const p = paths(uid),
    book = db.doc(`users/${uid}/books/${intent.bookId}`);
  await db.runTransaction(async (tx) => {
    const [ack, bookSnap, claimSnap, controlsSnap] = await Promise.all([
      tx.get(p.acks.doc(intent.operationId)),
      tx.get(book),
      tx.get(p.claim),
      tx.get(db.doc("configuration/timeTracking")),
    ]);
    const user = await tx.get(p.user);
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
      return;
    }
    await assertCurrentConnection(tx, uid, intent.connection);
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
    if (queue !== null) tx.create(p.queues.doc(intent.operationId), queue);
  });
}

type Outcome = {
  status: QueueV2["status"];
  code: string | null;
  retryAt?: number;
  remote?: RemoteReference;
  start?: string;
  response?: TimeTrackingWriteResponse;
  interval?: TimerInterval;
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
): Promise<Outcome> {
  if (prepared.provider === "threeggle") {
    const result = await threeggleRequest(token, prepared.request);
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

export async function processTimerQueue(
  uid: string,
  operationId: string,
): Promise<void> {
  const p = paths(uid),
    ref = p.queues.doc(operationId);
  const item = await db.runTransaction(async (tx) => {
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
    const quotaRef = db.doc(`users/${uid}/functionQuotas/timeTrackingQueue`),
      rowsRef = db.doc(`users/${uid}/functionQuotas/timeTrackingQueueRows`);
    const [quota, rows] = await Promise.all([
      tx.get(quotaRef),
      tx.get(rowsRef),
    ]);
    if (!row.rowCounted) {
      const rowQuota = applyQuota(
        tx,
        rowsRef,
        rows.data(),
        60,
        3600000,
        Timestamp.now(),
      );
      if (!rowQuota.granted) {
        tx.update(ref, {
          status: "pending",
          retryAt: Date.now() + 3600000,
          errorCode: "row_limit",
        });
        return null;
      }
    }
    const granted = applyQuota(
      tx,
      quotaRef,
      quota.data(),
      row.intent.remote !== null ? 60 : 30,
      3600000,
      Timestamp.now(),
    );
    if (!granted.granted) {
      tx.update(ref, {
        rowCounted: true,
        status: "pending",
        retryAt: Date.now() + 3600000,
        errorCode: "rate_limited",
      });
      return null;
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      tx.update(ref, {
        rowCounted: true,
        status: "paused",
        errorCode: "retry_limit",
      });
      return null;
    }
    const next: QueueV2 = {
      ...row,
      rowCounted: true,
      status: "processing",
      attempts: row.attempts + 1,
      claimedAt: Date.now(),
      retryAt: null,
      errorCode: null,
    };
    tx.set(ref, next);
    return next;
  });
  if (item === null) return;
  const token = await timerCredential(uid, item.intent.connection);
  let outcome: Outcome;
  if (token === null)
    outcome = { status: "paused", code: "credential_missing" };
  else {
    const prepared = await prepare(item, token);
    if (!("provider" in prepared)) outcome = prepared;
    else {
      const allowed = await db.runTransaction(async (tx) => {
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
          ...(prepared.provider === "toggl" &&
          (prepared.action === "start" || prepared.action === "create_interval")
            ? { status: "outcome-unknown", errorCode: "delivery_unconfirmed" }
            : {}),
        });
        return true;
      });
      if (!allowed) return;
      try {
        outcome = await send(token, item, prepared);
      } catch (error) {
        // Only external transport/response failures are ambiguous; database
        // transaction and local invariant errors must propagate.
        if (!(error instanceof Error)) throw error;
        const ambiguous =
          prepared.provider === "toggl" &&
          (prepared.action === "start" ||
            prepared.action === "create_interval");
        outcome = {
          status: ambiguous ? "outcome-unknown" : "pending",
          code: "delivery_unconfirmed",
          retryAt: Date.now() + 30000,
        };
      }
    }
  }
  const recorded = await db.runTransaction(async (tx) => {
    const current = await tx.get(ref),
      user = await tx.get(p.user);
    assertLiveAccount(user.exists, user.get("deletedAt"));
    if (
      current.get("claimedAt") !== item.claimedAt ||
      current.get("attempts") !== item.attempts ||
      current.get("resolution")
    )
      return;
    const bookRef = db.doc(`users/${uid}/books/${item.intent.bookId}`);
    const [book, claim] = await Promise.all([tx.get(bookRef), tx.get(p.claim)]);
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
        if (item.intent.action === "start") {
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
          recordedAt: Date.now(),
        },
        { merge: true },
      );
    return true;
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
