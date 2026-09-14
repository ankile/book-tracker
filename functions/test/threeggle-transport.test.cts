require("./setup.cts");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { test, afterEach }: typeof import("node:test") = require("node:test");
const {
  threeggleEndpoint,
  threeggleRequest,
}: typeof import("../src/threeggleTransport") = require("../lib/threeggleTransport");
const saved = { ...process.env };
afterEach(() => {
  for (const key of [
    "FUNCTIONS_EMULATOR",
    "THREEGGLE_LOCAL_MODE",
    "THREEGGLE_API_URL",
  ]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});
function isolated() {
  process.env.FUNCTIONS_EMULATOR = "true";
  process.env.THREEGGLE_LOCAL_MODE = "isolated";
  process.env.THREEGGLE_API_URL = "http://127.0.0.1:3321/api/time-tracking/v1";
}
test("emulator defaults to a no-network stub and rejects accidental production configuration", async () => {
  process.env.FUNCTIONS_EMULATOR = "true";
  delete process.env.THREEGGLE_LOCAL_MODE;
  delete process.env.THREEGGLE_API_URL;
  assert.equal(threeggleEndpoint(), null);
  assert.equal(
    (
      await threeggleRequest("synthetic", {
        client: "book-tracker",
        action: "context",
      })
    ).status,
    200,
  );
  process.env.THREEGGLE_API_URL = "https://example.com/api/time-tracking/v1";
  assert.throws(threeggleEndpoint);
  isolated();
  assert.equal(threeggleEndpoint()?.port, "3321");
  for (const url of [
    "http://localhost:3321/api/time-tracking/v1",
    "https://example.com/api/time-tracking/v1",
    "http://127.0.0.1:3321/api/time-tracking/v1?token=x",
    "http://user:pass@127.0.0.1:3321/api/time-tracking/v1",
  ]) {
    process.env.THREEGGLE_API_URL = url;
    assert.throws(threeggleEndpoint);
  }
});
test("production accepts only configured HTTPS and never local modes or IP endpoints", () => {
  delete process.env.FUNCTIONS_EMULATOR;
  delete process.env.THREEGGLE_LOCAL_MODE;
  for (const url of [
    "http://example.com/api/time-tracking/v1",
    "https://127.0.0.1/api/time-tracking/v1",
    "https://[::1]/api/time-tracking/v1",
    "https://localhost/api/time-tracking/v1",
    "https://192.168.1.1/api/time-tracking/v1",
  ]) {
    process.env.THREEGGLE_API_URL = url;
    assert.throws(threeggleEndpoint);
  }
  process.env.THREEGGLE_API_URL = "https://example.com/api/time-tracking/v1";
  assert.equal(threeggleEndpoint()?.protocol, "https:");
  process.env.THREEGGLE_LOCAL_MODE = "isolated";
  assert.throws(threeggleEndpoint);
});
test("transport freezes canonical bytes, refuses redirects and bounds response bodies", async (t) => {
  isolated();
  let sent: RequestInit | undefined;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init?: RequestInit) => {
      sent = init;
      return new Response(
        JSON.stringify({
          apiVersion: 1,
          ok: false,
          error: { code: "rate_limited", message: "Retry later." },
        }),
        { status: 429, headers: { "Retry-After": "12" } },
      );
    },
  );
  const result = await threeggleRequest("synthetic", {
    action: "context",
    client: "book-tracker",
  });
  assert.equal(sent?.redirect, "error");
  assert.ok(sent?.signal);
  assert.equal(
    sent?.body,
    JSON.stringify({ client: "book-tracker", action: "context" }),
  );
  assert.equal(result.retryAfter, 12);
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("x".repeat(262145)),
  );
  await assert.rejects(
    threeggleRequest("synthetic", {
      client: "book-tracker",
      action: "context",
    }),
    /size limit/,
  );
});

test("timer issue projection excludes descriptions, snapshots, tokens and raw errors", () => {
  require("../lib");
  const {
    timerFailureIssue,
  }: typeof import("../src/timeTrackingQueue") = require("../lib/timeTrackingQueue");
  const {
    initialQueue,
  }: typeof import("../src/shared/timeTracking") = require("../lib/shared/timeTracking");
  const row = initialQueue(
    {
      version: 2,
      action: "stop",
      operationId: "11111111-1111-4111-8111-111111111111",
      timerId: "22222222-2222-4222-8222-222222222222",
      bookId: "private-book",
      connection: {
        provider: "threeggle",
        revision: "r",
        serviceId: "s",
        accountId: "a",
        projectId: "p",
      },
      start: "2026-09-13T12:00:00.000Z",
      end: "2026-09-13T13:00:00.000Z",
      description: "PRIVATE TITLE",
      remote: null,
    },
    1,
  );
  row.errorCode = "PRIVATE RAW ERROR";
  const issue = timerFailureIssue(row);
  const serialized = JSON.stringify(issue);
  assert.equal(serialized.includes("PRIVATE"), false);
  assert.equal(serialized.includes("private-book"), false);
  assert.equal(issue.code, "unknown");
  const {
    decodeIssueReport,
  }: typeof import("../src/decoders") = require("../lib/decoders");
  assert.throws(() => decodeIssueReport(issue));
});
