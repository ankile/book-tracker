require("./setup.cts");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const {readdirSync, readFileSync}: typeof import("node:fs") = require("node:fs");
const {join}: typeof import("node:path") = require("node:path");
const test: typeof import("node:test").test = require("node:test");
const {logger}: typeof import("firebase-functions") = require("firebase-functions");

const deployed = require("../lib");

// SEC-014 monitor phase. The appcheck.monitor line is the evidence the
// enforcement flip stands on, so these tests check the line itself: it
// fires before any auth check (a scripted caller with no account must
// still be counted), and it distinguishes a request that carried a valid
// App Check token from one that did not.

function captureInfo(t: import("node:test").TestContext): unknown[][] {
  const lines: unknown[][] = [];
  t.mock.method(logger, "info", (...args: unknown[]) => lines.push(args));
  return lines;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}

test("a callable without an App Check token logs appcheck.monitor missing, before auth", async (t) => {
  const lines = captureInfo(t);
  await assert.rejects(
    deployed.toggl.start.run({bookId: "b1"}, {auth: undefined}),
    (error) => hasCode(error, "unauthenticated"),
  );
  const monitor = lines.filter(([event]) => event === "appcheck.monitor");
  assert.deepEqual(monitor, [["appcheck.monitor", {fn: "toggl.start", token: "missing"}]]);
});

test("a callable with an App Check token logs appcheck.monitor present", async (t) => {
  const lines = captureInfo(t);
  await assert.rejects(
    deployed.telemetry.reportissue.run({}, {auth: undefined, app: {appId: "1:440931185227:web:app"}}),
    (error) => hasCode(error, "unauthenticated"),
  );
  const monitor = lines.filter(([event]) => event === "appcheck.monitor");
  assert.deepEqual(monitor, [["appcheck.monitor", {fn: "telemetry.reportissue", token: "present"}]]);
});

// Source pin: a new callable that forgets the monitor line would silently
// fall out of the evidence the enforcement decision reads. Every
// https.onCall handler body must call logAppCheckPresence before anything
// else, and each call site must name its own function.
test("every https.onCall handler starts with logAppCheckPresence", () => {
  const sourceDir = join(__dirname, "..", "src");
  const names = [];
  const wrappedNames = [];
  let handlers = 0;
  for (const file of readdirSync(sourceDir).filter((f) => f.endsWith(".ts"))) {
    const source = readFileSync(join(sourceDir, file), "utf8");
    const pattern = /\.https\.onCall\(async \([^)]*\)(?:: [^=]*)? => \{\s*(\w+)\((?:"([^"]+)"|(\w+)), context\);/g;
    const total = source.split(".https.onCall(").length - 1;
    let matched = 0;
    for (const match of source.matchAll(pattern)) {
      assert.equal(match[1], "logAppCheckPresence", `${file}: handler opens with ${match[1]}`);
      if (match[2] !== undefined) names.push(match[2]);
      else assert.equal(match[3], "endpointName", `${file}: dynamic monitor name is pinned by its wrapper`);
      matched += 1;
    }
    for (const match of source.matchAll(/adminCallable(?:<[^>]+>)?\(\s*"([^"]+)"/g)) {
      wrappedNames.push(match[1]);
    }
    assert.equal(matched, total, `${file}: ${total} onCall handlers, ${matched} open with logAppCheckPresence`);
    handlers += total;
  }
  assert.equal(handlers, 12, "twelve callable handler implementations carry the monitor line");
  assert.equal(wrappedNames.length, 3, "all three admin callables pin their monitor names at the wrapper call site");
  const deployedNames = [...names, ...wrappedNames];
  assert.equal(deployedNames.length, 14, "all fourteen deployed callables are named for monitoring");
  assert.equal(new Set(deployedNames).size, deployedNames.length, "each callable names its own function");
});
