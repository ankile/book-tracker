import { Buffer } from "node:buffer";
import { env } from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const TOGGL_BASE = "https://api.track.toggl.com/api/v9";
const PROJECT_NAME = "Reading";

const EMULATOR_WORKSPACE_ID = 900001;
const EMULATOR_PROJECT_ID = 900002;
const EMULATOR_ENTRY_ID = 900003;
const EMULATOR_STOP_DURATION_SECONDS = 60;

function emulatorJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
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
    return emulatorJson({ id: 1 });
  }
  if (method === "GET" && path === "/me/projects") {
    return emulatorJson([
      {
        id: EMULATOR_PROJECT_ID,
        workspace_id: EMULATOR_WORKSPACE_ID,
        name: PROJECT_NAME,
      },
    ]);
  }

  const timeEntryPath =
    /^\/workspaces\/\d+\/time_entries(?:\/(\d+)(?:\/stop)?)?$/;
  const match = timeEntryPath.exec(path);
  if (method === "POST" && match !== null && match[1] === undefined) {
    if (
      body === undefined ||
      !("start" in body) ||
      typeof body.start !== "string"
    ) {
      return emulatorJson({ error: "start is required" }, 400);
    }
    return emulatorJson({ id: EMULATOR_ENTRY_ID, start: body.start });
  }
  if (
    method === "PATCH" &&
    match?.[1] !== undefined &&
    path.endsWith("/stop")
  ) {
    return emulatorJson({ duration: EMULATOR_STOP_DURATION_SECONDS });
  }
  if (method === "PUT" && match?.[1] !== undefined) {
    return emulatorJson({ id: Number(match[1]) });
  }

  const existingEntry = /^\/me\/time_entries\/(\d+)$/.exec(path);
  if (method === "GET" && existingEntry !== null) {
    return emulatorJson({
      id: Number(existingEntry[1]),
      duration: EMULATOR_STOP_DURATION_SECONDS,
    });
  }
  return emulatorJson(
    { error: `No Toggl emulator route for ${method} ${path}` },
    501,
  );
}

export async function togglFetch(
  token: string,
  method: string,
  path: string,
  body?: object,
): Promise<Response> {
  if (env.FUNCTIONS_EMULATOR === "true") {
    return emulatorTogglFetch(method, path, body);
  }
  const doFetch = () =>
    fetch(TOGGL_BASE + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization:
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
