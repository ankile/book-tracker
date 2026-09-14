import { env } from "node:process";
import {
  decodeTimeTrackingRequest,
  decodeTimeTrackingResponse,
  TIME_TRACKING_ACTIONS,
} from "./shared/time-tracking-api";
import type {
  TimeTrackingHttpResult,
  TimeTrackingRequest,
} from "./shared/time-tracking-api";

export function threeggleEndpoint(): URL | null {
  const configured = env.THREEGGLE_API_URL;
  const localMode = env.THREEGGLE_LOCAL_MODE;
  if (env.FUNCTIONS_EMULATOR === "true" && localMode !== "isolated") {
    if (configured || localMode)
      throw new Error("Emulator Threeggle requires explicit isolated mode.");
    return null;
  }
  if (!configured)
    throw new Error("Threeggle endpoint has not been configured.");
  const url = new URL(configured);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/api/time-tracking/v1"
  ) {
    throw new Error("Invalid Threeggle endpoint.");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (env.FUNCTIONS_EMULATOR === "true") {
    if (!loopback || url.protocol !== "http:" || !url.port)
      throw new Error("Isolated emulator must use a loopback backend.");
  } else if (
    localMode ||
    url.protocol !== "https:" ||
    loopback ||
    url.hostname === "localhost" ||
    /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)
  ) {
    throw new Error("Production Threeggle requires a public HTTPS endpoint.");
  }
  return url;
}

// Default emulator requests cannot leave this process. Full integration
// tests explicitly opt into a fresh, isolated local backend.
function stub(request: TimeTrackingRequest): TimeTrackingHttpResult {
  if (request.action === "context")
    return {
      status: 200,
      response: {
        apiVersion: 1,
        ok: true,
        result: {
          serviceId: "book-tracker-emulator",
          accountId: "emulator-account",
          actions: [...TIME_TRACKING_ACTIONS],
          serverTime: Date.now(),
          current: null,
          readiness: "ready",
          limits: {
            maxIntervalDurationMs: 2678400000,
            maxOverlapReadDocuments: 256,
          },
        },
      },
    };
  if (request.action === "projects")
    return {
      status: 200,
      response: {
        apiVersion: 1,
        ok: true,
        result: { projects: [{ id: "emulator-reading", name: "Reading" }] },
      },
    };
  return {
    status: 503,
    retryAfter: 30,
    response: {
      apiVersion: 1,
      ok: false,
      error: {
        code: "index_not_ready",
        message: "Use the isolated local backend to test timer writes.",
      },
    },
  };
}

export async function threeggleRequest(
  token: string,
  request: TimeTrackingRequest,
): Promise<TimeTrackingHttpResult> {
  const url = threeggleEndpoint();
  if (url === null) return stub(request);
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(decodeTimeTrackingRequest(request)),
  });
  if (!response.body) throw new Error("Threeggle returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 262144) {
      await reader.cancel();
      throw new Error("Threeggle response exceeds the size limit.");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const decoded = decodeTimeTrackingResponse(body);
  if (!decoded || decoded.ok !== response.ok)
    throw new Error("Threeggle returned an invalid response.");
  const retryHeader = response.headers.get("Retry-After");
  const seconds =
    retryHeader !== null && /^\d+$/.test(retryHeader)
      ? Number(retryHeader)
      : 30;
  return {
    status: response.status,
    response: decoded,
    retryAfter: Math.min(3600, Math.max(1, seconds)),
  };
}
