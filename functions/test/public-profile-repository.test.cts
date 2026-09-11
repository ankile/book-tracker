require("./setup.cts");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const {readFileSync}: typeof import("node:fs") = require("node:fs");
const {join}: typeof import("node:path") = require("node:path");
const shell = readFileSync(join(__dirname, "..", "assets", "profile-shell.html"), "utf8");
const test: typeof import("node:test").test = require("node:test");
const {Timestamp}: typeof import("firebase-admin/firestore") = require("firebase-admin/firestore");
const {createPublicProfileReader}: typeof import("../src/publicProfileRepository") = require("../lib/publicProfileRepository");
type Client = import("../src/publicProfileRepository").ProfileReadClient;
type Event = import("../src/publicProfileRepository").ProfileReadDiagnostic;

function fake(getDocument: Client["getDocument"]): Client {
  return {initialize: async () => undefined, getProjectId: async () => "demo-test", getDocument};
}

test("point reads use an actual three-second RPC deadline with retries disabled", async () => {
  const calls: unknown[] = [];
  const reader = createPublicProfileReader(fake(async (request, options) => {
    calls.push({request, options});
    return [{fields: {public: {booleanValue: true}}}];
  }), {onDiagnostic: () => {}});
  assert.deepEqual(await reader.getProfile("example"), {public: true});
  assert.deepEqual(await reader.getDiscovery("example"), {public: true});
  assert.deepEqual(calls, ["profiles", "profileDiscovery"].map(collection => ({
    request: {name: `projects/demo-test/databases/(default)/documents/${collection}/example`},
    options: {timeout: 3000, retry: null},
  })));
});

test("wire fields retain nested objects, scalar values and nanosecond Timestamp types", async () => {
  const reader = createPublicProfileReader(fake(async () => [{fields: {
    empty: {nullValue: 0}, text: {stringValue: ""}, flag: {booleanValue: false},
    number: {integerValue: "42"}, fraction: {doubleValue: 0.25},
    timestamp: {timestampValue: {seconds: "1788674400", nanos: 123456789}},
    nested: {mapValue: {fields: {items: {arrayValue: {values: [
      {mapValue: {fields: {count: {integerValue: "2"}}}}, {arrayValue: {}},
    ]}}}}},
  }}]), {onDiagnostic: () => {}});
  assert.deepEqual(await reader.getProfile("example"), {
    empty: null, text: "", flag: false, number: 42, fraction: 0.25,
    timestamp: new Timestamp(1788674400, 123456789), nested: {items: [{count: 2}, []]},
  });
});

test("only NOT_FOUND maps to null; error logging excludes paths and raw messages", async () => {
  const events: Event[] = [];
  let code = 5;
  const error = () => Object.assign(new Error("secret-path/token/value"), {code});
  const reader = createPublicProfileReader(fake(async () => {throw error();}), {
    onDiagnostic: event => events.push(event),
  });
  assert.equal(await reader.getProfile("private-username"), null);
  for (code of [4, 7, 14]) await assert.rejects(reader.getDiscovery("private-username"), {code});
  assert.equal(events.length, 4);
  assert.equal(JSON.stringify(events).includes("private-username"), false);
  assert.equal(JSON.stringify(events).includes("secret"), false);
  assert.deepEqual(events.map(event => [event.operation, event.outcome, event.errorCode]), [
    ["profile", "missing", 5], ["discovery", "error", 4],
    ["discovery", "error", 7], ["discovery", "error", 14],
  ]);
});

export type {};

test("established stalled RPC is cancelled once at the deadline, without retries", async t => {
  const grpc: typeof import("@grpc/grpc-js") = require("@grpc/grpc-js");
  const {v1}: typeof import("@google-cloud/firestore") = require("@google-cloud/firestore");
  const server = new grpc.Server();
  t.after(() => server.forceShutdown());
  let calls = 0;
  let cancelled = 0;
  const identity = (value: Buffer) => value;
  server.addService({getDocument: {
    path: "/google.firestore.v1.Firestore/GetDocument", requestStream: false, responseStream: false,
    requestSerialize: identity, requestDeserialize: identity,
    responseSerialize: identity, responseDeserialize: identity,
  }}, {getDocument(call: import("@grpc/grpc-js").ServerUnaryCall<Buffer, Buffer>) {
    calls++;
    call.on("cancelled", () => cancelled++);
  }});
  const port = await new Promise<number>((resolve, reject) => server.bindAsync(
    "127.0.0.1:0", grpc.ServerCredentials.createInsecure(),
    (error, boundPort) => error ? reject(error) : resolve(boundPort),
  ));
  const client = new v1.FirestoreClient({
    apiEndpoint: "127.0.0.1", port, sslCreds: grpc.credentials.createInsecure(), projectId: "demo-test",
  });
  t.after(() => client.close());
  const events: Event[] = [];
  const reader = createPublicProfileReader(client, {timeoutMs: 150, onDiagnostic: event => events.push(event)});
  const start = performance.now();
  await assert.rejects(reader.getProfile("example"), {code: 4});
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
  assert.ok(performance.now() - start < 2000);
  assert.equal(events[0].errorCode, 4);
});

