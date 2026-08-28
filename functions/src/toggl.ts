import * as functions from "firebase-functions/v1";
import {onDocumentWritten} from "firebase-functions/v2/firestore";
import {DocumentReference, FieldValue, Timestamp, getFirestore} from "firebase-admin/firestore";
import {Buffer} from "node:buffer";
import {randomUUID} from "node:crypto";
import {env} from "node:process";
import {setTimeout as delay} from "node:timers/promises";
import {CALLABLE_MAX_INSTANCES, EVENT_INGRESS, FUNCTIONS_RUNTIME_SERVICE_ACCOUNT} from "./runtime";
import {logIssue} from "./logging";
import {markCorrelatedStopFailure} from "./toggl-recovery";
import {
  ActiveTimer,
  TimerClaim,
  TogglConfig,
  TogglQueueDocument,
  TogglQueuePayload,
  decodeActiveTimerFromBook,
  decodeBookCallableRequest,
  decodeBookForTimer,
  decodeCreatedTogglEntryId,
  decodeEmptyCallableRequest,
  decodeSaveTokenRequest,
  decodeStartedTogglEntry,
  decodeStoppedTogglDuration,
  decodeTimerClaim,
  decodeTogglConfig,
  decodeTogglProjects,
  decodeTogglQueueDocument,
} from "./decoders";

const db = getFirestore();

const TOGGL_BASE = "https://api.track.toggl.com/api/v9";
const PROJECT_NAME = "Reading";

const EMULATOR_WORKSPACE_ID = 900001;
const EMULATOR_PROJECT_ID = 900002;
const EMULATOR_ENTRY_ID = 900003;
const EMULATOR_STOP_DURATION_SECONDS = 60;

const MAX_QUEUE_ATTEMPTS = 5;
const TOGGL_QUEUE_LIMIT = 10;
const TOGGL_QUEUE_WINDOW_MS = 60 * 60 * 1000;
const TOGGL_QUEUE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const START_CLAIM_STALE_MS = 5 * 60 * 1000;

const invalidArgument = (message: string): never => {
  throw new functions.https.HttpsError("invalid-argument", message);
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function queueExpiry(now: Timestamp): Timestamp {
  return Timestamp.fromMillis(now.toMillis() + TOGGL_QUEUE_RETENTION_MS);
}

function decodeQueueQuota(value: unknown): {
  windowStartedAt: Timestamp;
  count: number;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Toggl queue quota must be an object.");
  }
  const data = value as Record<string, unknown>;
  const keys = Object.keys(data);
  if (keys.length !== 2 || !keys.includes("windowStartedAt") ||
      !keys.includes("count")) {
    throw new TypeError("Toggl queue quota has invalid fields.");
  }
  if (!(data.windowStartedAt instanceof Timestamp) ||
      typeof data.count !== "number" ||
      !Number.isSafeInteger(data.count) || data.count < 0) {
    throw new TypeError("Toggl queue quota has invalid values.");
  }
  return {windowStartedAt: data.windowStartedAt, count: data.count};
}

class OutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutcomeUnknownError";
  }
}

class QueueQuotaDeferredError extends Error {
  constructor() {
    super("Toggl queue hourly limit reached; Eventarc will retry.");
    this.name = "QueueQuotaDeferredError";
  }
}

type StartClaimResult =
  | {status: "claimed"; title: string}
  | {status: "recovered-unknown"};

interface QueueClaimToken {
  attempts: number;
  claimedAt: Timestamp;
}

function emulatorJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {"Content-Type": "application/json"},
  });
}

// The Functions emulator is used with production snapshots, including the
// owner's real Toggl token. Never let a rehearsal send that token or mutate
// real Toggl data. These responses cover every Toggl endpoint this module
// calls and still drive the real Firestore claim, timer and queue lifecycles.
function emulatorTogglFetch(
  method: string,
  path: string,
  body?: object,
): Response {
  if (method === "GET" && path === "/me") {
    return emulatorJson({id: 1});
  }
  if (method === "GET" && path === "/me/projects") {
    return emulatorJson([{
      id: EMULATOR_PROJECT_ID,
      workspace_id: EMULATOR_WORKSPACE_ID,
      name: PROJECT_NAME,
    }]);
  }

  const timeEntryPath =
    /^\/workspaces\/\d+\/time_entries(?:\/(\d+)(?:\/stop)?)?$/;
  const match = timeEntryPath.exec(path);
  if (method === "POST" && match !== null && match[1] === undefined) {
    if (body === undefined || !("start" in body) ||
        typeof body.start !== "string") {
      return emulatorJson({error: "start is required"}, 400);
    }
    return emulatorJson({id: EMULATOR_ENTRY_ID, start: body.start});
  }
  if (method === "PATCH" && match?.[1] !== undefined &&
      path.endsWith("/stop")) {
    return emulatorJson({duration: EMULATOR_STOP_DURATION_SECONDS});
  }
  if (method === "PUT" && match?.[1] !== undefined) {
    return emulatorJson({id: Number(match[1])});
  }

  const existingEntry = /^\/me\/time_entries\/(\d+)$/.exec(path);
  if (method === "GET" && existingEntry !== null) {
    return emulatorJson({
      id: Number(existingEntry[1]),
      duration: EMULATOR_STOP_DURATION_SECONDS,
    });
  }
  return emulatorJson({error: `No Toggl emulator route for ${method} ${path}`}, 501);
}

