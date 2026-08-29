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

function boolean(
  value: unknown,
  label: string,
  fail: DecodeFailure,
): boolean {
  if (typeof value !== "boolean") fail(`${label} must be a boolean.`);
  return value;
}

function boundedPossiblyEmptyString(
  value: unknown,
  label: string,
  fail: DecodeFailure,
  maximumLength: number,
): string {
  if (typeof value !== "string") fail(`${label} must be a string.`);
  if (value.length > maximumLength) {
    fail(`${label} must be at most ${maximumLength} characters.`);
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

const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function calendarValidIsoTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP.exec(value);
  if (match === null || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  return calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day &&
    calendar.getUTCHours() === hour &&
    calendar.getUTCMinutes() === minute &&
    calendar.getUTCSeconds() === second;
}

function isoTimestamp(
  value: unknown,
  label: string,
  fail: DecodeFailure,
): string {
  const decoded = string(value, label, fail, 64);
  if (!calendarValidIsoTimestamp(decoded)) {
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

// Client-reported issue (telemetry-reportissue). The event allowlist is the
// set of subsystems a signed-in client can actually reach; the server-only
// toggl.sync_failed is written by the trigger itself and would let a client
// forge a sync failure the operator then investigates. No free-form detail
// field: an address-shaped value typed before authentication could be a
// password, and nothing the client knows is worth that risk (SEC-029).
export const CLIENT_ISSUE_EVENTS = [
  "firestore.listener_failed",
  "firestore.decode_failed",
  "firestore.write_failed",
  "toggl.sync_stuck",
] as const;

export type ClientIssueEvent = typeof CLIENT_ISSUE_EVENTS[number];

export interface IssueReport {
  level: "warn" | "error";
  event: ClientIssueEvent;
  message: string;
  code: string | null;
}

export function decodeIssueReport(
  value: unknown,
  fail: DecodeFailure = throwDecodeError,
): IssueReport {
  const decoded = record(value, "request data", fail);
  exactKeys(decoded, ["level", "event", "message", "code"], "request data", fail);
  const level = decoded.level;
  if (level !== "warn" && level !== "error") {
    fail("level must be \"warn\" or \"error\".");
  }
  const event = decoded.event;
  if (typeof event !== "string" ||
      !(CLIENT_ISSUE_EVENTS as readonly string[]).includes(event)) {
    fail("event must be one of the client issue events.");
  }
  const message = string(decoded.message, "message", fail, 1000);
  const code = decoded.code === null ?
    null :
    string(decoded.code, "code", fail, 100);
  return {level, event: event as ClientIssueEvent, message, code};
}

const PROFILE_LINK_TYPES = [
  "twitter", "github", "linkedin", "instagram", "scholar", "goodreads",
  "strava", "homepage", "other",
] as const;

type PublicProfileLinkType = typeof PROFILE_LINK_TYPES[number];

export interface PublicProfileLink {
  type: PublicProfileLinkType;
  value: string;
  label?: string;
}

export interface PublicProfileStats {
  totalBooks: number;
  finishedBooks: number;
  readingBooks: number;
  totalTimeReadHours: number;
  totalPagesRead: number;
  booksPerYear: number;
  avgTimePerBook: number;
  authors: number;
}

export interface PublicProfileYear {
  year: number;
  count: number;
  hours: number;
  pages: number;
}

export interface PublicProfileDay {
  day: string;
  pagesRead: number;
  timeRead: number;
  sessions: number;
}

export interface PublicProfileMomentum {
  recentPagesPerDay: number;
  lifetimePagesPerDay: number;
  ratio: number | null;
}

export interface PublicProfileSuperlatives {
  biggestDay: {day: string; pages: number} | null;
  longestSession: {minutes: number} | null;
  medianSessionMinutes: number;
  fastestFinish: {days: number; pageCount: number} | null;
}

export interface PublicProfileRecords {
  momentum: PublicProfileMomentum | null;
  superlatives: PublicProfileSuperlatives;
}

export interface PublicProfile {
  username: string;
  uid: string;
  public: true;
  givenName: string;
  familyName: string;
  links: PublicProfileLink[];
  stats: PublicProfileStats;
  records: PublicProfileRecords | null;
  years: PublicProfileYear[];
  days: PublicProfileDay[];
  updatedAt: Timestamp;
}

export interface ProfileDiscoveryMarker {
  uid: string;
  createdAt: Timestamp;
}

function publicProfileLink(
  value: unknown,
  label: string,
  fail: DecodeFailure,
): PublicProfileLink {
  const decoded = record(value, label, fail);
  exactKeys(decoded, ["type", "value", "label"], label, fail);
  const type = string(decoded.type, `${label} type`, fail, 20);
  const supported = PROFILE_LINK_TYPES.find((candidate) => candidate === type);
  if (supported === undefined) fail(`${label} type is unsupported.`);
  const link: PublicProfileLink = {
    type: supported,
    value: string(decoded.value, `${label} value`, fail, 200),
  };
  if (decoded.label !== undefined) {
    link.label = boundedPossiblyEmptyString(
      decoded.label,
      `${label} label`,
      fail,
      50,
    );
  }
  return link;
}

function publicProfileStats(
  value: unknown,
  label: string,
  fail: DecodeFailure,
): PublicProfileStats {
  const decoded = record(value, label, fail);
  const fields = [
    "totalBooks", "finishedBooks", "readingBooks", "totalTimeReadHours",
    "totalPagesRead", "booksPerYear", "avgTimePerBook", "authors",
  ] as const;
  exactKeys(decoded, fields, label, fail);
  return {
    totalBooks: finiteNumber(decoded.totalBooks, `${label} total books`, fail),
    finishedBooks: finiteNumber(decoded.finishedBooks, `${label} finished books`, fail),
    readingBooks: finiteNumber(decoded.readingBooks, `${label} reading books`, fail),
    totalTimeReadHours: finiteNumber(decoded.totalTimeReadHours, `${label} reading hours`, fail),
    totalPagesRead: finiteNumber(decoded.totalPagesRead, `${label} pages read`, fail),
    booksPerYear: finiteNumber(decoded.booksPerYear, `${label} books per year`, fail),
    avgTimePerBook: finiteNumber(decoded.avgTimePerBook, `${label} average time`, fail),
    authors: finiteNumber(decoded.authors, `${label} authors`, fail),
  };
}

function publicProfileYears(
  value: unknown,
  fail: DecodeFailure,
): PublicProfileYear[] {
  if (!Array.isArray(value)) fail("profile years must be an array.");
  return value.map((entry, index) => {
    const label = `profile year ${index}`;
    const decoded = record(entry, label, fail);
    exactKeys(decoded, ["year", "count", "hours", "pages"], label, fail);
    return {
      year: nonNegativeInteger(decoded.year, `${label} year`, fail),
      count: finiteNumber(decoded.count, `${label} count`, fail),
      hours: finiteNumber(decoded.hours, `${label} hours`, fail),
      pages: finiteNumber(decoded.pages, `${label} pages`, fail),
    };
  });
}

function publicProfileDays(
  value: unknown,
  fail: DecodeFailure,
): PublicProfileDay[] {
  if (!Array.isArray(value)) fail("profile days must be an array.");
  return value.map((entry, index) => {
    const label = `profile day ${index}`;
    const decoded = record(entry, label, fail);
    exactKeys(decoded, ["day", "pagesRead", "timeRead", "sessions"], label, fail);
    return {
      day: string(decoded.day, `${label} date`, fail, 10),
      pagesRead: finiteNumber(decoded.pagesRead, `${label} pages`, fail),
      timeRead: finiteNumber(decoded.timeRead, `${label} time`, fail),
      sessions: finiteNumber(decoded.sessions, `${label} sessions`, fail),
    };
  });
}

function publicProfileMomentum(
  value: unknown,
  fail: DecodeFailure,
): PublicProfileMomentum | null {
  if (value === null) return null;
  const label = "profile momentum";
  const decoded = record(value, label, fail);
  exactKeys(decoded, ["recentPagesPerDay", "lifetimePagesPerDay", "ratio"], label, fail);
  return {
    recentPagesPerDay: finiteNumber(decoded.recentPagesPerDay, `${label} recent pace`, fail),
    lifetimePagesPerDay: finiteNumber(decoded.lifetimePagesPerDay, `${label} lifetime pace`, fail),
    ratio: decoded.ratio === null ? null : finiteNumber(decoded.ratio, `${label} ratio`, fail),
  };
}

function publicProfileSuperlatives(
  value: unknown,
  fail: DecodeFailure,
): PublicProfileSuperlatives {
  const label = "profile superlatives";
  const decoded = record(value, label, fail);
  exactKeys(decoded, ["biggestDay", "longestSession", "medianSessionMinutes", "fastestFinish"], label, fail);
  let biggestDay: PublicProfileSuperlatives["biggestDay"] = null;
  if (decoded.biggestDay !== null) {
    const row = record(decoded.biggestDay, `${label} biggest day`, fail);
    exactKeys(row, ["day", "pages"], `${label} biggest day`, fail);
    biggestDay = {
      day: string(row.day, `${label} biggest day date`, fail, 10),
      pages: finiteNumber(row.pages, `${label} biggest day pages`, fail),
    };
  }
  let longestSession: PublicProfileSuperlatives["longestSession"] = null;
  if (decoded.longestSession !== null) {
    const row = record(decoded.longestSession, `${label} longest session`, fail);
    exactKeys(row, ["minutes"], `${label} longest session`, fail);
    longestSession = {
      minutes: finiteNumber(row.minutes, `${label} longest session minutes`, fail),
    };
  }
  let fastestFinish: PublicProfileSuperlatives["fastestFinish"] = null;
  if (decoded.fastestFinish !== null) {
    const row = record(decoded.fastestFinish, `${label} fastest finish`, fail);
    exactKeys(row, ["days", "pageCount"], `${label} fastest finish`, fail);
    fastestFinish = {
      days: finiteNumber(row.days, `${label} fastest finish days`, fail),
      pageCount: finiteNumber(row.pageCount, `${label} fastest finish pages`, fail),
    };
  }
  return {
    biggestDay,
    longestSession,
    medianSessionMinutes: finiteNumber(decoded.medianSessionMinutes, `${label} median session`, fail),
    fastestFinish,
  };
}

// Records are rendered by the client page (superlatives row), so the JSON
// projection must carry them; the same pinned shape the rules enforce.
function publicProfileRecords(
  value: unknown,
  fail: DecodeFailure,
): PublicProfileRecords | null {
  if (value === null) return null;
  const label = "profile records";
  const decoded = record(value, label, fail);
  exactKeys(decoded, ["momentum", "superlatives"], label, fail);
  return {
    momentum: publicProfileMomentum(decoded.momentum, fail),
    superlatives: publicProfileSuperlatives(decoded.superlatives, fail),
  };
}

export function decodePublicProfile(
  username: string,
  value: unknown,
  fail: DecodeFailure = throwDecodeError,
): PublicProfile {
  const decoded = record(value, `profile ${username}`, fail);
  exactKeys(decoded, [
    "uid", "public", "givenName", "familyName", "links", "stats",
    "records", "years", "days", "updatedAt",
  ], `profile ${username}`, fail);
  if (boolean(decoded.public, "profile public flag", fail) !== true) {
    fail("profile must be public before rendering.");
  }
  if (!Array.isArray(decoded.links)) fail("profile links must be an array.");
  return {
    username,
    uid: string(decoded.uid, "profile owner", fail, 128),
    public: true,
    givenName: boundedPossiblyEmptyString(decoded.givenName, "profile given name", fail, 50),
    familyName: boundedPossiblyEmptyString(decoded.familyName, "profile family name", fail, 50),
    links: decoded.links.map((entry, index) =>
      publicProfileLink(entry, `profile link ${index}`, fail)),
    stats: publicProfileStats(decoded.stats, "profile stats", fail),
    records: publicProfileRecords(decoded.records, fail),
    years: publicProfileYears(decoded.years, fail),
    days: publicProfileDays(decoded.days, fail),
    updatedAt: firestoreTimestamp(decoded.updatedAt, "profile update time", fail),
  };
}

export function decodeProfileDiscoveryMarker(
  value: unknown,
  fail: DecodeFailure = throwDecodeError,
): ProfileDiscoveryMarker {
  const decoded = record(value, "profile discovery marker", fail);
  exactKeys(decoded, ["uid", "createdAt"], "profile discovery marker", fail);
  return {
    uid: string(decoded.uid, "profile discovery owner", fail, 128),
    createdAt: firestoreTimestamp(
      decoded.createdAt,
      "profile discovery creation time",
      fail,
    ),
  };
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
  | {start: string; operationId?: string}
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
    }
  | {
      state: "stopping";
      entryId: number;
      start: string;
      queueId: string;
    };

export type ActiveTimerClaim =
  | {version: 1; state: "local"; bookId: string; operationId: string; start: string}
  | {version: 1; state: "remote"; bookId: string; entryId: number; start: string}
  | {version: 1; state: "starting"; bookId: string; operationId: string; start: string; claimedAt: Timestamp}
  | {version: 1; state: "outcome-unknown"; bookId: string; operationId: string; start: string; claimedAt: Timestamp; error: string}
  | {version: 1; state: "stopping"; bookId: string; entryId: number; start: string; queueId: string};

export type TimerClaim =
  | ActiveTimerClaim
  | {version: 1; state: "idle"; cleared: ActiveTimerClaim | null};

export interface BookForTimer {
  title: string;
  activeTimer: ActiveTimer | null;
}

function decodeActiveTimer(
  value: unknown,
  fail: DecodeFailure,
): ActiveTimer {
  const decoded = record(value, "active timer", fail);
  if (decoded.state === "stopping") {
    exactKeys(decoded, ["state", "entryId", "start", "queueId"], "active timer", fail);
    return {
      state: "stopping",
      entryId: positiveInteger(decoded.entryId, "active timer entry id", fail),
      start: isoTimestamp(decoded.start, "active timer start", fail),
      queueId: string(decoded.queueId, "active timer queue id", fail, 600),
    };
  }
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
  exactKeys(decoded, ["entryId", "operationId", "start"], "active timer", fail);
  const start = isoTimestamp(decoded.start, "active timer start", fail);
  if (decoded.entryId === undefined) {
    return decoded.operationId === undefined ? {start} : {
      start,
      operationId: string(decoded.operationId, "active timer operation id", fail, 100),
    };
  }
  return {
    entryId: positiveInteger(decoded.entryId, "active timer entry id", fail),
    start,
  };
}

export function decodeTimerClaim(
  value: unknown,
  fail: DecodeFailure = throwDecodeError,
): TimerClaim {
  const decoded = record(value, "timer claim", fail);
  if (decoded.version !== 1) fail("Timer claim version must be 1.");
  const state = string(decoded.state, "timer claim state", fail, 32);
  if (state === "idle") {
    exactKeys(decoded, ["version", "state", "cleared"], "timer claim", fail);
    if (decoded.cleared === null) return {version: 1, state, cleared: null};
    const cleared = decodeTimerClaim(decoded.cleared, fail);
    if (cleared.state === "idle") fail("An idle timer claim cannot contain another idle claim.");
    return {version: 1, state, cleared};
  }
  const bookId = string(decoded.bookId, "timer claim book id", fail, 500);
  const start = isoTimestamp(decoded.start, "timer claim start", fail);
  if (state === "local") {
    exactKeys(decoded, ["version", "state", "bookId", "operationId", "start"], "timer claim", fail);
    return {
      version: 1,
      state,
      bookId,
      operationId: string(decoded.operationId, "timer claim operation id", fail, 100),
      start,
    };
  }
  if (state === "remote") {
    exactKeys(decoded, ["version", "state", "bookId", "entryId", "start"], "timer claim", fail);
    return {
      version: 1,
      state,
      bookId,
      entryId: positiveInteger(decoded.entryId, "timer claim entry id", fail),
      start,
    };
  }
  if (state === "stopping") {
    exactKeys(decoded, ["version", "state", "bookId", "entryId", "start", "queueId"], "timer claim", fail);
    return {
      version: 1,
      state,
      bookId,
      entryId: positiveInteger(decoded.entryId, "timer claim entry id", fail),
      start,
      queueId: string(decoded.queueId, "timer claim queue id", fail, 600),
    };
  }
  if (state === "starting" || state === "outcome-unknown") {
    const unknown = state === "outcome-unknown";
    exactKeys(
      decoded,
      ["version", "state", "bookId", "operationId", "start", "claimedAt", ...(unknown ? ["error"] : [])],
      "timer claim",
      fail,
    );
    const common = {
      state,
      version: 1 as const,
      bookId,
      operationId: string(decoded.operationId, "timer claim operation id", fail, 100),
      start,
      claimedAt: firestoreTimestamp(decoded.claimedAt, "timer claim time", fail),
    };
    return unknown ? {
      ...common,
      state: "outcome-unknown",
      error: string(decoded.error, "timer claim error", fail, 1000),
    } : {...common, state: "starting"};
  }
  return fail("Timer claim state must be idle, local, remote, starting, stopping, or outcome-unknown.");
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
  timerClaimVersion?: 1;
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
  // Server-pinned end of the quota window that deferred a pending row; the
  // rules refuse a client retry marker before it. Cleared on claim.
  deferredUntil?: Timestamp;
  // How many windows have deferred the row; terminal past the cap.
  deferrals: number;
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
      "timerClaimVersion",
      "attempts", "claimedAt", "expiresAt", "retryRequestedAt", "error",
      "deferredUntil", "deferrals",
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
  if (decoded.timerClaimVersion !== undefined && decoded.timerClaimVersion !== 1) {
    fail("Queue timer claim version must be 1 when present.");
  }
  const common = {
    ...(bookId === undefined ? {} : {bookId}),
    ...(decoded.timerClaimVersion === undefined ? {} : {timerClaimVersion: 1 as const}),
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
  const deferredUntil = decoded.deferredUntil === undefined ? undefined :
    firestoreTimestamp(decoded.deferredUntil, "queue deferral time", fail);
  if (deferredUntil !== undefined && status !== "pending") {
    fail("Only a pending queue item can be deferred.");
  }
  const deferrals = decoded.deferrals === undefined ? 0 :
    nonNegativeInteger(decoded.deferrals, "queue deferrals", fail);
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
      deferredUntil,
      deferrals,
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
    return {...payload, status, createdAt, attempts, claimedAt, expiresAt, deferrals};
  }
  if (status === "error") {
    if (error === undefined) fail("An error queue item must have an error.");
    if (retryRequestedAt !== undefined) {
      fail("An error queue item cannot have a retry request time.");
    }
    return {
      ...payload, status, createdAt, attempts, claimedAt, expiresAt, deferrals, error,
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
      ...payload, status, createdAt, attempts, claimedAt, expiresAt, deferrals, error,
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
    deferrals,
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
  // event is bounded here too, so the feed's per-row size is a guarantee of
  // this decoder rather than an inference about every writer's allowlist.
  if (typeof value.event !== "string" || value.event.length > 100 ||
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
