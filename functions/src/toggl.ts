import * as functions from "firebase-functions/v1";
import {getFirestore, Timestamp} from "firebase-admin/firestore";
import {Buffer} from "node:buffer";
import {setTimeout as delay} from "node:timers/promises";

const db = getFirestore();

const TOGGL_BASE = "https://api.track.toggl.com/api/v9";
const PROJECT_NAME = "Reading";

interface TogglConfig {
  apiToken: string;
  workspaceId: number;
  projectId: number;
}

interface TogglProject {
  id: number;
  workspace_id: number;
  name: string;
}

interface TogglTimeEntry {
  id: number;
  start: string;
  duration: number;
}

interface TogglQueueItem {
  type: "create" | "stop";
  stop: string;
  bookTitle?: string;
  start?: string;
  entryId?: number;
}

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
  const toggl = userSnap.data()?.toggl as TogglConfig | undefined;
  if (!toggl) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Add your Toggl API token on the Me page first.",
    );
  }
  return toggl;
}

exports.savetoken = functions
  .region("europe-west1")
  .https.onCall(async (data: {token: string}, context) => {
    const uid = requireUid(context);
    const {token} = data;

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
    const projects = await projectsResp.json() as TogglProject[];
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
        workspaceId: project.workspace_id,
        projectId: project.id,
      },
    }, {merge: true});

    return {workspaceId: project.workspace_id, projectId: project.id};
  });

exports.start = functions
  .region("europe-west1")
  .https.onCall(async (data: {bookId: string}, context) => {
    const uid = requireUid(context);
    const toggl = await getTogglConfig(uid);

    const bookRef = db.doc(`users/${uid}/books/${data.bookId}`);
    const bookSnap = await bookRef.get();
    if (!bookSnap.exists) {
      throw new functions.https.HttpsError("not-found", "Book not found.");
    }
    const book = bookSnap.data() as {title: string; activeTimer?: object};
    if (book.activeTimer) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "A timer is already running for this book.",
      );
    }

    const resp = await togglFetch(
      toggl.apiToken,
      "POST",
      `/workspaces/${toggl.workspaceId}/time_entries`,
      {
        created_with: "book-tracker",
        description: book.title,
        project_id: toggl.projectId,
        workspace_id: toggl.workspaceId,
        start: new Date().toISOString(),
        duration: -1,
      },
    );
    if (!resp.ok) {
      throw new Error(
        `Toggl start failed with status ${resp.status}: ${await resp.text()}`,
      );
    }
    const entry = await resp.json() as TogglTimeEntry;

    await bookRef.update({
      activeTimer: {entryId: entry.id, start: entry.start},
    });

    return {entryId: entry.id, start: entry.start};
  });

exports.stop = functions
  .region("europe-west1")
  .https.onCall(async (data: {bookId: string}, context) => {
    const uid = requireUid(context);

    const bookRef = db.doc(`users/${uid}/books/${data.bookId}`);
    const bookSnap = await bookRef.get();
    const activeTimer = bookSnap.data()?.activeTimer as
      {entryId: number; start: string} | undefined;
    if (!activeTimer) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "No timer running for this book.",
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
      const entry = await stopResp.json() as TogglTimeEntry;
      seconds = entry.duration;
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
      const entry = await entryResp.json() as TogglTimeEntry;
      seconds = entry.duration;
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
  item: TogglQueueItem,
): Promise<number> {
  const toggl = await getTogglConfig(uid);

  if (typeof item.bookTitle !== "string" || typeof item.start !== "string" ||
      typeof item.stop !== "string") {
    throw new Error(`malformed queue item: ${JSON.stringify(item)}`);
  }
  let duration = secs(item.stop) - secs(item.start);
  if (item.type === "stop") {
    // A 'stop' item mixes clocks: start is Toggl's server timestamp,
    // stop is the device clock. A device clock a few seconds slow would
    // make the interval non-positive, and throwing here would strand the
    // Toggl entry running forever — clamp to one second instead.
    duration = Math.max(1, duration);
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
    const postResp = await togglFetch(
      toggl.apiToken,
      "POST",
      `/workspaces/${toggl.workspaceId}/time_entries`,
      body,
    );
    if (!postResp.ok) {
      throw new Error(
        `Toggl create failed with status ${postResp.status}: ` +
          `${await postResp.text()}`,
      );
    }
    return ((await postResp.json()) as TogglTimeEntry).id;
  }

  if (item.type !== "stop" || typeof item.entryId !== "number") {
    throw new Error(`malformed queue item: ${JSON.stringify(item)}`);
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
// this trigger — the write itself is the reconnect signal. onWrite (not
// onCreate) so a failed item can be re-run by setting status back to
// 'pending', which the client's retryStalledTogglSync sweep does on app
// load (the rules only permit the owner that exact status flip); the
// transactional claim below makes at-least-once event delivery safe
// against duplicate Toggl entries.
exports.syncqueue = functions
  .region("europe-west1")
  .firestore.document("users/{uid}/togglQueue/{queueId}")
  .onWrite(async (change, context) => {
    if (!change.after.exists || change.after.data()?.status !== "pending") {
      return null;
    }

    const claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(change.after.ref);
      if (snap.data()?.status !== "pending") return false;
      // claimedAt lets the client sweep distinguish a live invocation from
      // a dead one; attempts caps how often a poison item is retried.
      tx.update(change.after.ref, {
        status: "processing",
        claimedAt: Timestamp.now(),
        attempts: (snap.data()?.attempts ?? 0) + 1,
      });
      return true;
    });
    if (!claimed) return null;

    const item = change.after.data() as TogglQueueItem;
    let entryId: number;
    try {
      entryId = await syncQueueItem(context.params.uid, item);
    } catch (error) {
      // Persist the failure so it is visible in the queue doc (and can be
      // retried by flipping status back to 'pending') instead of leaving
      // the item claimed forever, then rethrow so the error is logged.
      await change.after.ref.update({
        status: "error",
        error: (error as Error).message,
      });
      throw error;
    }
    await change.after.ref.update({status: "synced", entryId});
    return null;
  });
