require("./setup.cts");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test").test = require("node:test");
const {getFirestore, Timestamp}: typeof import("firebase-admin/firestore") = require("firebase-admin/firestore");
const {logger}: typeof import("firebase-functions") = require("firebase-functions");

type TestContext = import("node:test").TestContext;
type Row = Record<string, unknown>;
interface Reference {
  path: string;
  id: string;
  get(): Promise<Snapshot>;
}
interface Snapshot {
  exists: boolean;
  id: string;
  ref: Reference;
  data(): Row | undefined;
  get(field: string): unknown;
  updateTime: import("firebase-admin/firestore").Timestamp | undefined;
}
interface QuerySnapshot {
  docs: Snapshot[];
  size: number;
}
type Filter = [field: string, operator: string, value: unknown];
interface Query {
  _query: true;
  name: string;
  collectionGroup: boolean;
  filters: Filter[];
  maximum: number;
  where(field: string, operator: string, value: unknown): Query;
  limit(maximum: number): Query;
  orderBy(): Query;
  startAfter(): Query;
  get(): Promise<QuerySnapshot>;
  doc?(id: string): Reference;
  add?(_data: Row): Promise<{id: string}>;
}
interface TransactionStub {
  get(value: Query | Reference): Promise<QuerySnapshot | Snapshot>;
  create(reference: Reference, data: Row): void;
  set(reference: Reference, data: Row, options?: {merge?: boolean}): void;
  delete(reference: Reference): void;
}
interface CatalogStore {
  rows: Map<string, Row>;
  ref(path: string): Reference;
  write(reference: Reference, data: Row, merge?: boolean): void;
}
interface PreviewResult {
  operationId: string;
  touchedDocuments: number;
  expected: {
    catalog: Array<{kind: string; exists: boolean}>;
    books: unknown[];
  };
  changes: Array<{kind: string; action: string; after: Row | null}>;
}
interface ApplyResult {
  operationId: string;
  applied: boolean;
  touchedDocuments: number;
}
interface ScanResult {
  authors: Array<{authorId: string}>;
  works: Array<{workId: string; linkedBookCount: number}>;
  editions: Array<{editionId: string}>;
  books: Array<{
    uid: string;
    bookId: string;
    isbn13: string | null;
    rawIsbn: string | null;
    pageCount: number | null;
  }>;
  findings: Array<{
    code: string;
    message: string;
    workIds: string[];
    books: Array<{uid: string; bookId: string}>;
  }>;
  bookCountsComplete: boolean;
}
interface Deployed {
  admin: {
    catalogapply: {run(data: unknown, context: unknown): Promise<ApplyResult>};
    catalogpreview: {run(data: unknown, context: unknown): Promise<PreviewResult>};
    catalogscan: {run(data: unknown, context: unknown): Promise<ScanResult>};
  };
}

const deployed: Deployed = require("../lib");
// After the bundle: catalog.js calls getFirestore() at load, which needs
// the app that ../lib initializes.
const {externalIndexId}: typeof import("../src/catalog") = require("../lib/catalog");
const {CATALOG_LIMITS}: typeof import("../src/catalogLimits") = require("../lib/catalogLimits");
const db = getFirestore();
const adminUid = "1Cf0CaNfgnVSvTrF5dYjzRd9Xri2";
const recentAdmin = () => ({
  auth: {
    uid: adminUid,
    token: {
      email_verified: true,
      auth_time: Math.floor(Date.now() / 1000),
    },
  },
});

test("the hidden admin gate and recent-auth check run before decoding or reads", async (t) => {
  let touched = false;
  t.mock.method(db, "collection", (name: string) => {
    touched = true;
    assert.equal(name, "users");
    return {doc: () => ({
      get: async () => ({exists: true, get: () => undefined}),
    })};
  });
  t.mock.method(logger, "warn", () => undefined);
  await assert.rejects(
    deployed.admin.catalogapply.run({attacker: true}, {
      auth: {uid: "stranger", token: {email_verified: true}},
    }),
    (error) => hasCode(error, "not-found"),
  );
  assert.equal(touched, false);
  await assert.rejects(
    deployed.admin.catalogapply.run({attacker: true}, {
      auth: {
        uid: adminUid,
        token: {
          email_verified: true,
          auth_time: Math.floor(Date.now() / 1000) - 901,
        },
      },
    }),
    (error) => hasCode(error, "failed-precondition") &&
      detail(error, "reason") === "recent-auth-required" &&
      detail(error, "maxAgeSeconds") === 900,
  );
  assert.equal(touched, true);
  touched = false;
  await assert.rejects(
    deployed.admin.catalogapply.run({attacker: true}, recentAdmin()),
    (error) => hasCode(error, "invalid-argument"),
  );
  assert.equal(touched, true);
});