async function togglFetch(
  token: string,
  method: string,
  path: string,
  body?: object,
): Promise<Response> {
  if (env.FUNCTIONS_EMULATOR === "true") {
    return emulatorTogglFetch(method, path, body);
  }
  const doFetch = () => fetch(TOGGL_BASE + path, {
    method,
    headers: {
      "Authorization":
        "Basic " + Buffer.from(`${token}:api_token`).toString("base64"),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let resp = await doFetch();
  if (resp.status === 429) {
    // Toggl rate-limits with a leaky bucket per token; a reconnect burst
    // of queue items (one function instance each) can trip it, and they
    // all see the 429 at the same moment. Back off long enough for the
    // bucket to drain and jitter so the retries don't collide again. A 429
    // rejects before processing, so replaying even a POST cannot
    // duplicate. Items that still fail go to 'error' and are requeued by
    // the client's next-session sweep.
    await delay(15000 + Math.random() * 15000);
    resp = await doFetch();
  }
  return resp;
}

// Toggl stores timestamps at second precision and requires
// start + duration == stop, so both the duration arithmetic and the
// timestamps sent must be truncated to whole seconds the same way.
function secs(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

function isoAtSecond(iso: string): string {
  return new Date(secs(iso) * 1000).toISOString();
}

function requireUid(context: functions.https.CallableContext): string {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Must be signed in.",
    );
  }
  return context.auth.uid;
}

async function getTogglConfig(uid: string): Promise<TogglConfig> {
  const userSnap = await db.doc(`users/${uid}`).get();
  const user = userSnap.data();
  const toggl = user?.toggl;
  if (!toggl) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Add your Toggl API token on the Me page first.",
    );
  }
  return decodeTogglConfig(toggl, (message) => {
    throw new functions.https.HttpsError(
      "failed-precondition",
      `Stored Toggl configuration is invalid: ${message}`,
    );
  });
}

function claimForTimer(bookId: string, timer: ActiveTimer): TimerClaim {
  if (!("state" in timer)) {
    if ("entryId" in timer) {
      return {version: 1, state: "remote", bookId, entryId: timer.entryId, start: timer.start};
    }
    if (timer.operationId === undefined) {
      throw new Error("Local timer is missing its operation id.");
    }
    return {version: 1, state: "local", bookId, operationId: timer.operationId, start: timer.start};
  }
  return {version: 1, ...timer, bookId};
}

function timerMatchesClaim(
  bookId: string,
  timer: ActiveTimer | null,
  claim: TimerClaim,
): boolean {
  if (timer === null || claim.state === "idle" || claim.bookId !== bookId) return false;
  const expected = claimForTimer(bookId, timer);
  if (expected.state !== claim.state || expected.start !== claim.start) return false;
  if (expected.state === "local") {
    return claim.state === "local" && expected.operationId === claim.operationId;
  }
  if (expected.state === "remote") {
    return claim.state === "remote" && expected.entryId === claim.entryId;
  }
  if (expected.state === "stopping") {
    return claim.state === "stopping" && expected.entryId === claim.entryId &&
      expected.queueId === claim.queueId;
  }
  if (expected.state === "starting") {
    return claim.state === "starting" && expected.operationId === claim.operationId &&
      expected.claimedAt.isEqual(claim.claimedAt);
  }
  return claim.state === "outcome-unknown" &&
    expected.operationId === claim.operationId &&
    expected.claimedAt.isEqual(claim.claimedAt) && expected.error === claim.error;
}

