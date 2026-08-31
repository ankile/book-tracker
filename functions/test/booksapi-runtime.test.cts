require("./setup.cts");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test").test = require("node:test");
const {getFirestore}: typeof import("firebase-admin/firestore") = require("firebase-admin/firestore");

type TestContext = import("node:test").TestContext;
type Quota = Record<string, unknown> | undefined;
type UserData = Record<string, unknown> | undefined;
interface TransactionStub {
  get(ref: object): Promise<{data(): Quota}>;
  set(ref: object, value: Record<string, unknown>): void;
  update(ref: object, patch: Record<string, unknown>): void;
}
interface Deployed {
  booksapi: {
    lookupisbn: {
      run(data: unknown, context: unknown): Promise<{
        volume: import("../src/decoders").GoogleVolumeInfo | null;
      }>;
    };
  };
}

process.env.FUNCTIONS_CONFIG_EXPORT = JSON.stringify({
  booksapi: {url: "https://books.example/volumes", key: "secret"},
});

const deployed: Deployed = require("../lib");
const db = getFirestore();
const authContext = {auth: {uid: "owner", token: {email_verified: true}}};

function snapshot(data: Quota): {data(): Quota} {
  return {data: () => data};
}

function installQuotaStore(
  t: TestContext,
  userData: UserData = {},
): {quota(): Quota; userReads(): number} {
  const quotaRef = {};
  let quota: Quota;
  let userReads = 0;
  t.mock.method(db, "collection", (name: string) => {
    assert.equal(name, "users");
    return {doc: (uid: string) => {
      assert.equal(uid, "owner");
      return {get: async () => {
        userReads += 1;
        return {
          exists: userData !== undefined,
          get: (field: string) => userData?.[field],
        };
      }};
    }};
  });
  t.mock.method(db, "doc", (path: string) => {
    assert.equal(path, "users/owner/functionQuotas/booksApi");
    return quotaRef;
  });
  t.mock.method(db, "runTransaction", async (handler: (transaction: TransactionStub) => Promise<unknown>) => handler({
    get: async (ref: object) => {
      assert.equal(ref, quotaRef);
      return snapshot(quota);
    },
    set: (ref: object, value: Record<string, unknown>) => {
      assert.equal(ref, quotaRef);
      quota = value;
    },
    update: (ref: object, patch: Record<string, unknown>) => {
      assert.equal(ref, quotaRef);
      quota = {...quota, ...patch};
    },
  }));
  return {quota: () => quota, userReads: () => userReads};
}

test("lookupisbn rejects unverified and deleted accounts before quota or fetch", async (t) => {
  const store = installQuotaStore(t, {deletedAt: {seconds: 1}});
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run");
  });
  await assert.rejects(
    deployed.booksapi.lookupisbn.run(
      {isbn: "9780000000002"},
      {auth: {uid: "owner", token: {email_verified: false}}},
    ),
    (error) => hasCode(error, "failed-precondition") && messageMatches(error, /Verify your email/),
  );
  assert.equal(store.userReads(), 0);
  await assert.rejects(
    deployed.booksapi.lookupisbn.run({isbn: "9780000000002"}, authContext),
    (error) => hasCode(error, "failed-precondition") &&
      messageMatches(error, /account has been deleted/),
  );
  assert.equal(store.userReads(), 1);
  assert.equal(store.quota(), undefined);
  assert.equal(fetchCalls, 0);
});

test("lookupisbn returns sanitized partial metadata", async (t) => {
  const quota = installQuotaStore(t);
  let requestedUrl: string | URL | Request | undefined;
  t.mock.method(global, "fetch", async (url: string | URL | Request) => {
    requestedUrl = url;
    return new Response(JSON.stringify({
      totalItems: 1,
      items: [{
        volumeInfo: {
          title: "The Book",
          authors: ["Ada", "", 7],
          pageCount: 0,
          publisher: null,
        },
      }],
    }), {status: 200});
  });

  assert.deepEqual(
    await deployed.booksapi.lookupisbn.run(
      {isbn: "9780000000002"},
      authContext,
    ),
    {volume: {title: "The Book", authors: ["Ada"], pageCount: 0}},
  );
  assert.equal(
    requestedUrl,
    "https://books.example/volumes?key=secret&q=isbn:9780000000002&country=NO",
  );
  assert.equal(quota.quota()?.count, 1);
});

