import * as functions from "firebase-functions/v1";
import {onDocumentWritten} from "firebase-functions/v2/firestore";
import {
  DocumentReference,
  FieldValue,
  getFirestore,
  Timestamp,
} from "firebase-admin/firestore";
import {Buffer} from "node:buffer";
import {randomUUID} from "node:crypto";
import {setTimeout as delay} from "node:timers/promises";
import {logIssue} from "./logging";
import {
  ActiveTimer,
  decodeActiveTimerFromBook,
  decodeBookCallableRequest,
  decodeBookForTimer,
  decodeCreatedTogglEntryId,
  decodeSaveTokenRequest,
  decodeStartedTogglEntry,
  decodeStoppedTogglDuration,
  decodeTogglConfig,
  decodeTogglProjects,
  decodeTogglQueueDocument,
  TogglConfig,
  TogglQueueDocument,
  TogglQueuePayload,
} from "./decoders";

const db = getFirestore();

const TOGGL_BASE = "https://api.track.toggl.com/api/v9";
const PROJECT_NAME = "Reading";

const MAX_QUEUE_ATTEMPTS = 5;
const START_CLAIM_STALE_MS = 5 * 60 * 1000;

const invalidArgument = (message: string): never => {
  throw new functions.https.HttpsError("invalid-argument", message);
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class OutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutcomeUnknownError";
  }
}

type StartClaimResult =
  | {status: "claimed"; title: string}
  | {status: "recovered-unknown"};

async function togglFetch(
  token: string,
  method: string,
  path: string,
  body?: object,
): Promise<Response> {
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
  const toggl = userSnap.data()?.toggl;
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

exports.savetoken = functions
  .region("europe-west1")
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

    await db.doc(`users/${uid}`).set({
      toggl: {
        apiToken: token,
        workspaceId: project.workspaceId,
        projectId: project.id,
      },
    }, {merge: true});

    return {workspaceId: project.workspaceId, projectId: project.id};
  });

