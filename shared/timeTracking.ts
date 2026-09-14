import {
  decodeTimeTrackingRequest,
  isOperationId,
  wireRecord,
  wireTime,
} from "./time-tracking-api.ts";
import type { TimeTrackingWrite } from "./time-tracking-api.ts";

export type Provider = "none" | "toggl" | "threeggle";
export type Connection =
  | { provider: "none"; revision: string }
  | {
      provider: "toggl";
      revision: string;
      accountId: string;
      workspaceId: number;
      projectId: number;
    }
  | {
      provider: "threeggle";
      revision: string;
      serviceId: string;
      accountId: string;
      projectId: string;
    };
export type RemoteReference =
  | { provider: "toggl"; entryId: number }
  | { provider: "threeggle"; entryKey: string };
export type TimerV2 = {
  version: 2;
  timerId: string;
  operationId: string;
  connection: Connection;
  state: "local" | "starting" | "remote" | "stopping" | "outcome-unknown";
  start: string;
  claimedAt: number;
  remote: RemoteReference | null;
  queueId: string | null;
  errorCode: string | null;
};
export type ClaimV2 =
  | {
      version: 2;
      state: "idle";
      cleared: { bookId: string; timerId: string; operationId: string } | null;
    }
  | { version: 2; state: "active"; bookId: string; timer: TimerV2 };
export type TimerIntent = {
  version: 2;
  operationId: string;
  timerId: string;
  bookId: string;
  connection: Connection;
  action: "start" | "stop" | "clear";
  start: string;
  end: string | null;
  description: string;
  remote: RemoteReference | null;
};
export type PreparedRequest =
  | { provider: "threeggle"; request: TimeTrackingWrite }
  | {
      provider: "toggl";
      action: "start" | "stop" | "create_interval";
      start: string;
      end: string | null;
      description: string;
      entryId: number | null;
    };
export type QueueV2 = {
  version: 2;
  intent: TimerIntent;
  status:
    | "pending"
    | "processing"
    | "paused"
    | "terminal"
    | "synced"
    | "outcome-unknown";
  createdAt: number;
  attempts: number;
  claimedAt: number | null;
  retryAt: number | null;
  prepared: PreparedRequest | null;
  errorCode: string | null;
  successorId: string | null;
  resolution: "remote_outcome_checked" | null;
  rowCounted: boolean;
};
export type OperationAck = {
  version: 2;
  operationId: string;
  timerId: string;
  bookId: string;
  action: TimerIntent["action"];
  acceptedAt: number;
};
export type TimerControls = {
  threeggleEnabled: boolean;
  timerWriteVersion: 1 | 2;
};