test("protobuf default fields inherited from prototypes are not mistaken for selected values", async () => {
  const value = Object.assign(Object.create({nullValue: 0, booleanValue: false}), {stringValue: "example"});
  const reader = createPublicProfileReader(fake(async () => [{fields: {name: value}}]), {onDiagnostic: () => {}});
  assert.deepEqual(await reader.getProfile("example"), {name: "example"});
});

test("discovery decoder accepts converted timestamp and missing document fields remain invalid", async () => {
  const {decodeProfileDiscoveryMarker}: typeof import("../src/decoders") = require("../lib/decoders");
  const reader = createPublicProfileReader(fake(async () => [{fields: {
    uid: {stringValue: "owner"}, createdAt: {timestampValue: {seconds: "1788674400", nanos: 123}},
  }}]), {onDiagnostic: () => {}});
  assert.deepEqual(decodeProfileDiscoveryMarker(await reader.getDiscovery("example")), {
    uid: "owner", createdAt: new Timestamp(1788674400, 123),
  });
  const malformed = createPublicProfileReader(fake(async () => [{}]), {onDiagnostic: () => {}});
  assert.throws(() => decodeProfileDiscoveryMarker({}));
  assert.deepEqual(await malformed.getProfile("example"), {});
});

test("initialization errors rethrow while unsupported wire values are diagnosed as invalid", async () => {
  const events: Event[] = [];
  const initializationError = Object.assign(new Error("secret"), {code: 5});
  const initializing = createPublicProfileReader({
    initialize: async () => undefined,
    getProjectId: async () => {throw initializationError;},
    getDocument: async () => {throw new Error("unreachable");},
  }, {onDiagnostic: event => events.push(event)});
  await assert.rejects(initializing.getProfile("example"), initializationError);
  const malformed = createPublicProfileReader(fake(async () => [{fields: {invalid: {}}}]), {
    onDiagnostic: event => events.push(event),
  });
  assert.equal(await malformed.getProfile("example"), null);
  assert.deepEqual(events.map(event => [event.phase, event.outcome]), [["initialization", "error"], ["decode", "invalid"]]);
});

for (const pendingStage of ["project", "client"] as const) {
  test(`aborted ${pendingStage} initialization cannot start an RPC after it settles`, async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => {release = resolve;});
    let reads = 0;
    const controller = new AbortController();
    const reason = new Error("application deadline");
    const reader = createPublicProfileReader({
      getProjectId: async () => {if (pendingStage === "project") await pending; return "demo-test";},
      initialize: async () => {if (pendingStage === "client") await pending;},
      getDocument: async () => {reads++; return [{}];},
    }, {onDiagnostic: () => {}});
    const operation = reader.getProfile("example", controller.signal);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(reason);
    release();
    await assert.rejects(operation, reason);
    assert.equal(reads, 0);
  });
}

