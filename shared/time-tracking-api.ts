/** Version 1 wire contract. Keep this file identical in both repositories. */
export const TIME_TRACKING_ACTIONS = [
  "context",
  "projects",
  "start",
  "stop",
  "create_interval",
  "entry",
  "operation",
] as const;
export const MAX_INTERVAL_DURATION_MS = 31 * 24 * 60 * 60 * 1000;
export const MAX_OVERLAP_READ_DOCUMENTS = 256;
export const MAX_TIME_TRACKING_REQUEST_BYTES = 16384;
export type TimeTrackingEntry = {
  key: string;
  version: string;
  description: string;
  projectId: string | null;
  startTime: number;
  endTime: number | null;
};
type Base = { client: "book-tracker" };
export type TimeTrackingRequest = Base &
  (
    | { action: "context" | "projects" }
    | { action: "entry"; entryKey: string }
    | { action: "operation"; requestId: string }
    | {
        action: "start";
        requestId: string;
        description: string;
        projectId: string;
        startTime: number;
        expectedRunning: { key: string; version: string } | null;
      }
    | { action: "stop"; requestId: string; entryKey: string; endTime: number }
    | {
        action: "create_interval";
        requestId: string;
        description: string;
        projectId: string;
        startTime: number;
        endTime: number;
      }
  );
export type TimeTrackingWrite = Extract<
  TimeTrackingRequest,
  { action: "start" | "stop" | "create_interval" }
>;
export type TimeTrackingErrorCode =
  | "invalid_request"
  | "invalid_time"
  | "unauthorized"
  | "forbidden"
  | "entry_not_found"
  | "operation_not_found"
  | "project_not_found"
  | "running_changed"
  | "interval_overlap"
  | "project_unavailable"
  | "request_id_reused"
  | "interval_too_long"
  | "overlap_check_limit"
  | "rate_limited"
  | "index_not_ready"
  | "clock_ahead";
export type TimeTrackingErrorDetails =
  | { entries: TimeTrackingEntry[]; hasMore: boolean }
  | { current: TimeTrackingEntry | null }
  | {
      entry: TimeTrackingEntry | null;
      reason:
        | "project_archived"
        | "project_deleted"
        | "project_missing"
        | "end_before_start";
    }
  | { maxDurationMs: number }
  | { maxReadDocuments: number }
  | { serverTime: number; retryAt: number };
export type TimeTrackingFailure = {
  apiVersion: 1;
  ok: false;
  requestId?: string;
  error: {
    code: TimeTrackingErrorCode;
    message: string;
    details?: TimeTrackingErrorDetails;
  };
};
export type TimeTrackingWriteResult = {
  disposition: "started" | "created" | "stopped" | "already_stopped";
  entry: TimeTrackingEntry;
  previousEntry?: TimeTrackingEntry | null;
};
export type TimeTrackingSuccess<T> = {
  apiVersion: 1;
  ok: true;
  requestId?: string;
  result: T;
};
export type TimeTrackingWriteResponse =
  TimeTrackingSuccess<TimeTrackingWriteResult> | TimeTrackingFailure;
export type TimeTrackingContext = {
  serviceId: string;
  accountId: string;
  actions: (typeof TIME_TRACKING_ACTIONS)[number][];
  serverTime: number;
  current: TimeTrackingEntry | null;
  readiness: "ready" | "building" | "missing";
  limits: { maxIntervalDurationMs: number; maxOverlapReadDocuments: number };
};
export type TimeTrackingResult =
  | TimeTrackingContext
  | { projects: { id: string; name: string }[] }
  | { entry: TimeTrackingEntry }
  | TimeTrackingWriteResult
  | { status: number; response: TimeTrackingWriteResponse };
export type TimeTrackingResponse =
  TimeTrackingSuccess<TimeTrackingResult> | TimeTrackingFailure;
export type TimeTrackingHttpResult = {
  status: number;
  response: TimeTrackingResponse;
  retryAfter?: number;
};
export function wireRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isOperationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
export function wireTime(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Math.abs(value) <= 8640000000000000
  );
}
const key = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
const fields = (value: Record<string, unknown>, names: string[]) =>
  Object.keys(value).every((name) => names.includes(name)) &&
  names.every((name) => Object.hasOwn(value, name));