function fail(label: string): never {
  throw new TypeError(`Invalid ${label}.`);
}
function record(
  value: unknown,
  names: string[],
  label: string,
): Record<string, unknown> {
  if (
    !wireRecord(value) ||
    Object.keys(value).length !== names.length ||
    names.some((name) => !Object.hasOwn(value, name))
  )
    fail(label);
  return value;
}
function text(value: unknown, label: string, max = 500): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    value.includes("\u0000")
  )
    fail(label);
  return value;
}
function id(value: unknown): string {
  if (!isOperationId(value)) fail("operation id");
  return value;
}
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    fail("integer");
  return value;
}
function millis(value: unknown): number {
  if (!wireTime(value)) fail("timestamp");
  return value;
}
function iso(value: unknown): string {
  const result = text(value, "ISO timestamp", 40);
  if (
    !Number.isFinite(Date.parse(result)) ||
    new Date(result).toISOString() !== result
  )
    fail("ISO timestamp");
  return result;
}
export function decodeConnection(value: unknown): Connection {
  if (!wireRecord(value)) fail("connection");
  const revision = text(value.revision, "connection revision", 100);
  if (value.provider === "none") {
    record(value, ["provider", "revision"], "connection");
    return { provider: "none", revision };
  }
  if (value.provider === "toggl") {
    record(
      value,
      ["provider", "revision", "accountId", "workspaceId", "projectId"],
      "connection",
    );
    return {
      provider: "toggl",
      revision,
      accountId: text(value.accountId, "account id"),
      workspaceId: positive(value.workspaceId),
      projectId: positive(value.projectId),
    };
  }
  if (value.provider === "threeggle") {
    record(
      value,
      ["provider", "revision", "serviceId", "accountId", "projectId"],
      "connection",
    );
    return {
      provider: "threeggle",
      revision,
      serviceId: text(value.serviceId, "service id"),
      accountId: text(value.accountId, "account id"),
      projectId: text(value.projectId, "project id"),
    };
  }
  return fail("provider");
}
export function effectiveConnection(user: unknown): Connection {
  if (!wireRecord(user)) fail("user");
  if (user.timeTracking !== undefined)
    return decodeConnection(user.timeTracking);
  if (wireRecord(user.toggl))
    return {
      provider: "toggl",
      revision: "legacy",
      accountId: "legacy",
      workspaceId: positive(user.toggl.workspaceId),
      projectId: positive(user.toggl.projectId),
    };
  return { provider: "none", revision: "legacy" };
}
export function decodeRemote(value: unknown): RemoteReference | null {
  if (value === null) return null;
  if (!wireRecord(value)) fail("remote reference");
  if (value.provider === "toggl") {
    record(value, ["provider", "entryId"], "remote reference");
    return { provider: "toggl", entryId: positive(value.entryId) };
  }
  if (value.provider === "threeggle") {
    record(value, ["provider", "entryKey"], "remote reference");
    return {
      provider: "threeggle",
      entryKey: text(value.entryKey, "entry key"),
    };
  }
  return fail("remote reference");
}
export function decodeTimerV2(value: unknown): TimerV2 {
  const d = record(
    value,
    [
      "version",
      "timerId",
      "operationId",
      "connection",
      "state",
      "start",
      "claimedAt",
      "remote",
      "queueId",
      "errorCode",
    ],
    "v2 timer",
  );
  if (
    d.version !== 2 ||
    (d.state !== "local" &&
      d.state !== "remote" &&
      d.state !== "starting" &&
      d.state !== "stopping" &&
      d.state !== "outcome-unknown")
  )
    fail("v2 timer");
  const connection = decodeConnection(d.connection),
    remote = decodeRemote(d.remote);
  if (remote !== null && remote.provider !== connection.provider)
    fail("timer provider");
  if ((d.state === "remote" || d.state === "stopping") && remote === null)
    fail("remote timer");
  if (d.state === "local" && remote !== null) fail("local timer");
  const queueId = d.queueId === null ? null : id(d.queueId);
  if (d.state === "stopping" && queueId === null) fail("stopping timer");
  return {
    version: 2,
    timerId: id(d.timerId),
    operationId: id(d.operationId),
    connection,
    state: d.state,
    start: iso(d.start),
    claimedAt: millis(d.claimedAt),
    remote,
    queueId,
    errorCode:
      d.errorCode === null ? null : text(d.errorCode, "error code", 100),
  };
}
export function decodeClaimV2(value: unknown): ClaimV2 {
  if (!wireRecord(value) || value.version !== 2) fail("v2 claim");
  if (value.state === "idle") {
    record(value, ["version", "state", "cleared"], "v2 idle claim");
    if (value.cleared === null)
      return { version: 2, state: "idle", cleared: null };
    const c = record(
      value.cleared,
      ["bookId", "timerId", "operationId"],
      "cleared timer",
    );
    return {
      version: 2,
      state: "idle",
      cleared: {
        bookId: text(c.bookId, "book id"),
        timerId: id(c.timerId),
        operationId: id(c.operationId),
      },
    };
  }
  record(value, ["version", "state", "bookId", "timer"], "v2 active claim");
  if (value.state !== "active") fail("v2 claim state");
  return {
    version: 2,
    state: "active",
    bookId: text(value.bookId, "book id"),
    timer: decodeTimerV2(value.timer),
  };
}
export function claimV2(bookId: string, timer: TimerV2): ClaimV2 {
  return { version: 2, state: "active", bookId, timer };
}
export function idleV2(bookId: string, timer: TimerV2): ClaimV2 {
  return {
    version: 2,
    state: "idle",
    cleared: { bookId, timerId: timer.timerId, operationId: timer.operationId },
  };
}
export function decodeTimerIntent(value: unknown): TimerIntent {
  const d = record(
    value,
    [
      "version",
      "operationId",
      "timerId",
      "bookId",
      "connection",
      "action",
      "start",
      "end",
      "description",
      "remote",
    ],
    "timer intent",
  );
  if (
    d.version !== 2 ||
    (d.action !== "start" && d.action !== "stop" && d.action !== "clear")
  )
    fail("timer intent action");
  const connection = decodeConnection(d.connection),
    remote = decodeRemote(d.remote);
  if (remote !== null && remote.provider !== connection.provider)
    fail("intent provider");
  const start = iso(d.start),
    end = d.end === null ? null : iso(d.end);
  if (d.action === "stop" && end === null) fail("stop interval");
  if (d.action === "start" && end !== null) fail("start end");
  return {
    version: 2,
    operationId: id(d.operationId),
    timerId: id(d.timerId),
    bookId: text(d.bookId, "book id"),
    connection,
    action: d.action,
    start,
    end,
    description: text(d.description, "description", 2000),
    remote,
  };
}
export function decodePrepared(value: unknown): PreparedRequest | null {
  if (value === null) return null;
  if (!wireRecord(value)) fail("prepared request");
  if (value.provider === "threeggle") {
    record(value, ["provider", "request"], "prepared request");
    const request = decodeTimeTrackingRequest(value.request);
    if (
      !request ||
      (request.action !== "start" &&
        request.action !== "stop" &&
        request.action !== "create_interval")
    )
      fail("prepared write");
    return { provider: "threeggle", request };
  }
  record(
    value,
    ["provider", "action", "start", "end", "description", "entryId"],
    "prepared request",
  );
  if (
    value.provider !== "toggl" ||
    (value.action !== "start" &&
      value.action !== "stop" &&
      value.action !== "create_interval")
  )
    fail("prepared Toggl request");
  return {
    provider: "toggl",
    action: value.action,
    start: iso(value.start),
    end: value.end === null ? null : iso(value.end),
    description: text(value.description, "description", 2000),
    entryId: value.entryId === null ? null : positive(value.entryId),
  };
}
export function decodeQueueV2(value: unknown): QueueV2 {
  const d = record(
    value,
    [
      "version",
      "intent",
      "status",
      "createdAt",
      "attempts",
      "claimedAt",
      "retryAt",
      "prepared",
      "errorCode",
      "successorId",
      "resolution",
      "rowCounted",
    ],
    "v2 queue",
  );
  if (
    d.version !== 2 ||
    (d.status !== "pending" &&
      d.status !== "processing" &&
      d.status !== "paused" &&
      d.status !== "terminal" &&
      d.status !== "synced" &&
      d.status !== "outcome-unknown")
  )
    fail("queue status");
  if (typeof d.rowCounted !== "boolean") fail("queue row count marker");
  if (d.resolution !== null && d.resolution !== "remote_outcome_checked")
    fail("queue resolution");
  if (
    typeof d.attempts !== "number" ||
    !Number.isSafeInteger(d.attempts) ||
    d.attempts < 0
  )
    fail("attempts");
  return {
    version: 2,
    intent: decodeTimerIntent(d.intent),
    status: d.status,
    createdAt: millis(d.createdAt),
    attempts: d.attempts,
    claimedAt: d.claimedAt === null ? null : millis(d.claimedAt),
    retryAt: d.retryAt === null ? null : millis(d.retryAt),
    prepared: decodePrepared(d.prepared),
    errorCode:
      d.errorCode === null ? null : text(d.errorCode, "error code", 100),
    successorId: d.successorId === null ? null : id(d.successorId),
    resolution: d.resolution,
    rowCounted: d.rowCounted,
  };
}
export function initialQueue(intent: TimerIntent, now: number): QueueV2 {
  return {
    version: 2,
    intent,
    status: "pending",
    createdAt: now,
    attempts: 0,
    claimedAt: null,
    retryAt: null,
    prepared: null,
    errorCode: null,
    successorId: null,
    resolution: null,
    rowCounted: false,
  };
}
export function operationAck(intent: TimerIntent, now: number): OperationAck {
  return {
    version: 2,
    operationId: intent.operationId,
    timerId: intent.timerId,
    bookId: intent.bookId,
    action: intent.action,
    acceptedAt: now,
  };
}
export function decodeTimerControls(value: unknown): TimerControls {
  if (value === undefined)
    return { threeggleEnabled: false, timerWriteVersion: 1 };
  const d = record(
    value,
    ["threeggleEnabled", "timerWriteVersion"],
    "timer controls",
  );
  if (
    typeof d.threeggleEnabled !== "boolean" ||
    (d.timerWriteVersion !== 1 && d.timerWriteVersion !== 2)
  )
    fail("timer controls");
  return {
    threeggleEnabled: d.threeggleEnabled,
    timerWriteVersion: d.timerWriteVersion,
  };
}
export function sameConnection(a: Connection, b: Connection): boolean {
  return (
    JSON.stringify(decodeConnection(a)) === JSON.stringify(decodeConnection(b))
  );
}