test("converted public profile is identical to the domain decoder's stored fixture", async () => {
  const {decodePublicProfile}: typeof import("../src/decoders") = require("../lib/decoders");
  const stored = {
    uid: "owner", public: true, givenName: "Ada", familyName: "Lovelace",
    links: [{type: "homepage", value: "https://example.com"}],
    stats: {totalBooks: 12, finishedBooks: 10, readingBooks: 2, totalTimeReadHours: 80,
      totalPagesRead: 3200, booksPerYear: 8.5, avgTimePerBook: 480, authors: 9},
    records: null, years: [{year: 2026, count: 10, hours: 80, pages: 3200}],
    days: [{day: "2026-08-20", pagesRead: 120, timeRead: 95, sessions: 1}],
    updatedAt: new Timestamp(1788674400, 123),
  };
  type Wire = NonNullable<Awaited<ReturnType<Client["getDocument"]>>[0]["fields"]>[string];
  function wire(value: unknown): Wire {
    if (value === null) return {nullValue: 0};
    if (typeof value === "boolean") return {booleanValue: value};
    if (typeof value === "string") return {stringValue: value};
    if (typeof value === "number") return {doubleValue: value};
    if (value instanceof Timestamp) return {timestampValue: {seconds: value.seconds, nanos: value.nanoseconds}};
    if (Array.isArray(value)) return {arrayValue: {values: value.map(wire)}};
    assert.equal(typeof value, "object");
    return {mapValue: {fields: Object.fromEntries(Object.entries(value as object).map(([key, item]) => [key, wire(item)]))}};
  }
  const document = {fields: Object.fromEntries(Object.entries(stored).map(([key, item]) => [key, wire(item)]))};
  const reader = createPublicProfileReader(fake(async () => [document]), {onDiagnostic: () => {}});
  assert.deepEqual(decodePublicProfile("example", await reader.getProfile("example")), decodePublicProfile("example", stored));
});

for (const invalid of [{bytesValue: Buffer.from("private")}, {referenceValue: "projects/demo-test/databases/(default)/documents/users/private"}]) {
  test("unsupported stored field types preserve malformed-profile and discovery response semantics", async () => {
    const {resolvePublicWebRequest}: typeof import("../src/publicWeb") = require("../lib/publicWeb");
    const events: Event[] = [];
    const reader = createPublicProfileReader(fake(async () => [{fields: {
      public: {booleanValue: true}, unsupported: invalid,
    }}]), {onDiagnostic: event => events.push(event)});
    assert.equal(await reader.getProfile("example"), null);
    assert.equal(await reader.getDiscovery("example"), null);
    const response = await resolvePublicWebRequest({method: "GET", path: "/profiles/example"}, {
      ...reader, listDiscoveries: async () => [],
    }, shell);
    assert.equal(response.status, 404);
    assert.ok(events.every(event => event.outcome === "invalid"));
  });
}

test("a settled initialization failure discards its poisoned client and the next read recovers", async () => {
  const {createLazyPublicProfileReader}: typeof import("../src/publicProfileRepository") = require("../lib/publicProfileRepository");
  let clients = 0;
  let closed = 0;
  const failedInitialization = Promise.reject(Object.assign(new Error("unavailable"), {code: 14}));
  failedInitialization.catch(() => undefined);
  const reader = createLazyPublicProfileReader(() => {
    clients++;
    const first = clients === 1;
    return {
      ...fake(async () => [{fields: {public: {booleanValue: true}}}]),
      initialize: () => first ? failedInitialization : Promise.resolve(),
      close: async () => {closed++;},
    };
  }, {onDiagnostic: () => {}});
  await assert.rejects(reader.getProfile("example"), {code: 14});
  assert.deepEqual(await reader.getProfile("example"), {public: true});
  assert.equal(clients, 2);
  assert.equal(closed, 1);
});

test("aborting unresolved initialization keeps its client owned until settlement", async () => {
  const {createLazyPublicProfileReader}: typeof import("../src/publicProfileRepository") = require("../lib/publicProfileRepository");
  let clients = 0;
  let reads = 0;
  let release!: () => void;
  const initializing = new Promise<void>(resolve => {release = resolve;});
  const reader = createLazyPublicProfileReader(() => {
    clients++;
    return {...fake(async () => {reads++; return [{}];}), initialize: () => initializing};
  }, {onDiagnostic: () => {}});
  const controller = new AbortController();
  const first = reader.getProfile("example", controller.signal);
  const rejection = assert.rejects(first);
  await new Promise(setImmediate);
  controller.abort();
  const second = reader.getDiscovery("example");
  assert.equal(clients, 1);
  release();
  await rejection;
  await second;
  assert.equal(clients, 1);
  assert.equal(reads, 1);
});

test("diagnostic sink failures cannot replace successful data or the original RPC error", async () => {
  const onDiagnostic = () => {throw new Error("logging failed");};
  const reader = createPublicProfileReader(fake(async () => [{fields: {public: {booleanValue: true}}}]), {onDiagnostic});
  assert.deepEqual(await reader.getProfile("example"), {public: true});
  const error = Object.assign(new Error("unavailable"), {code: 14});
  const failing = createPublicProfileReader(fake(async () => {throw error;}), {onDiagnostic});
  await assert.rejects(failing.getProfile("example"), error);
});

