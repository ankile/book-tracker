import * as functions from "firebase-functions/v1";
import {getFirestore} from "firebase-admin/firestore";
import {Buffer} from "node:buffer";

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

async function togglFetch(
  token: string,
  method: string,
  path: string,
  body?: object,
): Promise<Response> {
  return await fetch(TOGGL_BASE + path, {
    method,
    headers: {
      "Authorization":
        "Basic " + Buffer.from(`${token}:api_token`).toString("base64"),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
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