exports.savetoken = functions
  .region("europe-west1")
  .runWith({serviceAccount: FUNCTIONS_RUNTIME_SERVICE_ACCOUNT, maxInstances: CALLABLE_MAX_INSTANCES})
  .https.onCall(async (data: unknown, context) => {
    const uid = requireUid(context);
    const {token} = decodeSaveTokenRequest(data, invalidArgument);

    const meResp = await togglFetch(token, "GET", "/me");
    if (!meResp.ok) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        `Toggl rejected the API token (status ${meResp.status}).`,
      );
    }

    const projectsResp = await togglFetch(token, "GET", "/me/projects");
    if (!projectsResp.ok) {
      throw new Error(
        `Toggl project lookup failed with status ${projectsResp.status}`,
      );
    }
    const projectsData: unknown = await projectsResp.json();
    const projects = decodeTogglProjects(projectsData);
    const project = projects.find((p) => p.name === PROJECT_NAME);
    if (!project) {
      throw new functions.https.HttpsError(
        "not-found",
        `No Toggl project named "${PROJECT_NAME}" found.`,
      );
    }

    // update, never a merge-set: the user document is created only by the
    // sign-up trigger, and an identity whose account has been deleted keeps
    // a valid ID token for up to an hour — it must not be able to recreate
    // its document (and re-enable queue processing) through this callable.
    const userRef = db.doc(`users/${uid}`);
    if (!(await userRef.get()).exists) {
      throw new functions.https.HttpsError("failed-precondition", "Account is not set up.");
    }
    await userRef.update({
      toggl: {
        apiToken: token,
        workspaceId: project.workspaceId,
        projectId: project.id,
      },
    });

    return {workspaceId: project.workspaceId, projectId: project.id};
  });

// The stored token is a live credential for the user's whole Toggl
// account, and users/{uid} is read-only to its owner, so without this the
// only way to withdraw it was an operator with the Admin SDK. Clearing the
// copy does not invalidate the credential at Toggl — the UI says so.
exports.cleartoken = functions
  .region("europe-west1")
  .runWith({serviceAccount: FUNCTIONS_RUNTIME_SERVICE_ACCOUNT, maxInstances: CALLABLE_MAX_INSTANCES})
  .https.onCall(async (data: unknown, context) => {
    const uid = requireUid(context);
    decodeEmptyCallableRequest(data, invalidArgument);
    const userRef = db.doc(`users/${uid}`);
    if (!(await userRef.get()).exists) {
      throw new functions.https.HttpsError("failed-precondition", "Account is not set up.");
    }
    await userRef.update({toggl: FieldValue.delete()});
    return {cleared: true};
  });

exports.start = functions
  .region("europe-west1")
  .runWith({serviceAccount: FUNCTIONS_RUNTIME_SERVICE_ACCOUNT, maxInstances: CALLABLE_MAX_INSTANCES})
  .https.onCall(async (data: unknown, context) => {
    const uid = requireUid(context);
    const {bookId} = decodeBookCallableRequest(data, invalidArgument);
    const toggl = await getTogglConfig(uid);

    const bookRef = db.doc(`users/${uid}/books/${bookId}`);
    const claimRef = db.doc(`users/${uid}/timerLifecycle/current`);
    const operationId = randomUUID();
    const requestedStart = new Date().toISOString();
    const claimedAt = Timestamp.now();
    const claim = await db.runTransaction<StartClaimResult>(async (tx) => {
      const [bookSnap, claimSnap] = await Promise.all([
        tx.get(bookRef),
        tx.get(claimRef),
      ]);
      if (!bookSnap.exists) {
        throw new functions.https.HttpsError("not-found", "Book not found.");
      }
      const book = decodeBookForTimer(bookSnap.data());
      const currentClaim = claimSnap.exists ? decodeTimerClaim(claimSnap.data()) : null;
      if (currentClaim?.state === "starting" &&
          currentClaim.claimedAt.toMillis() < Date.now() - START_CLAIM_STALE_MS) {
        const claimedBookRef = db.doc(`users/${uid}/books/${currentClaim.bookId}`);
        const claimedBookSnap = currentClaim.bookId === bookId ?
          bookSnap : await tx.get(claimedBookRef);
        if (!claimedBookSnap.exists) {
          throw new Error("Stale timer claim references a missing book.");
        }
        const activeTimer = decodeActiveTimerFromBook(claimedBookSnap.data());
        if (!timerMatchesClaim(currentClaim.bookId, activeTimer, currentClaim)) {
          throw new Error("Stale timer claim does not match its book.");
        }
        const replacement: ActiveTimer = {
          state: "outcome-unknown",
          operationId: currentClaim.operationId,
          start: currentClaim.start,
          claimedAt: currentClaim.claimedAt,
          error: "The Toggl start invocation ended before it confirmed " +
            "the remote timer. Check Toggl before clearing this state.",
        };
        tx.update(claimedBookRef, {activeTimer: replacement});
        tx.set(claimRef, claimForTimer(currentClaim.bookId, replacement));
        return {status: "recovered-unknown"};
      }
      if (currentClaim === null) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Timer data is being upgraded. Try again after maintenance completes.",
        );
      }
      if (currentClaim.state !== "idle") {
        const message = currentClaim.bookId === bookId && currentClaim.state === "starting" ?
            "A Toggl timer start is already in progress for this book." :
          currentClaim.bookId === bookId && currentClaim.state === "outcome-unknown" ?
            "The previous Toggl timer start has an unknown outcome. Check Toggl before clearing it." :
            `A timer is already active for ${currentClaim.bookId === bookId ? "this" : "another"} book.`;
        throw new functions.https.HttpsError("failed-precondition", message);
      }
      if (book.activeTimer !== null) {
        throw new Error("Book timer exists without its user-wide timer claim.");
      }
      const timer: ActiveTimer = {
        state: "starting",
        operationId,
        start: requestedStart,
        claimedAt,
      };
      tx.update(bookRef, {activeTimer: timer});
      tx.set(claimRef, claimForTimer(bookId, timer));
      return {status: "claimed", title: book.title};
    });
    if (claim.status === "recovered-unknown") {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "The previous Toggl timer start has an unknown outcome. " +
          "Check Toggl before clearing it.",
      );
    }

    let resp: Response;
    try {
      resp = await togglFetch(
        toggl.apiToken,
        "POST",
        `/workspaces/${toggl.workspaceId}/time_entries`,
        {
          created_with: "book-tracker",
          description: claim.title,
          project_id: toggl.projectId,
          workspace_id: toggl.workspaceId,
          start: requestedStart,
          duration: -1,
        },
      );
    } catch (error) {
      await transitionStartClaim(bookRef, claimRef, operationId, {
        state: "outcome-unknown",
        operationId,
        start: requestedStart,
        claimedAt,
        error: `Toggl start outcome unknown: ${errorMessage(error)}`
          .slice(0, 1000),
      });
      throw error;
    }
    if (!resp.ok) {
      const error = `Toggl start failed with status ${resp.status}.`;
      await transitionStartClaim(bookRef, claimRef, operationId, resp.status >= 500 ? {
        state: "outcome-unknown",
        operationId,
        start: requestedStart,
        claimedAt,
        error,
      } : null);
      throw new Error(error);
    }

    let entry: {id: number; start: string};
    try {
      const entryData: unknown = await resp.json();
      entry = decodeStartedTogglEntry(entryData);
    } catch (error) {
      await transitionStartClaim(bookRef, claimRef, operationId, {
        state: "outcome-unknown",
        operationId,
        start: requestedStart,
        claimedAt,
        error: `Toggl created a timer but its response was invalid: ${
          errorMessage(error)}`.slice(0, 1000),
      });
      throw error;
    }

    const finalized = await transitionStartClaim(bookRef, claimRef, operationId, {
      entryId: entry.id,
      start: entry.start,
    });
    if (!finalized) {
      throw new Error("The Toggl timer started, but its local claim changed.");
    }

    return {entryId: entry.id, start: entry.start};
  });