test("lookupisbn retries transient Google Books failures without charging quota again", async (t) => {
  const quota = installQuotaStore(t);
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    if (fetchCalls < 3) {
      return new Response("temporarily unavailable", {status: 503});
    }
    return new Response(JSON.stringify({
      totalItems: 1,
      items: [{
        volumeInfo: {
          title: "Life",
          authors: ["Keith Richards", "James Fox"],
          pageCount: 576,
          imageLinks: {thumbnail: "http://books.example/life.jpg"},
        },
      }],
    }), {status: 200});
  });

  assert.deepEqual(
    await deployed.booksapi.lookupisbn.run(
      {isbn: "9780316034418"},
      authContext,
    ),
    {volume: {
      title: "Life",
      authors: ["Keith Richards", "James Fox"],
      pageCount: 576,
      imageLinks: {thumbnail: "http://books.example/life.jpg"},
    }},
  );
  assert.equal(fetchCalls, 3);
  assert.equal(quota.quota()?.count, 1);
});

test("lookupisbn does not retry a non-transient Google Books rejection", async (t) => {
  const quota = installQuotaStore(t);
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    return new Response("forbidden", {status: 403});
  });

  await assert.rejects(
    deployed.booksapi.lookupisbn.run(
      {isbn: "9780316034418"},
      authContext,
    ),
    (error) => hasCode(error, "internal"),
  );
  assert.equal(fetchCalls, 1);
  assert.equal(quota.quota()?.count, 1);
});

test("lookupisbn stops after four transient Google Books failures", async (t) => {
  const quota = installQuotaStore(t);
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    return new Response("temporarily unavailable", {status: 503});
  });

  await assert.rejects(
    deployed.booksapi.lookupisbn.run(
      {isbn: "9780316034418"},
      authContext,
    ),
    (error) => hasCode(error, "unavailable"),
  );
  assert.equal(fetchCalls, 4);
  assert.equal(quota.quota()?.count, 1);
});

test("the Functions emulator returns a local miss without outbound fetch", async (t) => {
  const previous = process.env.FUNCTIONS_EMULATOR;
  process.env.FUNCTIONS_EMULATOR = "true";
  t.after(() => {
    if (previous === undefined) {
      delete process.env.FUNCTIONS_EMULATOR;
    } else {
      process.env.FUNCTIONS_EMULATOR = previous;
    }
  });
  const quota = installQuotaStore(t);
  t.mock.method(global, "fetch", async () => {
    throw new Error("The Functions emulator must not call Google Books.");
  });

  assert.deepEqual(
    await deployed.booksapi.lookupisbn.run(
      {isbn: "9780000000002"},
      authContext,
    ),
    {volume: null},
  );
  assert.equal(quota.quota()?.count, 1);
});

test("lookupisbn enforces the per-user hourly quota before fetch", async (t) => {
  installQuotaStore(t);
  let fetchCalls = 0;
  t.mock.method(global, "fetch", async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({totalItems: 0}), {status: 200});
  });

  for (let index = 0; index < 60; index += 1) {
    assert.deepEqual(
      await deployed.booksapi.lookupisbn.run(
        {isbn: "9780000000002"},
        authContext,
      ),
      {volume: null},
    );
  }
  await assert.rejects(
    deployed.booksapi.lookupisbn.run(
      {isbn: "9780000000002"},
      authContext,
    ),
    (error) => hasCode(error, "resource-exhausted"),
  );
  assert.equal(fetchCalls, 60);
});

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}

function messageMatches(error: unknown, pattern: RegExp): boolean {
  return error instanceof Error && pattern.test(error.message);
}