exports.start = functions
  .region("europe-west1")
  .https.onCall(async (data: unknown, context) => {
    const uid = requireUid(context);
    const {bookId} = decodeBookCallableRequest(data, invalidArgument);
    const toggl = await getTogglConfig(uid);

    const bookRef = db.doc(`users/${uid}/books/${bookId}`);
    const booksRef = db.collection(`users/${uid}/books`);
    const operationId = randomUUID();
    const requestedStart = new Date().toISOString();
    const claimedAt = Timestamp.now();
    const claim = await db.runTransaction<StartClaimResult>(async (tx) => {
      // Read the whole user's book set before writing the claim. Every start
      // transaction therefore locks every existing target book, including
      // calls racing on different books/devices. The library is small and a
      // timer start is rare, so the read cost buys one authoritative
      // user-wide timer invariant without a second lifecycle document.
      const booksSnap = await tx.get(booksRef);
      const bookSnap = booksSnap.docs.find((snap) => snap.id === bookId);
      if (!bookSnap) {
        throw new functions.https.HttpsError("not-found", "Book not found.");
      }
      const book = decodeBookForTimer(bookSnap.data());
      const activeBooks = booksSnap.docs.flatMap((snap) => {
        const activeTimer = decodeActiveTimerFromBook(snap.data());
        return activeTimer === null ? [] : [{snap, activeTimer}];
      });
      const staleStarts = activeBooks.filter(({activeTimer}) =>
        "state" in activeTimer && activeTimer.state === "starting" &&
        activeTimer.claimedAt.toMillis() < Date.now() - START_CLAIM_STALE_MS,
      );
      if (staleStarts.length > 0) {
        for (const {snap, activeTimer} of staleStarts) {
          if (!("state" in activeTimer) || activeTimer.state !== "starting") {
            throw new Error("Stale-start filter returned a non-starting timer.");
          }
          tx.update(snap.ref, {
            activeTimer: {
              ...activeTimer,
              state: "outcome-unknown",
              error: "The Toggl start invocation ended before it confirmed " +
                "the remote timer. Check Toggl before clearing this state.",
            },
          });
        }
        return {status: "recovered-unknown"};
      }
      if (activeBooks.length > 0) {
        const requestedTimer = book.activeTimer;
        const message = requestedTimer && "state" in requestedTimer ?
          requestedTimer.state === "starting" ?
            "A Toggl timer start is already in progress for this book." :
            "The previous Toggl timer start has an unknown outcome. " +
              "Check Toggl before clearing it." :
          requestedTimer ?
            "A timer is already running for this book." :
            "A timer is already running for another book.";
        throw new functions.https.HttpsError("failed-precondition", message);
      }
      tx.update(bookRef, {
        activeTimer: {
          state: "starting",
          operationId,
          start: requestedStart,
          claimedAt,
        },
      });
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
      await transitionStartClaim(bookRef, operationId, {
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
      await transitionStartClaim(bookRef, operationId, null);
      throw new Error(
        `Toggl start failed with status ${resp.status}.`,
      );
    }

    let entry: {id: number; start: string};
    try {
      const entryData: unknown = await resp.json();
      entry = decodeStartedTogglEntry(entryData);
    } catch (error) {
      await transitionStartClaim(bookRef, operationId, {
        state: "outcome-unknown",
        operationId,
        start: requestedStart,
        claimedAt,
        error: `Toggl created a timer but its response was invalid: ${
          errorMessage(error)}`.slice(0, 1000),
      });
      throw error;
    }

    const finalized = await transitionStartClaim(bookRef, operationId, {
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
  operationId: string,
  replacement: ActiveTimer | null,
): Promise<boolean> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(bookRef);
    if (!snap.exists) return false;
    const current = decodeActiveTimerFromBook(snap.data());
    if (!current || !("state" in current) ||
        current.state !== "starting" || current.operationId !== operationId) {
      return false;
    }
    tx.update(bookRef, {activeTimer: replacement});
    return true;
  });
}

exports.stop = functions
  .region("europe-west1")
  .https.onCall(async (data: unknown, context) => {
    const uid = requireUid(context);
    const {bookId} = decodeBookCallableRequest(data, invalidArgument);

    const bookRef = db.doc(`users/${uid}/books/${bookId}`);
    const bookSnap = await bookRef.get();
    if (!bookSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Book not found.");
    }
    const activeTimer = decodeActiveTimerFromBook(bookSnap.data());
    if (!activeTimer || !("entryId" in activeTimer)) {
      const message = activeTimer && "state" in activeTimer ?
        activeTimer.state === "starting" ?
          "The Toggl timer is still starting." :
          "The Toggl timer start has an unknown outcome. Check Toggl first." :
        "No Toggl-backed timer is running for this book.";
      throw new functions.https.HttpsError(
        "failed-precondition",
        message,
      );
    }

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
      await bookRef.update({activeTimer: null});
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

    await bookRef.update({activeTimer: null});

    return {seconds, minutes: Math.max(1, Math.round(seconds / 60))};
  });

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
      throw new Error(
        `Toggl create failed with status ${postResp.status}.`,
      );
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
// crashes after Toggl accepts the request. timeoutSeconds leaves headroom for
// the 429 backoff; maxInstances limits reconnect bursts.
exports.syncqueue = onDocumentWritten(
  {
    document: "users/{uid}/togglQueue/{queueId}",
    region: "europe-west1",
    timeoutSeconds: 120,
    maxInstances: 5,
  },
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists || after.data()?.status !== "pending") {
      return;
    }

    let pendingItem: TogglQueueDocument;
    try {
      pendingItem = decodeTogglQueueDocument(after.data());
    } catch (error) {
      const message = `Malformed queue item: ${errorMessage(error)}`
        .slice(0, 1000);
      await after.ref.update({
        status: "error",
        attempts: MAX_QUEUE_ATTEMPTS,
        claimedAt: Timestamp.now(),
        error: message,
        retryRequestedAt: FieldValue.delete(),
      });
      throw error;
    }
    if (pendingItem.status !== "pending") return;

    const claimedItem = await db.runTransaction(async (tx) => {
      const snap = await tx.get(after.ref);
      if (!snap.exists) return null;
      const current = decodeTogglQueueDocument(snap.data());
      if (current.status !== "pending") return null;
      if (current.attempts >= MAX_QUEUE_ATTEMPTS) {
        tx.update(after.ref, {
          status: "error",
          claimedAt: current.claimedAt ?? Timestamp.now(),
          error: "Queue retry limit reached.",
          retryRequestedAt: FieldValue.delete(),
        });
        return null;
      }
      // claimedAt lets the client sweep distinguish a live invocation from
      // a dead one; attempts caps how often a poison item is retried.
      tx.update(after.ref, {
        status: "processing",
        claimedAt: Timestamp.now(),
        attempts: current.attempts + 1,
        error: FieldValue.delete(),
        retryRequestedAt: FieldValue.delete(),
      });
      return current;
    });
    if (claimedItem === null) return;

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
    await after.ref.update({
      status: "synced",
      entryId,
      error: FieldValue.delete(),
      retryRequestedAt: FieldValue.delete(),
    });
  });
