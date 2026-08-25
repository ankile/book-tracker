import {Timestamp} from "firebase-admin/firestore";
import {Buffer} from "node:buffer";

export class DataDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataDecodeError";
  }
}

const throwDecodeError = (message: string): never => {
  throw new DataDecodeError(message);
};

export type DecodeFailure = typeof throwDecodeError;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(
  value: unknown,
  label: string,
  fail: DecodeFailure,
): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object.`);
  return value;
}

function string(
  value: unknown,
  label: string,
  fail: DecodeFailure,
  maximumLength: number,
): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string.`);
  }
  if (value.length > maximumLength) {
    fail(`${label} must be at most ${maximumLength} characters.`);
  }
  return value;
}

function finiteNumber(
  value: unknown,
  label: string,
  fail: DecodeFailure,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${label} must be a finite number.`);
  }
  return value;
}

function positiveInteger(
  value: unknown,
  label: string,
  fail: DecodeFailure,
): number {
  const decoded = finiteNumber(value, label, fail);
  if (!Number.isInteger(decoded) || decoded <= 0) {
    fail(`${label} must be a positive integer.`);
  }
  return decoded;
}

function nonNegativeInteger(
  value: unknown,
  label: string,
  fail: DecodeFailure,
): number {
  const decoded = finiteNumber(value, label, fail);
  if (!Number.isInteger(decoded) || decoded < 0) {
    fail(`${label} must be a non-negative integer.`);
  }
  return decoded;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  fail: DecodeFailure,
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    fail(`${label} contains unexpected field "${unexpected[0]}".`);
  }
}

function isoTimestamp(
  value: unknown,
  label: string,
  fail: DecodeFailure,
): string {
  const decoded = string(value, label, fail, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
    .test(decoded) || !Number.isFinite(Date.parse(decoded))) {
    fail(`${label} must be an ISO-8601 timestamp.`);
  }
  return decoded;
}

function firestoreTimestamp(
  value: unknown,
  label: string,
  fail: DecodeFailure,
): Timestamp {
  if (!(value instanceof Timestamp)) {
    fail(`${label} must be a Firestore timestamp.`);
  }
  return value;
}

export function decodeEmptyCallableRequest(
  value: unknown,
  fail: DecodeFailure = throwDecodeError,
): void {
  if (value === null || value === undefined) return;
  const decoded = record(value, "request data", fail);
  exactKeys(decoded, [], "request data", fail);
}

export interface SaveTokenRequest {
  token: string;
}

export function decodeSaveTokenRequest(
  value: unknown,
  fail: DecodeFailure = throwDecodeError,
): SaveTokenRequest {
  const decoded = record(value, "request data", fail);
  exactKeys(decoded, ["token"], "request data", fail);
  return {token: string(decoded.token, "token", fail, 500)};
}

export interface BookCallableRequest {
  bookId: string;
}

export function decodeBookCallableRequest(
  value: unknown,
  fail: DecodeFailure = throwDecodeError,
): BookCallableRequest {
  const decoded = record(value, "request data", fail);
  exactKeys(decoded, ["bookId"], "request data", fail);
  const bookId = string(decoded.bookId, "bookId", fail, 1500);
  if (bookId === "." || bookId === ".." || bookId.includes("/") ||
      Buffer.byteLength(bookId, "utf8") > 1500) {
    fail("bookId must be one Firestore document id.");
  }
  return {bookId};
}

export interface IsbnLookupRequest {
  isbn: string;
}

export function decodeIsbnLookupRequest(
  value: unknown,
  fail: DecodeFailure = throwDecodeError,
): IsbnLookupRequest {
  const decoded = record(value, "request data", fail);
  exactKeys(decoded, ["isbn"], "request data", fail);
  if (typeof decoded.isbn !== "string" || !/^\d{13}$/.test(decoded.isbn)) {
    fail("isbn must be a checksum-valid ISBN-13 string.");
  }
  let sum = 0;
  for (let index = 0; index < 12; index += 1) {
    sum += Number(decoded.isbn[index]) * (index % 2 === 0 ? 1 : 3);
  }
  const checkDigit = String((10 - (sum % 10)) % 10);
  if (decoded.isbn[12] !== checkDigit) {
    fail("isbn must be a checksum-valid ISBN-13 string.");
  }
  return {isbn: decoded.isbn};
}

export interface TogglConfig {
  apiToken: string;
  workspaceId: number;
  projectId: number;
}

export function decodeTogglConfig(
  value: unknown,
  fail: DecodeFailure = throwDecodeError,
): TogglConfig {
  const decoded = record(value, "Toggl configuration", fail);
  return {
    apiToken: string(decoded.apiToken, "Toggl API token", fail, 500),
    workspaceId: positiveInteger(
      decoded.workspaceId,
      "Toggl workspace id",
      fail,
    ),
    projectId: positiveInteger(decoded.projectId, "Toggl project id", fail),
  };
}

export type ActiveTimer =
  | {start: string}
  | {entryId: number; start: string}
  | {
      state: "starting";
      operationId: string;
      start: string;
      claimedAt: Timestamp;
    }
  | {
      state: "outcome-unknown";
      operationId: string;
      start: string;
      claimedAt: Timestamp;
      error: string;
    };

export interface BookForTimer {
  title: string;
  activeTimer: ActiveTimer | null;
}

function decodeActiveTimer(
  value: unknown,
  fail: DecodeFailure,
): ActiveTimer {
  const decoded = record(value, "active timer", fail);
  if (decoded.state === "starting" || decoded.state === "outcome-unknown") {
    const outcomeUnknown = decoded.state === "outcome-unknown";
    exactKeys(
      decoded,
      ["state", "operationId", "start", "claimedAt", ...(outcomeUnknown ?
        ["error"] : [])],
      "active timer",
      fail,
    );
    const common = {
      operationId: string(
        decoded.operationId,
        "active timer operation id",
        fail,
        100,
      ),
      start: isoTimestamp(decoded.start, "active timer start", fail),
      claimedAt: firestoreTimestamp(
        decoded.claimedAt,
        "active timer claim time",
        fail,
      ),
    };
    if (!outcomeUnknown) return {state: "starting", ...common};
    return {
      state: "outcome-unknown",
      ...common,
      error: string(decoded.error, "active timer error", fail, 1000),
    };
  }
  exactKeys(decoded, ["entryId", "start"], "active timer", fail);
  const start = isoTimestamp(decoded.start, "active timer start", fail);
  if (decoded.entryId === undefined) return {start};
  return {
    entryId: positiveInteger(decoded.entryId, "active timer entry id", fail),
    start,
  };
}

export function decodeActiveTimerFromBook(
  value: unknown,
  fail: DecodeFailure = throwDecodeError,
): ActiveTimer | null {
  const decoded = record(value, "book", fail);
  return decoded.activeTimer === null || decoded.activeTimer === undefined ?
    null : decodeActiveTimer(decoded.activeTimer, fail);
}

export function decodeBookForTimer(
  value: unknown,
  fail: DecodeFailure = throwDecodeError,
): BookForTimer {
  const decoded = record(value, "book", fail);
  return {
    title: string(decoded.title, "book title", fail, 500),
    activeTimer: decodeActiveTimerFromBook(decoded, fail),
  };
}

export interface TogglProject {
  id: number;
  workspaceId: number;
  name: string;
}

export function decodeTogglProjects(
  value: unknown,
  fail: DecodeFailure = throwDecodeError,
): TogglProject[] {
  if (!Array.isArray(value)) fail("Toggl projects response must be an array.");
  return value.map((item, index) => {
    const decoded = record(item, `Toggl project ${index}`, fail);
    return {
      id: positiveInteger(decoded.id, `Toggl project ${index} id`, fail),
      workspaceId: positiveInteger(
        decoded.workspace_id,
        `Toggl project ${index} workspace id`,
        fail,
      ),
      name: string(decoded.name, `Toggl project ${index} name`, fail, 500),
    };
  });
}

export interface StartedTogglEntry {
  id: number;
  start: string;
}

export function decodeStartedTogglEntry(
  value: unknown,
  fail: DecodeFailure = throwDecodeError,
): StartedTogglEntry {
  const decoded = record(value, "Toggl start response", fail);
  return {
    id: positiveInteger(decoded.id, "Toggl entry id", fail),
    start: isoTimestamp(decoded.start, "Toggl entry start", fail),
  };
}

export function decodeStoppedTogglDuration(
  value: unknown,
  fail: DecodeFailure = throwDecodeError,
): number {
  const decoded = record(value, "Toggl stop response", fail);
  const duration = finiteNumber(decoded.duration, "Toggl entry duration", fail);
  if (!Number.isInteger(duration) || duration < 0) {
    fail("Toggl entry duration must be a non-negative integer.");
  }
  return duration;
}

export function decodeCreatedTogglEntryId(
  value: unknown,
  fail: DecodeFailure = throwDecodeError,
): number {
  const decoded = record(value, "Toggl create response", fail);
  return positiveInteger(decoded.id, "Toggl entry id", fail);
}

interface QueueCommon {
  bookId?: string;
  bookTitle: string;
  start: string;
  stop: string;
}

export interface CreateQueuePayload extends QueueCommon {
  type: "create";
}

export interface StopQueuePayload extends QueueCommon {
  type: "stop";
  entryId: number;
}

export type TogglQueuePayload = CreateQueuePayload | StopQueuePayload;

interface QueueLifecycle {
  createdAt: Timestamp;
  attempts: number;
  claimedAt?: Timestamp;
  expiresAt?: Timestamp;
  retryRequestedAt?: Timestamp;
  error?: string;
}

export type TogglQueueDocument = TogglQueuePayload & QueueLifecycle & (
  | {status: "pending"}
  | {status: "processing"; claimedAt: Timestamp}
  | {status: "error"; claimedAt: Timestamp; error: string}
  | {status: "outcome-unknown"; claimedAt: Timestamp; error: string}
  | {status: "synced"; claimedAt: Timestamp; entryId: number}
);

export function decodeTogglQueueDocument(
  value: unknown,
  fail: DecodeFailure = throwDecodeError,
): TogglQueueDocument {
  const decoded = record(value, "Toggl queue item", fail);
  const type = decoded.type;
  if (type !== "create" && type !== "stop") {
    fail("Toggl queue item type must be create or stop.");
  }
  const status = decoded.status;
  if (status !== "pending" && status !== "processing" &&
      status !== "error" && status !== "outcome-unknown" &&
      status !== "synced") {
    fail("Toggl queue item has an invalid status.");
  }
  const entryIdAllowed = type === "stop" || status === "synced";
  exactKeys(
    decoded,
    [
      "type", "bookTitle", "start", "stop", "status", "createdAt",
      "bookId",
      "attempts", "claimedAt", "expiresAt", "retryRequestedAt", "error",
      ...(entryIdAllowed ? ["entryId"] : []),
    ],
    "Toggl queue item",
    fail,
  );

  const bookId = decoded.bookId === undefined ? undefined :
    string(decoded.bookId, "queue book id", fail, 500);
  if (bookId === "." || bookId === ".." || bookId?.includes("/")) {
    fail("Queue book id must be one Firestore document id.");
  }
  const common = {
    ...(bookId === undefined ? {} : {bookId}),
    bookTitle: string(decoded.bookTitle, "queue book title", fail, 500),
    start: isoTimestamp(decoded.start, "queue start", fail),
    stop: isoTimestamp(decoded.stop, "queue stop", fail),
  };
  const payload: TogglQueuePayload = type === "create" ?
    {type, ...common} :
    {
      type,
      ...common,
      entryId: positiveInteger(decoded.entryId, "queue entry id", fail),
    };
  const createdAt = firestoreTimestamp(
    decoded.createdAt,
    "queue creation time",
    fail,
  );
  const attempts = decoded.attempts === undefined ? 0 :
    nonNegativeInteger(decoded.attempts, "queue attempts", fail);
  const claimedAt = decoded.claimedAt === undefined ? undefined :
    firestoreTimestamp(decoded.claimedAt, "queue claim time", fail);
  const expiresAt = decoded.expiresAt === undefined ? undefined :
    firestoreTimestamp(decoded.expiresAt, "queue expiry time", fail);
  const retryRequestedAt = decoded.retryRequestedAt === undefined ? undefined :
    firestoreTimestamp(
      decoded.retryRequestedAt,
      "queue retry request time",
      fail,
    );
  // Historical rows may hold unsliced Toggl response bodies. The claim
  // transaction deletes them before remote work; all new writes are capped.
  const error = decoded.error === undefined ? undefined : (() => {
    if (typeof decoded.error !== "string") {
      fail("Queue error must be a string.");
    }
    return decoded.error;
  })();

  if (status === "pending") {
    if (attempts === 0 && (decoded.attempts !== undefined ||
        claimedAt !== undefined || error !== undefined)) {
      fail("An initial pending queue item cannot have claim metadata.");
    }
    if (attempts > 0 && claimedAt === undefined) {
      fail("A retried pending queue item must have claim metadata.");
    }
    // Pre-migration clients retried by changing status alone.
    return {
      ...payload,
      status,
      createdAt,
      attempts,
      claimedAt,
      expiresAt,
      retryRequestedAt,
      error,
    };
  }
  if (!claimedAt || attempts === 0) {
    fail(`A ${status} queue item must have claim metadata.`);
  }
  if (status === "processing") {
    if (error !== undefined) fail("A processing queue item cannot have an error.");
    if (retryRequestedAt !== undefined) {
      fail("A processing queue item cannot have a retry request time.");
    }
    return {...payload, status, createdAt, attempts, claimedAt, expiresAt};
  }
  if (status === "error") {
    if (error === undefined) fail("An error queue item must have an error.");
    if (retryRequestedAt !== undefined) {
      fail("An error queue item cannot have a retry request time.");
    }
    return {
      ...payload, status, createdAt, attempts, claimedAt, expiresAt, error,
    };
  }
  if (status === "outcome-unknown") {
    if (payload.type !== "create") {
      fail("Only a create queue item can have an unknown outcome.");
    }
    if (error === undefined) {
      fail("An outcome-unknown queue item must have an error.");
    }
    if (retryRequestedAt !== undefined) {
      fail("An outcome-unknown queue item cannot have a retry request time.");
    }
    return {
      ...payload, status, createdAt, attempts, claimedAt, expiresAt, error,
    };
  }
  const entryId = payload.type === "stop" ? payload.entryId :
    positiveInteger(decoded.entryId, "synced queue entry id", fail);
  if (error !== undefined) fail("A synced queue item cannot have an error.");
  if (retryRequestedAt !== undefined) {
    fail("A synced queue item cannot have a retry request time.");
  }
  return {
    ...payload,
    status,
    createdAt,
    attempts,
    claimedAt,
    expiresAt,
    entryId,
  };
}

export interface GoogleVolumeInfo {
  title?: string;
  authors?: string[];
  publisher?: string;
  publishedDate?: string;
  pageCount?: number;
  categories?: string[];
  imageLinks?: {
    smallThumbnail?: string;
    thumbnail?: string;
  };
}

function optionalString(
  value: unknown,
  maximumLength: number,
): string | undefined {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maximumLength ? value : undefined;
}

function optionalStringArray(
  value: unknown,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const decoded = value.filter((item): item is string =>
    typeof item === "string" && item.length > 0 && item.length <= 1000,
  );
  return decoded.length > 0 ? decoded : undefined;
}

export function decodeBooksApiVolume(
  value: unknown,
  fail: DecodeFailure = throwDecodeError,
): GoogleVolumeInfo | null {
  const decoded = record(value, "Google Books response", fail);
  const totalItems = nonNegativeInteger(
    decoded.totalItems,
    "Google Books totalItems",
    fail,
  );
  if (totalItems === 0) return null;
  if (!Array.isArray(decoded.items) || decoded.items.length === 0) {
    return null;
  }
  if (!isRecord(decoded.items[0]) ||
      !isRecord(decoded.items[0].volumeInfo)) return null;
  const volume = decoded.items[0].volumeInfo;
  const imageLinks = !isRecord(volume.imageLinks) ? undefined : (() => {
    const links = volume.imageLinks;
    const smallThumbnail = optionalString(
      links.smallThumbnail,
      5000,
    );
    const thumbnail = optionalString(
      links.thumbnail,
      5000,
    );
    return {
      ...(smallThumbnail === undefined ? {} : {smallThumbnail}),
      ...(thumbnail === undefined ? {} : {thumbnail}),
    };
  })();
  const pageCount = typeof volume.pageCount === "number" &&
      Number.isInteger(volume.pageCount) && volume.pageCount >= 0 ?
    volume.pageCount : undefined;
  const title = optionalString(volume.title, 1000);
  const authors = optionalStringArray(volume.authors);
  const publisher = optionalString(volume.publisher, 1000);
  const publishedDate = optionalString(volume.publishedDate, 100);
  const categories = optionalStringArray(volume.categories);
  return {
    ...(title === undefined ? {} : {title}),
    ...(authors === undefined ? {} : {authors}),
    ...(publisher === undefined ? {} : {publisher}),
    ...(publishedDate === undefined ? {} : {publishedDate}),
    ...(pageCount === undefined ? {} : {pageCount}),
    ...(categories === undefined ? {} : {categories}),
    ...(imageLinks === undefined ? {} : {imageLinks}),
  };
}

export interface StoredIssue {
  createdAt: Timestamp;
  level: "warn" | "error";
  event: string;
  code: string | null;
  message: string;
  uid: string | null;
  detailEmail: string | null;
}

export function decodeStoredIssue(value: unknown): StoredIssue | null {
  if (!isRecord(value) || !(value.createdAt instanceof Timestamp)) return null;
  if (value.level !== "warn" && value.level !== "error") return null;
  if (typeof value.event !== "string" ||
      typeof value.message !== "string" || value.message.length > 1000) {
    return null;
  }
  if (value.code !== null && value.code !== undefined &&
      (typeof value.code !== "string" || value.code.length > 100)) return null;
  if (value.uid !== null && value.uid !== undefined &&
      (typeof value.uid !== "string" || value.uid.length === 0 ||
       value.uid.length > 128)) return null;
  let detailEmail: string | null = null;
  if (value.detail !== null && value.detail !== undefined) {
    if (!isRecord(value.detail)) return null;
    if (Object.keys(value.detail).some((key) => key !== "email")) return null;
    if (value.detail.email !== undefined &&
        (typeof value.detail.email !== "string" ||
         value.detail.email.length > 320)) return null;
    detailEmail = value.detail.email ?? null;
  }
  return {
    createdAt: value.createdAt,
    level: value.level,
    event: value.event,
    code: value.code ?? null,
    message: value.message,
    uid: value.uid ?? null,
    detailEmail,
  };
}