async function transitionStartClaim(
  bookRef: DocumentReference,
  claimRef: DocumentReference,
  operationId: string,
  replacement: ActiveTimer | null,
): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const [snap, claimSnap] = await Promise.all([
      tx.get(bookRef),
      tx.get(claimRef),
    ]);
    if (!snap.exists || !claimSnap.exists) return false;
    const current = decodeActiveTimerFromBook(snap.data());
    const claim = decodeTimerClaim(claimSnap.data());
    if (!current || !("state" in current) ||
        current.state !== "starting" || current.operationId !== operationId ||
        claim.state !== "starting" || claim.operationId !== operationId ||
        !timerMatchesClaim(bookRef.id, current, claim)) {
      return false;
    }
    tx.update(bookRef, {activeTimer: replacement});
    if (replacement === null) tx.set(claimRef, {version: 1, state: "idle", cleared: claim});
    else tx.set(claimRef, claimForTimer(bookRef.id, replacement));
    return true;
  });
}

exports.stop = functions
  .region("europe-west1")
  .runWith({serviceAccount: FUNCTIONS_RUNTIME_SERVICE_ACCOUNT, maxInstances: CALLABLE_MAX_INSTANCES})
  .https.onCall(async (data: unknown, context) => {
    const uid = requireUid(context);
    const {bookId} = decodeBookCallableRequest(data, invalidArgument);

    const bookRef = db.doc(`users/${uid}/books/${bookId}`);
    const claimRef = db.doc(`users/${uid}/timerLifecycle/current`);
    const activeTimer = await db.runTransaction(async (tx) => {
      const [bookSnap, claimSnap] = await Promise.all([
        tx.get(bookRef),
        tx.get(claimRef),
      ]);
      if (!bookSnap.exists) {
        throw new functions.https.HttpsError("not-found", "Book not found.");
      }
      if (!claimSnap.exists) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "Timer data is being upgraded. Try again after maintenance completes.",
        );
      }
      const timer = decodeActiveTimerFromBook(bookSnap.data());
      const claim = decodeTimerClaim(claimSnap.data());
      if (!timer || "state" in timer || !("entryId" in timer) ||
          claim.state !== "remote" || !timerMatchesClaim(bookId, timer, claim)) {
        const message = timer && "state" in timer ?
          timer.state === "starting" ?
            "The Toggl timer is still starting." :
            "The Toggl timer cannot be stopped in its current state." :
          "No Toggl-backed timer is running for this book.";
        throw new functions.https.HttpsError("failed-precondition", message);
      }
      return timer;
    });

    const toggl = await getTogglConfig(uid);

    const stopResp = await togglFetch(
      toggl.apiToken,
      "PATCH",
      `/workspaces/${toggl.workspaceId}/time_entries/${activeTimer.entryId}/stop`,
    );

    let seconds: number;
    if (stopResp.ok) {
      const entryData: unknown = await stopResp.json();
      seconds = decodeStoppedTogglDuration(entryData);
    } else if (stopResp.status === 404) {
      // Entry was deleted in Toggl; clear the timer so the app recovers.
      const missingEntryCleared = await clearMatchedTimer(
        bookRef,
        claimRef,
        activeTimer,
      );
      if (!missingEntryCleared) {
        throw new Error("The Toggl entry is gone, but its local timer claim changed.");
      }
      throw new functions.https.HttpsError(
        "not-found",
        "The Toggl entry no longer exists; timer cleared. " +
          "Add the session manually if needed.",
      );
    } else if (stopResp.status === 409) {
      // Already stopped in Toggl; fetch its final duration.
      const entryResp = await togglFetch(
        toggl.apiToken,
        "GET",
        `/me/time_entries/${activeTimer.entryId}`,
      );
      if (!entryResp.ok) {
        throw new Error(
          `Toggl entry fetch failed with status ${entryResp.status}`,
        );
      }
      const entryData: unknown = await entryResp.json();
      seconds = decodeStoppedTogglDuration(entryData);
    } else {
      throw new Error(
        `Toggl stop failed with status ${stopResp.status}: ` +
          `${await stopResp.text()}`,
      );
    }

    const cleared = await clearMatchedTimer(bookRef, claimRef, activeTimer);
    if (!cleared) {
      throw new Error("The Toggl timer stopped, but its local claim changed.");
    }

    return {seconds, minutes: Math.max(1, Math.round(seconds / 60))};
  });