function installCatalogStore(t: TestContext): CatalogStore {
  const rows = new Map<string, Row>();
  const references = new Map<string, Reference>();
  const updateTimes = new Map<string, import("firebase-admin/firestore").Timestamp>();
  let clock = 1;
  const snapshot = (reference: Reference): Snapshot => ({
    exists: rows.has(reference.path),
    id: reference.id,
    ref: reference,
    data: () => rows.get(reference.path),
    get: (field: string) => rows.get(reference.path)?.[field],
    updateTime: rows.has(reference.path) ? updateTimes.get(reference.path) : undefined,
  });
  const querySnapshot = (query: Query): QuerySnapshot => {
    const prefix = `${query.name}/`;
    const docs = [...rows.keys()].filter((path) => query.collectionGroup ?
      path.split("/").at(-2) === query.name : path.startsWith(prefix))
      .map((path) => ref(path))
      .filter((reference) => query.filters.every(([field, operator, value]) => {
        const actual = rows.get(reference.path)?.[field];
        if (operator === "==") return actual === value;
        if (operator === "in") {
          assert.ok(Array.isArray(value));
          return value.includes(actual);
        }
        if (operator === "array-contains") return Array.isArray(actual) && actual.includes(value);
        if (operator === "array-contains-any") {
          assert.ok(Array.isArray(value));
          return Array.isArray(actual) && value.some((candidate: unknown) => actual.includes(candidate));
        }
        assert.fail(`unsupported query operator ${operator}`);
      }))
      .slice(0, query.maximum)
      .map(snapshot);
    return {docs, size: docs.length};
  };
  const makeQuery = (name: string, collectionGroup = false): Query => {
    const query: Query = {
      _query: true,
      name,
      collectionGroup,
      filters: [],
      maximum: Infinity,
      where: (field: string, operator: string, value: unknown) => {
        query.filters.push([field, operator, value]);
        return query;
      },
      limit: (maximum: number) => {
        query.maximum = maximum;
        return query;
      },
      orderBy: () => query,
      startAfter: () => query,
      get: async () => querySnapshot(query),
    };
    return query;
  };
  const ref = (path: string): Reference => {
    const existing = references.get(path);
    if (existing !== undefined) return existing;
    const reference: Reference = {
      path,
      id: path.slice(path.lastIndexOf("/") + 1),
      get: async () => snapshot(reference),
    };
    references.set(path, reference);
    return reference;
  };
  const write = (reference: Reference, data: Row, merge = false): void => {
    rows.set(reference.path, merge ? {...rows.get(reference.path), ...data} : data);
    updateTimes.set(reference.path, Timestamp.fromMillis(clock++));
  };
  t.mock.method(db, "collection", (name: string) => {
    const query = makeQuery(name);
    query.doc = (id: string) => ref(`${name}/${id}`);
    if (name === "adminAudit") {
      query.add = async (data: Row) => {
        write(ref("adminAudit/view-audit"), data);
        return {id: "view-audit"};
      };
    }
    return query;
  });
  t.mock.method(db, "collectionGroup", (name: string) => makeQuery(name, true));
  t.mock.method(db, "doc", (path: string) => ref(path));
  t.mock.method(db, "getAll", async (...references: Reference[]) => references.map(snapshot));
  t.mock.method(db, "runTransaction", async (handler: (transaction: TransactionStub) => Promise<unknown>) => handler({
    get: async (value: Query | Reference) => "_query" in value ? querySnapshot(value) : snapshot(value),
    create: (reference: Reference, data: Row) => {
      assert.equal(rows.has(reference.path), false, reference.path);
      write(reference, data);
    },
    set: (reference: Reference, data: Row, options?: {merge?: boolean}) =>
      write(reference, data, options?.merge === true),
    delete: (reference: Reference) => {
      rows.delete(reference.path);
      updateTimes.delete(reference.path);
    },
  }));
  write(ref(`users/${adminUid}`), {uid: adminUid});
  const now = Timestamp.fromMillis(1000);
  write(ref("catalogAuthors/ada-author"), {
    canonicalName: "Ada Author", alternateNames: [], nameKeys: ["ada author"],
    sortName: "Author", kind: "person", status: "active", mergedFrom: [],
    createdAt: now, updatedAt: now,
  });
  return {rows, ref, write};
}