/** Strict external request boundary; malformed input never reaches a mutation. */
export function decodeTimeTrackingRequest(
  value: unknown,
): TimeTrackingRequest | null {
  if (!wireRecord(value) || value.client !== "book-tracker") return null;
  const common = ["client", "action"];
  if (
    (value.action === "context" || value.action === "projects") &&
    fields(value, common)
  )
    return { client: value.client, action: value.action };
  if (
    value.action === "entry" &&
    fields(value, [...common, "entryKey"]) &&
    key(value.entryKey)
  )
    return {
      client: value.client,
      action: value.action,
      entryKey: value.entryKey,
    };
  if (!isOperationId(value.requestId)) return null;
  const base = { client: value.client, requestId: value.requestId } as const;
  if (value.action === "operation" && fields(value, [...common, "requestId"]))
    return { ...base, action: value.action };
  if (
    value.action === "stop" &&
    fields(value, [...common, "requestId", "entryKey", "endTime"]) &&
    key(value.entryKey) &&
    wireTime(value.endTime)
  )
    return {
      ...base,
      action: value.action,
      entryKey: value.entryKey,
      endTime: value.endTime,
    };
  if (
    typeof value.description !== "string" ||
    value.description.length > 2000 ||
    !value.description.trim() ||
    !key(value.projectId) ||
    !wireTime(value.startTime)
  )
    return null;
  const create = {
    ...base,
    description: value.description,
    projectId: value.projectId,
    startTime: value.startTime,
  };
  const createFields = [
    ...common,
    "requestId",
    "description",
    "projectId",
    "startTime",
  ];
  if (
    value.action === "create_interval" &&
    fields(value, [...createFields, "endTime"]) &&
    wireTime(value.endTime)
  )
    return { ...create, action: value.action, endTime: value.endTime };
  if (
    value.action === "start" &&
    fields(value, [...createFields, "expectedRunning"])
  ) {
    const expected = value.expectedRunning;
    if (expected === null)
      return { ...create, action: value.action, expectedRunning: null };
    if (
      wireRecord(expected) &&
      fields(expected, ["key", "version"]) &&
      key(expected.key) &&
      key(expected.version)
    )
      return {
        ...create,
        action: value.action,
        expectedRunning: { key: expected.key, version: expected.version },
      };
  }
  return null;
}
export function isTimeTrackingWrite(
  request: TimeTrackingRequest,
): request is TimeTrackingWrite {
  return (
    request.action === "start" ||
    request.action === "stop" ||
    request.action === "create_interval"
  );
}
/** Decoder establishes field order, so JSON is a stable fingerprint for retries. */
export function timeTrackingFingerprint(request: TimeTrackingWrite): string {
  const normalized = decodeTimeTrackingRequest(request);
  if (!normalized || !isTimeTrackingWrite(normalized))
    throw new Error("Invalid timer request fingerprint.");
  return JSON.stringify(normalized);
}

export const TIME_TRACKING_ERROR_CODES = [
  "invalid_request",
  "invalid_time",
  "unauthorized",
  "forbidden",
  "entry_not_found",
  "operation_not_found",
  "project_not_found",
  "running_changed",
  "interval_overlap",
  "project_unavailable",
  "request_id_reused",
  "interval_too_long",
  "overlap_check_limit",
  "rate_limited",
  "index_not_ready",
  "clock_ahead",
] as const;
const protocolError = (): never => {
  throw new Error("Invalid time-tracking response.");
};
const wireString = (value: unknown): string =>
  typeof value === "string" ? value : protocolError();
const responseRecord = (value: unknown): Record<string, unknown> =>
  wireRecord(value) ? value : protocolError();