exports.clearstopping = functions
  .region("europe-west1")
  .runWith({serviceAccount: FUNCTIONS_RUNTIME_SERVICE_ACCOUNT, maxInstances: CALLABLE_MAX_INSTANCES})
  .https.onCall(async (data: unknown, context) => {
    const uid = requireUid(context);
    const {bookId} = decodeBookCallableRequest(data, invalidArgument);
    const bookRef = db.doc(`users/${uid}/books/${bookId}`);
    const claimRef = db.doc(`users/${uid}/timerLifecycle/current`);
    await db.runTransaction(async (tx) => {
      const [bookSnap, claimSnap] = await Promise.all([
        tx.get(bookRef),
        tx.get(claimRef),
      ]);
      if (!bookSnap.exists || !claimSnap.exists) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "The queued stop no longer has complete local state.",
        );
      }
      const timer = decodeActiveTimerFromBook(bookSnap.data());
      const claim = decodeTimerClaim(claimSnap.data());
      if (!timer || !("state" in timer) || timer.state !== "stopping" ||
          claim.state !== "stopping" || !timerMatchesClaim(bookId, timer, claim)) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "The queued stop changed. Reload before trying again.",
        );
      }
      const queueRef = db.doc(`users/${uid}/togglQueue/${timer.queueId}`);
      const queueSnap = await tx.get(queueRef);
      if (!queueSnap.exists) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "The queued stop is missing. Contact the administrator before clearing it.",
        );
      }
      const queue = decodeTogglQueueDocument(queueSnap.data());
      const exactQueue = queue.type === "stop" &&
        queue.timerClaimVersion === 1 && queue.bookId === bookId &&
        queue.entryId === timer.entryId && queue.start === timer.start;
      if (!exactQueue) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "The queued stop does not match this timer.",
        );
      }
      const staleCappedProcessing = queue.status === "processing" &&
        queue.attempts >= MAX_QUEUE_ATTEMPTS &&
        queue.claimedAt.toMillis() < Date.now() - 6 * 60 * 60 * 1000;
      if (queue.status === "processing" && !staleCappedProcessing) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "The Toggl stop is processing. Wait for it to finish.",
        );
      }
      // A stop PUT never uses outcome-unknown: every non-2xx response is a
      // confirmed failure, while a thrown request is also safe to inspect in
      // Toggl before choosing this explicit recovery path. Do not make the
      // user reopen the app until a deterministic failure reaches the retry
      // cap; the confirmation checkbox is the safety boundary here.
      if (!(queue.status === "synced" || queue.status === "error" ||
          staleCappedProcessing)) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "The Toggl stop is still retryable. Reconnect and let it finish.",
        );
      }
      tx.update(bookRef, {activeTimer: null});
      tx.set(claimRef, {version: 1, state: "idle", cleared: claim});
      tx.delete(queueRef);
    });
    return {cleared: true};
  });