function activeWork(title: string, overrides: Row = {}): Row {
  const now = Timestamp.fromMillis(1000);
  return {
    canonicalTitle: title,
    alternateTitles: [],
    titleKeys: [title.toLowerCase().replace(/^the /, "")],
    authorIds: ["ada-author"],
    coverUrl: "",
    subjects: [],
    fiction: true,
    status: "active",
    mergedFrom: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function edition(workId: string, overrides: Row = {}): Row {
  const now = Timestamp.fromMillis(1000);
  return {
    workId,
    isbn13: null,
    title: "Edition Title",
    publisher: "",
    publishedDate: "",
    language: "en",
    translatorNames: [],
    format: "full",
    suggestedPageCount: 300,
    coverUrl: "",
    externalIds: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("preview is read-only and apply is one audited idempotent transaction", async (t) => {
  const store = installCatalogStore(t);
  const operation = {
    type: "createWork",
    workId: "new-work",
    status: "hidden",
    work: {
      canonicalTitle: "The New Work",
      alternateTitles: [],
      authorIds: ["ada-author"],
      coverUrl: "",
      subjects: [],
      fiction: true,
    },
    books: [],
  };
  const preview = await deployed.admin.catalogpreview.run(
    {operation},
    recentAdmin(),
  );
  assert.equal(store.rows.has("works/new-work"), false);
  assert.equal(preview.touchedDocuments, 3);
  assert.deepEqual(preview.expected.catalog.map(({kind, exists}) => [kind, exists]), [
    ["author", true],
    ["title-index", false],
    ["work", false],
  ]);
  assert.deepEqual(preview.expected.books, []);
  assert.equal(preview.changes.filter(({action}) => action === "create").length, 2);

  const request = {
    operationId: preview.operationId,
    operation,
    expected: preview.expected,
  };
  const first = await deployed.admin.catalogapply.run(request, recentAdmin());
  const second = await deployed.admin.catalogapply.run(request, recentAdmin());
  assert.deepEqual(first, {
    operationId: preview.operationId,
    applied: true,
    touchedDocuments: 3,
  });
  assert.deepEqual(second, first);
  assert.equal(store.rows.get("works/new-work")?.canonicalTitle, "The New Work");
  const audit = store.rows.get(`adminAudit/${preview.operationId}`);
  assert.ok(audit);
  assert.equal(audit.type, "catalog-mutation");
  assert.equal(audit.operationType, "createWork");
  assert.equal(audit.uid, adminUid);
  const beforeAfter = audit.beforeAfter;
  assert.ok(Array.isArray(beforeAfter));
  assert.equal(beforeAfter.some((row: unknown) => isRow(row) && row.kind === "work"), true);
  assert.doesNotMatch(JSON.stringify(audit), /session|currentPage|activeTimer|pagesRead/);
});

test("catalog creation stops at the scan capacity while repair edits remain available", async (t) => {
  const store = installCatalogStore(t);
  for (let index = 0; index < CATALOG_LIMITS.works; index += 1) {
    store.write(store.ref(`works/work-${index}`), activeWork(`Work ${index}`));
  }
  const create = {
    type: "createWork",
    workId: "over-capacity",
    status: "hidden",
    work: {
      canonicalTitle: "Over Capacity",
      alternateTitles: [],
      authorIds: ["ada-author"],
      coverUrl: "",
      subjects: [],
      fiction: true,
    },
    books: [],
  };
  await assert.rejects(
    deployed.admin.catalogpreview.run({operation: create}, recentAdmin()),
    (error) => hasCode(error, "resource-exhausted") &&
      detail(error, "reason") === "catalog-capacity" &&
      detail(error, "collection") === "works" && detail(error, "maximum") === CATALOG_LIMITS.works,
  );
  const repair = {
    type: "editWork",
    workId: "work-0",
    status: "active",
    work: {
      canonicalTitle: "Repaired Work",
      alternateTitles: [],
      authorIds: ["ada-author"],
      coverUrl: "",
      subjects: [],
      fiction: true,
    },
  };
  const preview = await deployed.admin.catalogpreview.run(
    {operation: repair}, recentAdmin(),
  );
  assert.equal(preview.changes.some(({kind}) => kind === "work"), true);
});

test("book relinking detects link races but ignores unrelated personal edits", async (t) => {
  const store = installCatalogStore(t);
  store.write(store.ref("works/target-work"), activeWork("Target Work"));
  store.write(store.ref("users/reader"), {uid: "reader"});
  const bookRef = store.ref("users/reader/books/book-one");
  store.write(bookRef, {
    owner: store.ref("users/reader"),
    title: "Personal title",
    updatedAt: Timestamp.fromMillis(100),
    workId: null,
    editionId: null,
    matchMethod: null,
    linkedAt: null,
  });
  const operation = {
    type: "linkBooks",
    books: [{uid: "reader", bookId: "book-one"}],
    target: {workId: "target-work", editionId: null},
  };
  const preview = await deployed.admin.catalogpreview.run({operation}, recentAdmin());
  store.write(bookRef, {title: "Edited after preview"}, true);
  await deployed.admin.catalogapply.run({
    operationId: preview.operationId,
    operation,
    expected: preview.expected,
  }, recentAdmin());
  assert.equal(store.rows.get(bookRef.path)?.title, "Edited after preview");
  assert.equal(store.rows.get(bookRef.path)?.workId, "target-work");

  const stalePreview = await deployed.admin.catalogpreview.run({operation}, recentAdmin());
  store.write(bookRef, {workId: "other-work"}, true);
  await assert.rejects(deployed.admin.catalogapply.run({
    operationId: stalePreview.operationId,
    operation,
    expected: stalePreview.expected,
  }, recentAdmin()), (error) => hasCode(error, "aborted") &&
    detail(error, "reason") === "stale-preview");
});

test("non-null admin links require a live self-owned book while unlink repairs remain available", async (t) => {
  const store = installCatalogStore(t);
  store.write(store.ref("works/target-work"), activeWork("Target Work"));
  const bookRef = store.ref("users/reader/books/book-one");
  store.write(bookRef, {workId: null, editionId: null, matchMethod: null, linkedAt: null});
  const link = {
    type: "linkBooks",
    books: [{uid: "reader", bookId: "book-one"}],
    target: {workId: "target-work", editionId: null},
  };
  await assert.rejects(
    deployed.admin.catalogpreview.run({operation: link}, recentAdmin()),
    (error) => hasCode(error, "failed-precondition") &&
      detail(error, "reason") === "catalog-invariant",
  );
  store.write(bookRef, {owner: store.ref("users/other")}, true);
  store.write(store.ref("users/reader"), {uid: "reader", deletedAt: Timestamp.fromMillis(1)});
  await assert.rejects(
    deployed.admin.catalogpreview.run({operation: link}, recentAdmin()),
    (error) => hasCode(error, "failed-precondition"),
  );
  const unlink = {...link, target: null};
  const preview = await deployed.admin.catalogpreview.run({operation: unlink}, recentAdmin());
  assert.equal(preview.changes[0].after?.workId, null);
});

// Catalog data is public whoever contributed it: any reader's book may seed
// a work and no sharing consent is involved. The stored shape is still the
// boundary: a work document carrying an unsupported field is refused.
test("any personal book seeds a work; unsupported stored work fields are rejected", async (t) => {
  const store = installCatalogStore(t);
  store.write(store.ref("users/reader"), {uid: "reader"});
  store.write(store.ref("users/reader/books/seed-book"), {
    owner: store.ref("users/reader"),
    title: "Seed",
    workId: null,
    editionId: null,
    matchMethod: null,
    linkedAt: null,
  });
  const create = {
    type: "createWork",
    workId: "reader-derived-work",
    status: "active",
    work: {
      canonicalTitle: "Reader Derived Work",
      alternateTitles: [],
      authorIds: ["ada-author"],
      coverUrl: "",
      subjects: [],
      fiction: true,
    },
    books: [{uid: "reader", bookId: "seed-book"}],
  };
  const created = await deployed.admin.catalogpreview.run({operation: create}, recentAdmin());
  assert.equal(created.changes.some(({kind}) => kind === "work"), true);
  assert.equal(created.expected.books.length, 1);

  store.write(store.ref("works/hidden-work"), activeWork("Hidden Work", {
    status: "hidden",
    unsupportedField: "rejected by assertStoredKeys",
  }));
  store.write(store.ref(`users/${adminUid}/books/operator-book`), {
    workId: "hidden-work",
    editionId: null,
    matchMethod: "admin",
    linkedAt: Timestamp.fromMillis(100),
  });
  const edit = {
    type: "editWork",
    workId: "hidden-work",
    status: "active",
    work: {
      canonicalTitle: "Hidden Work",
      alternateTitles: [],
      authorIds: ["ada-author"],
      coverUrl: "",
      subjects: [],
      fiction: true,
    },
  };
  await assert.rejects(
    deployed.admin.catalogpreview.run({operation: edit}, recentAdmin()),
    (error) => hasCode(error, "failed-precondition") &&
      detail(error, "reason") === "catalog-invariant" &&
      messageMatches(error, /unsupported field unsupportedField/),
  );
});

test("moving an edition atomically relinks its books and identifier indexes", async (t) => {
  const store = installCatalogStore(t);
  store.write(store.ref("works/old-work"), activeWork("Old Work"));
  store.write(store.ref("works/new-work"), activeWork("New Work"));
  store.write(store.ref("editions/shared-edition"), edition("old-work", {
    isbn13: "9780000000002",
    externalIds: {"google-books": "volume-one"},
  }));
  store.write(store.ref("isbnIndex/9780000000002"), {
    workId: "old-work",
    editionId: "shared-edition",
  });
  const externalId = externalIndexId({
    provider: "google-books",
    id: "volume-one",
  });
  store.write(store.ref(`externalIdIndex/${externalId}`), {
    workId: "old-work",
    editionId: "shared-edition",
    provider: "google-books",
    externalId: "volume-one",
  });
  const bookRef = store.ref("users/reader/books/linked-book");
  store.write(store.ref("users/reader"), {uid: "reader"});
  store.write(bookRef, {
    owner: store.ref("users/reader"),
    title: "Keep this title",
    updatedAt: Timestamp.fromMillis(50),
    workId: "old-work",
    editionId: "shared-edition",
    matchMethod: "catalog-choice",
    linkedAt: Timestamp.fromMillis(100),
  });
  const operation = {
    type: "upsertEdition",
    editionId: "shared-edition",
    workId: "new-work",
    edition: {
      isbn13: "9780000000002",
      title: "Edition Title",
      publisher: "",
      publishedDate: "",
      language: "en",
      translatorNames: [],
      format: "full",
      suggestedPageCount: 300,
      coverUrl: "",
      externalIds: {"google-books": "volume-one"},
    },
  };
  const preview = await deployed.admin.catalogpreview.run({operation}, recentAdmin());
  assert.equal(preview.expected.catalog.some(({kind}) => kind === "external-id"), true);
  assert.equal(preview.expected.books.length, 1);
  await deployed.admin.catalogapply.run({
    operationId: preview.operationId,
    operation,
    expected: preview.expected,
  }, recentAdmin());
  assert.equal(store.rows.get("editions/shared-edition")?.workId, "new-work");
  assert.deepEqual(store.rows.get(`externalIdIndex/${externalId}`), {
    workId: "new-work",
    editionId: "shared-edition",
    provider: "google-books",
    externalId: "volume-one",
  });
  assert.deepEqual(store.rows.get("isbnIndex/9780000000002"), {
    workId: "new-work",
    editionId: "shared-edition",
  });
  assert.equal(store.rows.get(bookRef.path)?.workId, "new-work");
  assert.equal(store.rows.get(bookRef.path)?.title, "Keep this title");
});

// Moving an edition between works, hidden or active, needs no consent:
// bibliographic data is public whoever contributed it.
test("moving an edition out of a hidden work needs no consent", async (t) => {
  const store = installCatalogStore(t);
  store.write(store.ref("works/hidden-work"), activeWork("Hidden Work", {status: "hidden"}));
  store.write(store.ref("works/public-work"), activeWork("Public Work"));
  store.write(store.ref("editions/moved-edition"), edition("hidden-work"));
  const operation = {
    type: "upsertEdition",
    editionId: "moved-edition",
    workId: "public-work",
    edition: {
      isbn13: null,
      title: "Edition Title",
      publisher: "",
      publishedDate: "",
      language: "en",
      translatorNames: [],
      format: "full",
      suggestedPageCount: 300,
      coverUrl: "",
      externalIds: {},
    },
  };
  const unlinked = await deployed.admin.catalogpreview.run({operation}, recentAdmin());
  assert.equal(unlinked.expected.books.length, 0);
  store.write(store.ref("users/reader"), {uid: "reader"});
  store.write(store.ref("users/reader/books/seed"), {
    owner: store.ref("users/reader"),
    workId: "hidden-work",
    editionId: "moved-edition",
    matchMethod: "catalog-choice",
    linkedAt: Timestamp.fromMillis(100),
  });
  const linked = await deployed.admin.catalogpreview.run({operation}, recentAdmin());
  assert.equal(linked.expected.books.length, 1);
});

test("moving an edition refuses a missing or foreign ISBN index", async (t) => {
  const store = installCatalogStore(t);
  store.write(store.ref("works/old-work"), activeWork("Old Work"));
  store.write(store.ref("works/new-work"), activeWork("New Work"));
  store.write(store.ref("editions/shared-edition"), edition("old-work", {
    isbn13: "9780000000002",
  }));
  const operation = {
    type: "upsertEdition",
    editionId: "shared-edition",
    workId: "new-work",
    edition: {
      isbn13: "9780000000002", title: "Edition Title",
      publisher: "", publishedDate: "", language: "en", translatorNames: [],
      format: "full", suggestedPageCount: 300, coverUrl: "", externalIds: {},
    },
  };
  await assert.rejects(
    deployed.admin.catalogpreview.run({operation}, recentAdmin()),
    (error) => hasCode(error, "failed-precondition") &&
      detail(error, "reason") === "catalog-invariant",
  );
  store.write(store.ref("isbnIndex/9780000000002"), {
    workId: "old-work", editionId: "another-edition",
  });
  await assert.rejects(
    deployed.admin.catalogpreview.run({operation}, recentAdmin()),
    (error) => hasCode(error, "failed-precondition") &&
      detail(error, "reason") === "catalog-invariant",
  );
});

test("hidden sources merge into an active target and redirect to it", async (t) => {
  const store = installCatalogStore(t);
  store.write(store.ref("works/target"), activeWork("Target"));
  store.write(store.ref("works/linked"), activeWork("Linked", {status: "hidden"}));
  store.write(store.ref("works/orphan"), activeWork("Orphan", {status: "hidden"}));
  store.write(store.ref("users/reader"), {uid: "reader"});
  store.write(store.ref("users/reader/books/linked-copy"), {
    owner: store.ref("users/reader"),
    workId: "linked", editionId: null, matchMethod: "isbn",
    linkedAt: Timestamp.fromMillis(1),
  });
  const preview = await deployed.admin.catalogpreview.run({operation: {
    type: "mergeWorks", sourceWorkIds: ["linked", "orphan"], targetWorkId: "target",
  }}, recentAdmin());
  const works = preview.changes
    .filter(({kind, action}) => kind === "work" && action === "update")
    .map((change) => [change.after?.canonicalTitle, change.after?.status, change.after?.mergedInto ?? null, change.after?.mergedFrom])
    .sort();
  assert.deepEqual(works, [
    ["Linked", "merged", "target", []],
    ["Orphan", "merged", "target", []],
    ["Target", "active", null, ["linked", "orphan"]],
  ]);
});

test("merging works keeps old personal links one-hop while moving editions and indexes", async (t) => {
  const store = installCatalogStore(t);
  store.write(store.ref("works/target-work"), activeWork("Target Work"));
  store.write(store.ref("works/source-work"), activeWork("Source Work"));
  store.write(store.ref("editions/source-edition"), edition("source-work", {
    isbn13: "9780000000002",
    externalIds: {"google-books": "source-volume"},
  }));
  store.write(store.ref("isbnIndex/9780000000002"), {
    workId: "source-work",
    editionId: "source-edition",
  });
  const externalId = externalIndexId({
    provider: "google-books",
    id: "source-volume",
  });
  store.write(store.ref(`externalIdIndex/${externalId}`), {
    workId: "source-work",
    editionId: "source-edition",
    provider: "google-books",
    externalId: "source-volume",
  });
  store.write(store.ref("users/reader/books/old-link"), {
    workId: "source-work",
    editionId: "source-edition",
    matchMethod: "catalog-choice",
    linkedAt: Timestamp.fromMillis(100),
  });
  const operation = {
    type: "mergeWorks",
    sourceWorkIds: ["source-work"],
    targetWorkId: "target-work",
  };
  const preview = await deployed.admin.catalogpreview.run({operation}, recentAdmin());
  await deployed.admin.catalogapply.run({
    operationId: preview.operationId,
    operation,
    expected: preview.expected,
  }, recentAdmin());
  assert.equal(store.rows.get("works/source-work")?.status, "merged");
  assert.equal(store.rows.get("works/source-work")?.mergedInto, "target-work");
  assert.deepEqual(store.rows.get("works/target-work")?.mergedFrom, ["source-work"]);
  assert.equal(store.rows.get("editions/source-edition")?.workId, "target-work");
  assert.equal(store.rows.get("isbnIndex/9780000000002")?.workId, "target-work");
  assert.equal(store.rows.get(`externalIdIndex/${externalId}`)?.workId, "target-work");
  assert.equal(store.rows.get("users/reader/books/old-link")?.workId, "source-work");
});

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null;
}

function hasCode(error: unknown, code: string): boolean {
  return isRow(error) && error.code === code;
}

function detail(error: unknown, key: string): unknown {
  if (!isRow(error) || !isRow(error.details)) return undefined;
  return error.details[key];
}

function messageMatches(error: unknown, pattern: RegExp): boolean {
  return error instanceof Error && pattern.test(error.message);
}

// The scan's link suggestions: "exact" means the complete normalized author
// identity agrees (the migration contract), and an ISBN-10 normalizes the
// same way the link/apply path normalizes it.
test("scan suggestions need the complete author set and read ISBN-10 books", async (t) => {
  const store = installCatalogStore(t);
  const now = Timestamp.fromMillis(2000);
  store.write(store.ref("catalogAuthors/grace-author"), {
    canonicalName: "Grace Author", alternateNames: ["G. Author"],
    nameKeys: ["grace author", "g author"],
    sortName: "Author", kind: "person", status: "active", mergedFrom: [],
    createdAt: now, updatedAt: now,
  });
  store.write(store.ref("works/pair-work"), activeWork("Pair Work", {
    authorIds: ["ada-author", "grace-author"],
  }));
  store.write(store.ref("editions/pair-edition"), edition("pair-work", {isbn13: "9780441478125"}));
  store.write(store.ref("isbnIndex/9780441478125"), {workId: "pair-work", editionId: "pair-edition"});
  store.write(store.ref("users/reader"), {uid: "reader"});
  const book = (id: string, overrides: Row): void => store.write(store.ref(`users/reader/books/${id}`), {
    title: "Pair Work", pageCount: 100, isbn: "",
    workId: null, editionId: null, matchMethod: null, linkedAt: null,
    createdAt: now, updatedAt: now, ...overrides,
  });
  book("partial", {authorIds: ["ada-author"]});
  book("complete", {authorIds: ["ada-author", "grace-author"]});
  book("superset", {authorIds: ["ada-author", "grace-author", "extra-author"]});
  book("isbn-ten", {title: "Some Other Title", isbn: "0-441-47812-3"});
  store.write(store.ref("catalogAuthors/extra-author"), {
    canonicalName: "Extra Author", alternateNames: [], nameKeys: ["extra author"],
    sortName: "Author", kind: "person", status: "active", mergedFrom: [],
    createdAt: now, updatedAt: now,
  });
  const scan = await deployed.admin.catalogscan.run({}, recentAdmin());
  const exact = scan.findings.filter(({code}) => code === "unmatched-title-author-candidate");
  assert.deepEqual(exact.map(({books, workIds}) => [books[0].bookId, workIds]), [["complete", ["pair-work"]]]);
  const isbnTen = scan.books.find(({bookId}) => bookId === "isbn-ten");
  assert.deepEqual({isbn13: isbnTen?.isbn13, rawIsbn: isbnTen?.rawIsbn}, {isbn13: "9780441478125", rawIsbn: null});
  assert.deepEqual(
    scan.findings.filter(({code}) => code === "unmatched-isbn-candidate").map(({books}) => books[0].bookId),
    ["isbn-ten"],
  );
});

// One malformed personal book is reported and dropped, not coerced into a
// plausible row: the console curates identity, and "(malformed title)" hid
// the corruption behind something that looked like data.
test("a malformed book row is reported and skipped", async (t) => {
  const store = installCatalogStore(t);
  store.write(store.ref("users/reader"), {uid: "reader"});
  const row = (title: unknown, extra: Row = {}): Row => ({
    owner: store.ref("users/reader"),
    title,
    pageCount: 100,
    workId: null,
    editionId: null,
    matchMethod: null,
    linkedAt: null,
    ...extra,
  });
  store.write(store.ref("users/reader/books/readable"), row("Readable"));
  store.write(store.ref("users/reader/books/untitled"), row(42));
  store.write(store.ref("users/reader/books/unlinkable"), row("Bad link", {
    matchMethod: "guessed",
  }));
  const scan = await deployed.admin.catalogscan.run({}, recentAdmin());
  assert.deepEqual(scan.books.map(({bookId}) => bookId), ["readable"]);
  const anomalies = scan.findings.filter(({code}) => code === "book-row-anomaly");
  assert.deepEqual(anomalies.map(({books}) => books[0].bookId).sort(), [
    "unlinkable", "untitled",
  ]);
  assert.equal(anomalies.some(({message}) => /title must be a non-empty string/.test(message)), true);
  assert.equal(anomalies.some(({message}) => /Invalid catalog link/.test(message)), true);
});

// A missing or nonsensical page count is a display gap, not a reason to
// drop the row (the client decoder used to refuse the whole page over it).
test("a book with no page count is still scanned", async (t) => {
  const store = installCatalogStore(t);
  store.write(store.ref("users/reader"), {uid: "reader"});
  store.write(store.ref("users/reader/books/no-pages"), {
    owner: store.ref("users/reader"),
    title: "No page count",
    workId: null,
    editionId: null,
    matchMethod: null,
    linkedAt: null,
  });
  const scan = await deployed.admin.catalogscan.run({}, recentAdmin());
  assert.deepEqual(scan.books.map(({bookId, pageCount}) => [bookId, pageCount]), [
    ["no-pages", null],
  ]);
});

// A continuation page answers for its own books only: re-reading and
// re-serialising the whole catalog on every page is what the cursor exists
// to avoid. Works stay because the page states link counts against them.
test("a continuation scan page carries no catalog inventory", async (t) => {
  const store = installCatalogStore(t);
  store.write(store.ref("works/target-work"), activeWork("Target Work"));
  store.write(store.ref("editions/an-edition"), edition("target-work"));
  store.write(store.ref("users/reader"), {uid: "reader"});
  store.write(store.ref("users/reader/books/linked"), {
    owner: store.ref("users/reader"),
    title: "Linked copy",
    pageCount: 100,
    workId: "target-work",
    editionId: null,
    matchMethod: null,
    linkedAt: null,
  });
  const first = await deployed.admin.catalogscan.run({}, recentAdmin());
  assert.deepEqual(
    [first.authors.length, first.editions.length, first.works.length],
    [1, 1, 1],
  );
  assert.equal(first.bookCountsComplete, true);
  const next = await deployed.admin.catalogscan.run(
    {bookCursor: "users/reader/books/aaa"},
    recentAdmin(),
  );
  assert.deepEqual([next.authors, next.editions], [[], []]);
  assert.deepEqual(next.works.map(({workId, linkedBookCount}) => [workId, linkedBookCount]), [
    ["target-work", 1],
  ]);
  assert.equal(next.bookCountsComplete, false);
});

// The audit row is the evidence that an operator read cross-user data. A
// handler that throws part-way through has still read, so the row is
// written before the handler runs, not after it returns.
test("an admin read that fails is still audited", async (t) => {
  const store = installCatalogStore(t);
  store.write(store.ref("works/corrupt-work"), activeWork("Corrupt", {status: "invented"}));
  await assert.rejects(
    deployed.admin.catalogscan.run({}, recentAdmin()),
    (error) => hasCode(error, "failed-precondition"),
  );
  assert.equal(store.rows.get("adminAudit/view-audit")?.uid, adminUid);
});