function responseEntry(value: unknown): TimeTrackingEntry {
  const e = responseRecord(value);
  if (
    !fields(e, [
      "key",
      "version",
      "description",
      "projectId",
      "startTime",
      "endTime",
    ]) ||
    !key(e.key) ||
    !key(e.version) ||
    typeof e.description !== "string" ||
    (e.projectId !== null && !key(e.projectId)) ||
    !wireTime(e.startTime) ||
    (e.endTime !== null && !wireTime(e.endTime))
  )
    return protocolError();
  return {
    key: e.key,
    version: e.version,
    description: e.description,
    projectId: e.projectId,
    startTime: e.startTime,
    endTime: e.endTime,
  };
}
function responseDetails(
  code: TimeTrackingErrorCode,
  value: unknown,
): TimeTrackingErrorDetails | undefined {
  if (value === undefined) {
    if (
      [
        "interval_overlap",
        "running_changed",
        "project_unavailable",
        "interval_too_long",
        "overlap_check_limit",
        "clock_ahead",
      ].includes(code)
    )
      return protocolError();
    return undefined;
  }
  const d = responseRecord(value);
  if (
    code === "interval_overlap" &&
    fields(d, ["entries", "hasMore"]) &&
    Array.isArray(d.entries) &&
    d.entries.length <= 5 &&
    typeof d.hasMore === "boolean"
  )
    return { entries: d.entries.map(responseEntry), hasMore: d.hasMore };
  if (code === "running_changed" && fields(d, ["current"]))
    return { current: d.current === null ? null : responseEntry(d.current) };
  if (
    (code === "project_unavailable" || code === "invalid_time") &&
    fields(d, ["entry", "reason"])
  ) {
    const reason = d.reason;
    if (
      reason !== "project_archived" &&
      reason !== "project_deleted" &&
      reason !== "project_missing" &&
      reason !== "end_before_start"
    )
      return protocolError();
    return { entry: d.entry === null ? null : responseEntry(d.entry), reason };
  }
  if (
    code === "interval_too_long" &&
    fields(d, ["maxDurationMs"]) &&
    wireTime(d.maxDurationMs) &&
    d.maxDurationMs > 0
  )
    return { maxDurationMs: d.maxDurationMs };
  if (
    code === "overlap_check_limit" &&
    fields(d, ["maxReadDocuments"]) &&
    wireTime(d.maxReadDocuments) &&
    d.maxReadDocuments > 0
  )
    return { maxReadDocuments: d.maxReadDocuments };
  if (
    code === "clock_ahead" &&
    fields(d, ["serverTime", "retryAt"]) &&
    wireTime(d.serverTime) &&
    wireTime(d.retryAt)
  )
    return { serverTime: d.serverTime, retryAt: d.retryAt };
  return protocolError();
}
function writeResult(value: Record<string, unknown>): TimeTrackingWriteResult {
  const disposition = value.disposition;
  if (
    disposition !== "started" &&
    disposition !== "created" &&
    disposition !== "stopped" &&
    disposition !== "already_stopped"
  )
    return protocolError();
  if (
    !fields(
      value,
      disposition === "started"
        ? ["disposition", "entry", "previousEntry"]
        : ["disposition", "entry"],
    )
  )
    return protocolError();
  return {
    disposition,
    entry: responseEntry(value.entry),
    ...(disposition === "started"
      ? {
          previousEntry:
            value.previousEntry === null
              ? null
              : responseEntry(value.previousEntry),
        }
      : {}),
  };
}
/** Strict provider response boundary, also used to validate shared fixtures. */
export function decodeTimeTrackingResponse(
  value: unknown,
): TimeTrackingResponse {
  const data = responseRecord(value);
  if (
    data.apiVersion !== 1 ||
    typeof data.ok !== "boolean" ||
    (data.requestId !== undefined && !isOperationId(data.requestId))
  )
    return protocolError();
  const base = {
    apiVersion: 1,
    ...(typeof data.requestId === "string"
      ? { requestId: data.requestId }
      : {}),
  } as const;
  if (
    !fields(data, [
      "apiVersion",
      "ok",
      data.ok ? "result" : "error",
      ...(data.requestId === undefined ? [] : ["requestId"]),
    ])
  )
    return protocolError();
  if (!data.ok) {
    const error = responseRecord(data.error);
    if (
      !fields(error, [
        "code",
        "message",
        ...(error.details === undefined ? [] : ["details"]),
      ])
    )
      return protocolError();
    const code = TIME_TRACKING_ERROR_CODES.find((c) => c === error.code);
    if (!code) return protocolError();
    const details = responseDetails(code, error.details);
    return {
      ...base,
      ok: false,
      error: {
        code,
        message: wireString(error.message),
        ...(details ? { details } : {}),
      },
    };
  }
  const r = responseRecord(data.result);
  let result: TimeTrackingResult;
  if ("disposition" in r) result = writeResult(r);
  else if (fields(r, ["entry"])) result = { entry: responseEntry(r.entry) };
  else if (
    fields(r, ["status", "response"]) &&
    typeof r.status === "number" &&
    Number.isInteger(r.status) &&
    r.status >= 200 &&
    r.status < 500
  ) {
    const receipt = decodeTimeTrackingResponse(r.response);
    if (receipt.ok && !("disposition" in receipt.result))
      return protocolError();
    result = {
      status: r.status,
      response: receipt.ok
        ? { ...receipt, result: writeResult(responseRecord(receipt.result)) }
        : receipt,
    };
  } else if (fields(r, ["projects"]) && Array.isArray(r.projects))
    result = {
      projects: r.projects.map((value) => {
        const project = responseRecord(value);
        if (!fields(project, ["id", "name"]) || !key(project.id))
          return protocolError();
        return { id: project.id, name: wireString(project.name) };
      }),
    };
  else {
    if (
      !fields(r, [
        "serviceId",
        "accountId",
        "actions",
        "serverTime",
        "current",
        "readiness",
        "limits",
      ]) ||
      !Array.isArray(r.actions) ||
      !r.actions.every((a) =>
        TIME_TRACKING_ACTIONS.some((action) => action === a),
      ) ||
      !wireTime(r.serverTime) ||
      (r.readiness !== "ready" &&
        r.readiness !== "building" &&
        r.readiness !== "missing")
    )
      return protocolError();
    const limits = responseRecord(r.limits);
    if (
      !fields(limits, ["maxIntervalDurationMs", "maxOverlapReadDocuments"]) ||
      !wireTime(limits.maxIntervalDurationMs) ||
      limits.maxIntervalDurationMs <= 0 ||
      !wireTime(limits.maxOverlapReadDocuments) ||
      limits.maxOverlapReadDocuments <= 0
    )
      return protocolError();
    result = {
      serviceId: wireString(r.serviceId),
      accountId: wireString(r.accountId),
      actions: TIME_TRACKING_ACTIONS.filter((a) =>
        (r.actions as unknown[]).includes(a),
      ),
      serverTime: r.serverTime,
      current: r.current === null ? null : responseEntry(r.current),
      readiness: r.readiness,
      limits: {
        maxIntervalDurationMs: limits.maxIntervalDurationMs,
        maxOverlapReadDocuments: limits.maxOverlapReadDocuments,
      },
    };
  }
  return { ...base, ok: true, result };
}