async function clearMatchedTimer(
  bookRef: DocumentReference,
  claimRef: DocumentReference,
  expectedTimer: ActiveTimer,
): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const [bookSnap, claimSnap] = await Promise.all([
      tx.get(bookRef),
      tx.get(claimRef),
    ]);
    if (!bookSnap.exists || !claimSnap.exists) return false;
    const timer = decodeActiveTimerFromBook(bookSnap.data());
    const claim = decodeTimerClaim(claimSnap.data());
    const expectedClaim = claimForTimer(bookRef.id, expectedTimer);
    if (!timerMatchesClaim(bookRef.id, timer, expectedClaim) ||
        claim.state === "idle" || !timerMatchesClaim(bookRef.id, timer, claim)) {
      return false;
    }
    tx.update(bookRef, {activeTimer: null});
    tx.set(claimRef, {version: 1, state: "idle", cleared: claim});
    return true;
  });
}

// Performs one queued Toggl operation and returns the entry id it touched.
// Queue docs are client-writable, so every field is validated before it
// reaches the Toggl API (entryId in particular is interpolated into the
// request path and must be a number).
async function syncQueueItem(
  uid: string,
  item: TogglQueuePayload,
  queueRef: DocumentReference,
): Promise<number> {
  const toggl = await getTogglConfig(uid);

  let duration = secs(item.stop) - secs(item.start);
  if (item.type === "stop") {
    // A 'stop' item mixes clocks: start is Toggl's server timestamp, stop
    // is the device clock, and throwing on a bad interval would strand the
    // Toggl entry running forever. A slow device clock (non-positive
    // interval) clamps to one second; a fast one is capped at the elapsed
    // time this function's own clock has observed since the entry started.
    duration = Math.max(1, Math.min(
      duration,
      Math.floor(Date.now() / 1000) - secs(item.start),
    ));
  } else if (!(duration > 0)) {
    throw new Error(`invalid interval ${item.start}..${item.stop}`);
  }
  const body = {
    created_with: "book-tracker",
    description: item.bookTitle,
    project_id: toggl.projectId,
    workspace_id: toggl.workspaceId,
    start: isoAtSecond(item.start),
    // Derived from start + duration (not item.stop) so the clamp above
    // cannot break Toggl's start + duration == stop invariant.
    stop: new Date((secs(item.start) + duration) * 1000).toISOString(),
    duration,
  };

  if (item.type === "create") {
    // Timer ran fully offline: create a completed entry covering the
    // historical interval. Toggl requires duration on create.
    // Persist a terminal state before POST. If the process dies after Toggl
    // accepts the request, the client must not replay it and create a second
    // entry. A verified non-2xx response moves back to retryable error; a
    // network failure or invalid 2xx response remains outcome-unknown.
    await queueRef.update({
      status: "outcome-unknown",
      error: "Toggl create started but its remote outcome is not confirmed.",
      retryRequestedAt: FieldValue.delete(),
    });
    let postResp: Response;
    try {
      postResp = await togglFetch(
        toggl.apiToken,
        "POST",
        `/workspaces/${toggl.workspaceId}/time_entries`,
        body,
      );
    } catch (error) {
      throw new OutcomeUnknownError(
        `Toggl create outcome unknown: ${errorMessage(error)}`,
      );
    }
    if (!postResp.ok) {
      const message = `Toggl create failed with status ${postResp.status}.`;
      if (postResp.status >= 500) {
        throw new OutcomeUnknownError(message);
      }
      throw new Error(message);
    }
    try {
      const entryData: unknown = await postResp.json();
      return decodeCreatedTogglEntryId(entryData);
    } catch (error) {
      throw new OutcomeUnknownError(
        `Toggl created an entry but its response was invalid: ${
          errorMessage(error)}`,
      );
    }
  }

  // Entry started online but was stopped offline. PUT the recorded stop
  // time rather than PATCH /stop, which would stamp reconnect time. The PUT
  // body shares the create schema (start/duration required), so the client
  // queues start (Toggl's own timestamp, saved at entry creation) and the
  // title alongside stop — rebuilding the entry from the queue doc avoids a
  // GET on the /me endpoints, which have a strict 30/hour quota.
  const resp = await togglFetch(
    toggl.apiToken,
    "PUT",
    `/workspaces/${toggl.workspaceId}/time_entries/${item.entryId}`,
    body,
  );
  if (!resp.ok) {
    throw new Error(
      `Toggl stop-update failed with status ${resp.status}: ` +
        `${await resp.text()}`,
    );
  }
  return item.entryId;
}