test("a settled project-ID failure discards its cached rejection and permits recovery", async () => {
  const {createLazyPublicProfileReader}: typeof import("../src/publicProfileRepository") = require("../lib/publicProfileRepository");
  let clients = 0;
  const failure = Promise.reject(Object.assign(new Error("metadata unavailable"), {code: 14}));
  failure.catch(() => undefined);
  const reader = createLazyPublicProfileReader(() => {
    clients++;
    const first = clients === 1;
    return {...fake(async () => [{}]), getProjectId: () => first ? failure : Promise.resolve("demo-test")};
  }, {onDiagnostic: () => {}});
  await assert.rejects(reader.getProfile("example"), {code: 14});
  assert.deepEqual(await reader.getProfile("example"), {});
  assert.equal(clients, 2);
});

test("default client uses the configured Firestore emulator without production credentials", async t => {
  const {createPublicProfileClient}: typeof import("../src/publicProfileRepository") = require("../lib/publicProfileRepository");
  const grpc: typeof import("@grpc/grpc-js") = require("@grpc/grpc-js");
  const server = new grpc.Server();
  t.after(() => server.forceShutdown());
  let calls = 0;
  let requestBytes: Buffer = Buffer.alloc(0);
  const identity = (value: Buffer) => value;
  server.addService({getDocument: {
    path: "/google.firestore.v1.Firestore/GetDocument", requestStream: false, responseStream: false,
    requestSerialize: identity, requestDeserialize: identity,
    responseSerialize: identity, responseDeserialize: identity,
  }}, {getDocument(call: import("@grpc/grpc-js").ServerUnaryCall<Buffer, Buffer>, callback: import("@grpc/grpc-js").sendUnaryData<Buffer>) {
    calls++;
    requestBytes = call.request;
    callback({code: grpc.status.NOT_FOUND, message: "synthetic missing document"});
  }});
  const port = await new Promise<number>((resolve, reject) => server.bindAsync(
    "127.0.0.1:0", grpc.ServerCredentials.createInsecure(),
    (error, boundPort) => error ? reject(error) : resolve(boundPort),
  ));
  const originalHost = process.env.FIRESTORE_EMULATOR_HOST;
  t.after(() => {process.env.FIRESTORE_EMULATOR_HOST = originalHost;});
  process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${port}`;
  const client = createPublicProfileClient();
  t.after(() => client.close());
  // Check containment before any API call: a regression must not contact production.
  // The generated apiEndpoint getter reports its default even with an override.
  // Inspect construction settings only in this test before allowing the RPC.
  const configuration: unknown = Reflect.get(client, "_opts");
  assert.ok(configuration !== null && typeof configuration === "object" && "apiEndpoint" in configuration);
  assert.equal(configuration.apiEndpoint, "127.0.0.1");
  const reader = createPublicProfileReader(client, {onDiagnostic: () => {}});
  assert.equal(await reader.getProfile("example"), null);
  assert.equal(calls, 1);
  assert.ok(requestBytes.includes(Buffer.from("projects/demo-book-tracker-test/databases/(default)/documents/profiles/example")));
});

test("unset emulator host retains ordinary production client configuration without connecting", async t => {
  const {createPublicProfileClient}: typeof import("../src/publicProfileRepository") = require("../lib/publicProfileRepository");
  const originalHost = process.env.FIRESTORE_EMULATOR_HOST;
  t.after(() => {process.env.FIRESTORE_EMULATOR_HOST = originalHost;});
  delete process.env.FIRESTORE_EMULATOR_HOST;
  const client = createPublicProfileClient();
  t.after(() => client.close());
  const configuration: unknown = Reflect.get(client, "_opts");
  assert.ok(configuration !== null && typeof configuration === "object");
  assert.equal("sslCreds" in configuration, false);
  assert.equal(client.apiEndpoint, "firestore.googleapis.com");
});

test("malformed emulator endpoint fails before client creation instead of using production", t => {
  const {createPublicProfileClient}: typeof import("../src/publicProfileRepository") = require("../lib/publicProfileRepository");
  const originalHost = process.env.FIRESTORE_EMULATOR_HOST;
  t.after(() => {process.env.FIRESTORE_EMULATOR_HOST = originalHost;});
  for (const host of ["http://127.0.0.1:8080", "127.0.0.1", "127.0.0.1:65536", "127.0.0.1:0"]) {
    process.env.FIRESTORE_EMULATOR_HOST = host;
    assert.throws(createPublicProfileClient, /FIRESTORE_EMULATOR_HOST/);
  }
});