// Syncs Toggl work queued while the client was offline. Firestore's offline
// persistence flushes the queue doc when connectivity returns, which fires
// this trigger — the write itself is the reconnect signal. onDocumentWritten
// (not onDocumentCreated) so a failed item can be re-run by setting status
// back to 'pending' with a new retryRequestedAt. The changed timestamp makes
// even a stale pending retry emit a production Firestore event. The claim
// transaction deduplicates concurrent deliveries. Create POSTs enter a
// terminal outcome-unknown state before the remote call, which also covers
// crashes after Toggl accepts the request. Every rules-permitted invocation,
// including malformed data, consumes the transactional per-user quota before
// remote work; server-owned expiry bounds terminal-row retention. Quota
// overflow leaves the row pending and throws so Eventarc redelivers it after
// backoff without spending a remote-attempt slot.
// timeoutSeconds leaves headroom for the 429 backoff; maxInstances limits
// reconnect bursts.
exports.syncqueue = onDocumentWritten(
  {
    document: "users/{uid}/togglQueue/{queueId}",
    region: "europe-west1",
    timeoutSeconds: 120,
    maxInstances: 5,
    serviceAccount: FUNCTIONS_RUNTIME_SERVICE_ACCOUNT,
    ingressSettings: EVENT_INGRESS,
    // Also retries malformed quota documents until an operator repairs them;
    // the pending queue row stays intact instead of being discarded.
    retry: true,
  },
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists || after.data()?.status !== "pending") {
      return;
    }

    const quotaRef = db.doc(
      `users/${event.params.uid}/functionQuotas/togglQueue`,
    );
    const claim = await db.runTransaction<
      | {status: "claimed"; item: TogglQueueDocument; token: QueueClaimToken}
      | {status: "deferred"}
      | {status: "malformed"; error: string}
      | null
    >(async (tx) => {
      const snap = await tx.get(after.ref);
      if (!snap.exists) return null;
      const data = snap.data();
      if (!data || data.status !== "pending") return null;
      const now = Timestamp.now();
      const expiresAt = queueExpiry(now);
      const quotaSnap = await tx.get(quotaRef);
      const quota = quotaSnap.exists ? decodeQueueQuota(quotaSnap.data()) : null;
      if (quota !== null &&
          quota.windowStartedAt.toMillis() >
            now.toMillis() - TOGGL_QUEUE_WINDOW_MS &&
          quota.count >= TOGGL_QUEUE_LIMIT) {
        return {status: "deferred"};
      }

      let current: TogglQueueDocument;
      try {
        current = decodeTogglQueueDocument(data);
      } catch (error) {
        const raw = errorMessage(error);
        // Decode failure must not re-arm TTL on a correlated stop. Raw
        // identity is enough to preserve the only recovery handle; the row
        // remains operator-visible even if a future decoder rejects a shape
        // that an earlier release wrote.
        const malformedExpiry = data.type === "stop" &&
            data.timerClaimVersion === 1 &&
            typeof data.bookId === "string" ?
          FieldValue.delete() : expiresAt;
        if (quota === null || quota.windowStartedAt.toMillis() <=
            now.toMillis() - TOGGL_QUEUE_WINDOW_MS) {
          tx.set(quotaRef, {windowStartedAt: now, count: 1});
        } else {
          tx.update(quotaRef, {count: quota.count + 1});
        }
        tx.update(after.ref, {
          status: "error",
          attempts: MAX_QUEUE_ATTEMPTS,
          claimedAt: now,
          expiresAt: malformedExpiry,
          error: `Malformed queue item: ${raw}`.slice(0, 1000),
          retryRequestedAt: FieldValue.delete(),
        });
        return {status: "malformed", error: raw};
      }
      if (current.status !== "pending") return null;
      // A correlated v1 stop row is the only client recovery handle while
      // its book and lifecycle remain in `stopping`. Never let Firestore TTL
      // delete that handle. Successful stops delete the row explicitly, and
      // confirmed recovery does the same after clearing the claim.
      const retainedExpiry = current.type === "stop" &&
          current.timerClaimVersion === 1 && current.bookId !== undefined ?
        FieldValue.delete() : expiresAt;
      if (current.attempts >= MAX_QUEUE_ATTEMPTS) {
        tx.update(after.ref, {
          status: "error",
          claimedAt: current.claimedAt ?? now,
          expiresAt: retainedExpiry,
          error: "Queue retry limit reached.",
          retryRequestedAt: FieldValue.delete(),
        });
        return null;
      }
      if (quota === null || quota.windowStartedAt.toMillis() <=
          now.toMillis() - TOGGL_QUEUE_WINDOW_MS) {
        tx.set(quotaRef, {windowStartedAt: now, count: 1});
      } else {
        tx.update(quotaRef, {count: quota.count + 1});
      }
      // claimedAt lets the client sweep distinguish a live invocation from
      // a dead one; attempts caps how often a poison item is retried.
      tx.update(after.ref, {
        status: "processing",
        claimedAt: now,
        expiresAt: retainedExpiry,
        attempts: current.attempts + 1,
        error: FieldValue.delete(),
        retryRequestedAt: FieldValue.delete(),
      });
      return {
        status: "claimed",
        item: current,
        token: {attempts: current.attempts + 1, claimedAt: now},
      };
    });
    if (claim === null) return;
    if (claim.status === "deferred") throw new QueueQuotaDeferredError();
    if (claim.status === "malformed") throw new Error(claim.error);
    const claimedItem = claim.item;

    let entryId: number;
    try {
      entryId = await syncQueueItem(
        event.params.uid,
        claimedItem,
        after.ref,
      );
    } catch (error) {
      // Persist the failure so it is visible in the queue doc (and can be
      // retried by flipping status back to 'pending') instead of leaving
      // the item claimed forever, then rethrow so the error is logged.
      const raw = errorMessage(error);
      await after.ref.update({
        status: error instanceof OutcomeUnknownError ?
          "outcome-unknown" : "error",
        error: raw.slice(0, 1000),
        retryRequestedAt: FieldValue.delete(),
      });
      // Also record it durably where the admin overview looks: a sync that
      // exhausts its retries otherwise only surfaces if the user notices.
      // The raw message can carry the book title — the malformed-item dump
      // below includes it, and a Toggl error body echoes back the
      // description field it was sent — so it is stripped before landing in
      // a log the operator reads. The untouched message still goes to the
      // queue doc, which only its owner can read, and to the function log.
      const title = claimedItem.bookTitle;
      await logIssue({
        level: "error",
        event: "toggl.sync_failed",
        message: (title.length > 0 ? raw.replaceAll(title, "<title>") : raw)
          .slice(0, 1000),
        uid: event.params.uid,
      });
      throw error;
    }
    if (claimedItem.type === "stop" && claimedItem.bookId !== undefined &&
        claimedItem.timerClaimVersion === 1) {
      const queueBookId = claimedItem.bookId;
      const bookRef = db.doc(
        `users/${event.params.uid}/books/${queueBookId}`,
      );
      const claimRef = db.doc(
        `users/${event.params.uid}/timerLifecycle/current`,
      );
      const expectedClaim: TimerClaim = {
        version: 1,
        state: "stopping",
        bookId: queueBookId,
        entryId: claimedItem.entryId,
        start: claimedItem.start,
        queueId: event.params.queueId,
      };
      const syncedExpiry = queueExpiry(Timestamp.now());
      try {
        await db.runTransaction(async (tx) => {
          const [queueSnap, bookSnap, claimSnap] = await Promise.all([
            tx.get(after.ref),
            tx.get(bookRef),
            tx.get(claimRef),
          ]);
          if (!queueSnap.exists || !bookSnap.exists || !claimSnap.exists) {
            throw new Error("Toggl stop queue lost its correlated timer state.");
          }
          const timer = decodeActiveTimerFromBook(bookSnap.data());
          const lifecycle = decodeTimerClaim(claimSnap.data());
          if (!timerMatchesClaim(queueBookId, timer, expectedClaim) ||
              lifecycle.state === "idle" ||
              !timerMatchesClaim(queueBookId, timer, lifecycle)) {
            throw new Error("Toggl stop queue no longer matches the active timer claim.");
          }
          tx.update(after.ref, {
            status: "synced",
            entryId,
            expiresAt: syncedExpiry,
            error: FieldValue.delete(),
            retryRequestedAt: FieldValue.delete(),
          });
          tx.update(bookRef, {activeTimer: null});
          tx.set(claimRef, {version: 1, state: "idle", cleared: lifecycle});
        });
      } catch (error) {
        // The remote PUT has already succeeded, so an automatic retry could
        // repeat a completed write. Preserve the known entry id and move the
        // queue to an owner-visible retry state before Eventarc redelivers it.
        const raw = errorMessage(error);
        const title = claimedItem.bookTitle;
        const issue = {
          level: "error",
          event: "toggl.sync_failed",
          message: (title.length > 0 ? raw.replaceAll(title, "<title>") : raw)
            .slice(0, 1000),
          uid: event.params.uid,
        } as const;
        try {
          const marked = await markCorrelatedStopFailure(
            after.ref,
            claim.token,
            entryId,
            raw,
          );
          if (!marked) {
            // A lost commit acknowledgement can make the correlation
            // transaction throw even though it committed the synced row.
            // Confirm that exact terminal result before treating the stop as
            // successful; a newer worker or different entry still fails.
            const live = await after.ref.get();
            const value = live.data();
            if (live.exists && value?.status === "synced" &&
                value.entryId === entryId) {
              await after.ref.delete();
              return;
            }
          }
        } catch (recoveryError) {
          // Recovery storage failure must not replace the correlation error
          // or suppress its durable operator signal.
          console.error("Failed to persist Toggl stop recovery state.", recoveryError);
        }
        try {
          await logIssue(issue);
        } catch (loggingError) {
          console.error("Failed to persist Toggl sync failure issue.", loggingError);
        }
        throw error;
      }
    } else {
      await after.ref.update({
        status: "synced",
        entryId,
        error: FieldValue.delete(),
        retryRequestedAt: FieldValue.delete(),
      });
    }
    await after.ref.delete();
  });
