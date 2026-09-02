require("./setup.cts");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const test: typeof import("node:test").test = require("node:test");
const {createHash}: typeof import("node:crypto") = require("node:crypto");
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
interface Deployed {
  admin: {
    catalogapply: {run(data: unknown, context: unknown): Promise<ApplyResult>};
    catalogpreview: {run(data: unknown, context: unknown): Promise<PreviewResult>};
    review: {run(data: unknown, context: unknown): Promise<{updated: number}>};
  };
}

const deployed: Deployed = require("../lib");
// After the bundle: catalog.js calls getFirestore() at load, which needs
// the app that ../lib initializes.
const {externalIndexId}: typeof import("../src/catalog") = require("../lib/catalog");
const {CATALOG_LIMITS}: typeof import("../src/shared/catalogLimits") = require("../lib/shared/catalogLimits");
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
  // A record the console creates is the operator's.
  assert.equal(store.rows.get("works/new-work")?.createdBy, adminUid);
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
  // A move edits an existing edition: the operator becomes no creator.
  assert.equal(store.rows.get("editions/shared-edition")?.createdBy, undefined);
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

// The audit row is the evidence that an operator read cross-user data. A
// handler that throws part-way through has still read, so the row is
// written before the handler runs, not after it returns.
test("an admin read that fails is still audited", async (t) => {
  const store = installCatalogStore(t);
  store.write(store.ref("works/corrupt-work"), activeWork("Corrupt", {status: "invented"}));
  await assert.rejects(
    deployed.admin.catalogpreview.run({operation: {
      type: "editWork",
      workId: "corrupt-work",
      status: "active",
      work: {
        canonicalTitle: "Corrupt",
        alternateTitles: [],
        authorIds: ["ada-author"],
        coverUrl: "",
        subjects: [],
        fiction: true,
      },
    }}, recentAdmin()),
    (error) => hasCode(error, "failed-precondition"),
  );
  assert.equal(store.rows.get("adminAudit/view-audit")?.uid, adminUid);
});

// A merged author id on a work operation (an admin form or client that
// loaded its author list before the merge) resolves one hop to the
// survivor and the work stores the survivor only; a chain is corruption
// (the merge transaction flattens them) and is refused.
test("work operations resolve a merged author id to its survivor", async (t) => {
  const store = installCatalogStore(t);
  const now = Timestamp.fromMillis(1000);
  store.write(store.ref("catalogAuthors/ada-alias"), {
    canonicalName: "A. Author", alternateNames: [], nameKeys: ["a author"],
    sortName: "Author", kind: "person", status: "merged", mergedInto: "ada-author",
    mergedFrom: [], createdAt: now, updatedAt: now,
  });
  const operation = {
    type: "createWork",
    workId: "aliased-work",
    status: "active",
    work: {
      canonicalTitle: "Aliased Work",
      alternateTitles: [],
      authorIds: ["ada-alias", "ada-author"],
      coverUrl: "",
      subjects: [],
      fiction: true,
    },
    books: [],
  };
  const preview = await deployed.admin.catalogpreview.run({operation}, recentAdmin());
  // The alias and its survivor are both versioned (each document once):
  // the plan is stale if either moves under the preview.
  assert.equal(preview.expected.catalog.filter(({kind}) => kind === "author").length, 2);
  await deployed.admin.catalogapply.run({
    operationId: preview.operationId, operation, expected: preview.expected,
  }, recentAdmin());
  assert.deepEqual(store.rows.get("works/aliased-work")?.authorIds, ["ada-author"]);

  store.write(store.ref("catalogAuthors/ada-author"), {
    ...store.rows.get("catalogAuthors/ada-author"), status: "merged", mergedInto: "elsewhere",
  });
  await assert.rejects(
    deployed.admin.catalogpreview.run({operation: {
      ...operation, workId: "chained-work", work: {...operation.work, authorIds: ["ada-alias"]},
    }}, recentAdmin()),
    (error) => hasCode(error, "failed-precondition") && messageMatches(error, /not one hop/),
  );
});

// Every linked book stands on an edition of its work (owner decision
// 2026-09-01): a link that names no edition mints one per book from the
// book's own fields, under an id a repeated apply reuses.
test("an admin link without an edition mints one per book and reuses it on a relink", async (t) => {
  const store = installCatalogStore(t);
  store.write(store.ref("works/target-work"), activeWork("Target Work"));
  store.write(store.ref("users/reader"), {uid: "reader"});
  const bookRef = store.ref("users/reader/books/book-one");
  store.write(bookRef, {
    owner: store.ref("users/reader"), title: "Personal title", isbn: "0-441-47812-3",
    publisher: "Ace", publishedDate: "1987", pageCount: 250, coverUrl: "https://covers.test/a.jpg",
    updatedAt: Timestamp.fromMillis(100), workId: null, editionId: null, matchMethod: null, linkedAt: null,
  });
  const operation = {
    type: "linkBooks",
    books: [{uid: "reader", bookId: "book-one"}],
    target: {workId: "target-work", editionId: null},
  };
  const editionId = `edition_${createHash("sha256")
    .update("edition\0target-work\0reader/book-one").digest("hex").slice(0, 24)}`;
  const preview = await deployed.admin.catalogpreview.run({operation}, recentAdmin());
  assert.deepEqual(
    preview.changes.map(({kind, action}) => `${kind}:${action}`).sort(),
    ["book:update", "edition:create", "isbn:create"],
  );
  assert.equal(preview.expected.catalog.some(({kind, exists}) => kind === "edition" && !exists), true);
  await deployed.admin.catalogapply.run({
    operationId: preview.operationId, operation, expected: preview.expected,
  }, recentAdmin());
  const minted = store.rows.get(`editions/${editionId}`);
  assert.equal(minted?.workId, "target-work");
  assert.equal(minted?.isbn13, "9780441478125");
  assert.equal(minted?.title, "Personal title");
  assert.equal(minted?.publisher, "Ace");
  assert.equal(minted?.publishedDate, "1987");
  assert.equal(minted?.suggestedPageCount, 250);
  assert.equal(minted?.coverUrl, "https://covers.test/a.jpg");
  assert.equal(minted?.createdBy, "reader");
  assert.deepEqual(store.rows.get("isbnIndex/9780441478125"), {workId: "target-work", editionId});
  assert.equal(store.rows.get(bookRef.path)?.editionId, editionId);
  assert.equal(store.rows.get(bookRef.path)?.matchMethod, "admin");

  // Unlink, then the same link again: the edition is reused, not duplicated.
  const unlink = {...operation, target: null};
  const unlinkPreview = await deployed.admin.catalogpreview.run({operation: unlink}, recentAdmin());
  await deployed.admin.catalogapply.run({
    operationId: unlinkPreview.operationId, operation: unlink, expected: unlinkPreview.expected,
  }, recentAdmin());
  assert.equal(store.rows.get(bookRef.path)?.editionId, null);
  const relink = await deployed.admin.catalogpreview.run({operation}, recentAdmin());
  assert.deepEqual(relink.changes.map(({kind, action}) => `${kind}:${action}`), ["book:update"]);
  await deployed.admin.catalogapply.run({
    operationId: relink.operationId, operation, expected: relink.expected,
  }, recentAdmin());
  assert.equal([...store.rows.keys()].filter((path) => path.startsWith("editions/")).length, 1);
  assert.equal(store.rows.get(bookRef.path)?.editionId, editionId);
});

test("an admin link joins an ISBN indexed to this work and refuses one indexed elsewhere", async (t) => {
  const store = installCatalogStore(t);
  store.write(store.ref("works/target-work"), activeWork("Target Work"));
  store.write(store.ref("works/other-work"), activeWork("Other Work"));
  store.write(store.ref("editions/other-edition"), edition("other-work", {isbn13: "9780000000002"}));
  store.write(store.ref("isbnIndex/9780000000002"), {workId: "other-work", editionId: "other-edition"});
  store.write(store.ref("users/reader"), {uid: "reader"});
  const bookRef = store.ref("users/reader/books/book-one");
  store.write(bookRef, {
    owner: store.ref("users/reader"), title: "Personal title", isbn: "9780000000002", pageCount: 250,
    workId: null, editionId: null, matchMethod: null, linkedAt: null,
  });
  const operation = {
    type: "linkBooks",
    books: [{uid: "reader", bookId: "book-one"}],
    target: {workId: "target-work", editionId: null},
  };
  await assert.rejects(
    deployed.admin.catalogpreview.run({operation}, recentAdmin()),
    (error) => hasCode(error, "failed-precondition") &&
      detail(error, "reason") === "identifier-conflict",
  );
  store.write(store.ref("editions/other-edition"), edition("target-work", {isbn13: "9780000000002"}));
  store.write(store.ref("isbnIndex/9780000000002"), {workId: "target-work", editionId: "other-edition"});
  const preview = await deployed.admin.catalogpreview.run({operation}, recentAdmin());
  assert.deepEqual(
    preview.changes.map(({kind, action, after}) => [kind, action, after?.editionId]),
    [["book", "update", "other-edition"]],
  );
});

test("author and edition edits keep the creator the add-book flow recorded", async (t) => {
  const store = installCatalogStore(t);
  const now = Timestamp.fromMillis(1000);
  store.write(store.ref("catalogAuthors/made-by-reader"), {
    canonicalName: "Octavia Butler", alternateNames: [], nameKeys: ["octavia butler"],
    sortName: "Butler", kind: "person", status: "active", mergedFrom: [],
    createdBy: "reader", createdAt: now, updatedAt: now,
  });
  store.write(store.ref("works/target-work"), activeWork("Target Work"));
  store.write(store.ref("editions/made-by-reader"), edition("target-work", {createdBy: "reader"}));
  const authorEdit = {
    type: "upsertAuthor",
    authorId: "made-by-reader",
    author: {canonicalName: "Octavia E. Butler", alternateNames: [], sortName: "Butler", kind: "person"},
  };
  const authorPreview = await deployed.admin.catalogpreview.run({operation: authorEdit}, recentAdmin());
  await deployed.admin.catalogapply.run({
    operationId: authorPreview.operationId, operation: authorEdit, expected: authorPreview.expected,
  }, recentAdmin());
  assert.equal(store.rows.get("catalogAuthors/made-by-reader")?.createdBy, "reader");
  assert.equal(store.rows.get("catalogAuthors/made-by-reader")?.canonicalName, "Octavia E. Butler");
  const editionEdit = {
    type: "upsertEdition",
    editionId: "made-by-reader",
    workId: "target-work",
    edition: {
      isbn13: null, title: "Renamed", publisher: "", publishedDate: "", language: "en",
      translatorNames: [], format: "full", suggestedPageCount: 300, coverUrl: "", externalIds: {},
    },
  };
  const editionPreview = await deployed.admin.catalogpreview.run({operation: editionEdit}, recentAdmin());
  await deployed.admin.catalogapply.run({
    operationId: editionPreview.operationId, operation: editionEdit, expected: editionPreview.expected,
  }, recentAdmin());
  assert.equal(store.rows.get("editions/made-by-reader")?.createdBy, "reader");
  assert.equal(store.rows.get("editions/made-by-reader")?.title, "Renamed");
});

test("an author the console creates records the operator; an author without a creator keeps none on edit", async (t) => {
  const store = installCatalogStore(t);
  const created = {
    type: "upsertAuthor",
    authorId: "made-by-operator",
    author: {canonicalName: "Ursula K. Le Guin", alternateNames: [], sortName: "Le Guin", kind: "person"},
  };
  const preview = await deployed.admin.catalogpreview.run({operation: created}, recentAdmin());
  await deployed.admin.catalogapply.run({
    operationId: preview.operationId, operation: created, expected: preview.expected,
  }, recentAdmin());
  assert.equal(store.rows.get("catalogAuthors/made-by-operator")?.createdBy, adminUid);

  const now = Timestamp.fromMillis(1000);
  store.write(store.ref("catalogAuthors/legacy"), {
    canonicalName: "Legacy Author", alternateNames: [], nameKeys: ["legacy author"],
    sortName: "Author", kind: "person", status: "active", mergedFrom: [],
    createdAt: now, updatedAt: now,
  });
  const edit = {
    type: "upsertAuthor",
    authorId: "legacy",
    author: {canonicalName: "Legacy Author", alternateNames: ["L. Author"], sortName: "Author", kind: "person"},
  };
  const editPreview = await deployed.admin.catalogpreview.run({operation: edit}, recentAdmin());
  await deployed.admin.catalogapply.run({
    operationId: editPreview.operationId, operation: edit, expected: editPreview.expected,
  }, recentAdmin());
  assert.equal(store.rows.get("catalogAuthors/legacy")?.createdBy, undefined);
  assert.deepEqual(store.rows.get("catalogAuthors/legacy")?.alternateNames, ["L. Author"]);
});

test("an edition the console creates from nothing records the operator", async (t) => {
  const store = installCatalogStore(t);
  store.write(store.ref("works/target-work"), activeWork("Target Work"));
  const operation = {
    type: "upsertEdition",
    editionId: "made-by-operator",
    workId: "target-work",
    edition: {
      isbn13: null, title: "Console Edition", publisher: "", publishedDate: "", language: "en",
      translatorNames: [], format: "full", suggestedPageCount: 300, coverUrl: "", externalIds: {},
    },
  };
  const preview = await deployed.admin.catalogpreview.run({operation}, recentAdmin());
  await deployed.admin.catalogapply.run({
    operationId: preview.operationId, operation, expected: preview.expected,
  }, recentAdmin());
  assert.equal(store.rows.get("editions/made-by-operator")?.createdBy, adminUid);
});

test("a review mark stamps reviewedAt on whole records, survives edits, clears again, and refuses a missing id", async (t) => {
  const store = installCatalogStore(t);
  store.write(store.ref("works/seen-work"), activeWork("Seen Work"));
  store.write(store.ref("works/other-work"), activeWork("Other Work"));
  const marked = await deployed.admin.review.run(
    {kind: "work", ids: ["seen-work", "other-work"], reviewed: true}, recentAdmin(),
  );
  assert.deepEqual(marked, {updated: 2});
  const seen = store.rows.get("works/seen-work");
  assert.ok(seen?.reviewedAt instanceof Timestamp);
  assert.equal(seen?.canonicalTitle, "Seen Work");
  // A review mark is not an edit: updatedAt is what it was.
  assert.equal((seen?.updatedAt as {toMillis(): number}).toMillis(), 1000);

  // An edit through the console keeps the mark.
  const edit = {
    type: "editWork",
    workId: "seen-work",
    status: "active",
    work: {
      canonicalTitle: "Seen Work", alternateTitles: ["Also Seen"], authorIds: ["ada-author"],
      coverUrl: "", subjects: [], fiction: true,
    },
  };
  const preview = await deployed.admin.catalogpreview.run({operation: edit}, recentAdmin());
  await deployed.admin.catalogapply.run({
    operationId: preview.operationId, operation: edit, expected: preview.expected,
  }, recentAdmin());
  assert.ok(store.rows.get("works/seen-work")?.reviewedAt instanceof Timestamp);
  assert.deepEqual(store.rows.get("works/seen-work")?.alternateTitles, ["Also Seen"]);

  const cleared = await deployed.admin.review.run(
    {kind: "work", ids: ["seen-work"], reviewed: false}, recentAdmin(),
  );
  assert.deepEqual(cleared, {updated: 1});
  assert.equal(store.rows.get("works/seen-work")?.reviewedAt, undefined);
  assert.ok(store.rows.get("works/other-work")?.reviewedAt instanceof Timestamp);

  store.write(store.ref("catalogAuthors/ada-author"), {
    canonicalName: "Ada Author", alternateNames: [], nameKeys: ["ada author"], sortName: "Author",
    kind: "person", status: "active", mergedFrom: [], createdBy: "reader",
    createdAt: Timestamp.fromMillis(1000), updatedAt: Timestamp.fromMillis(1000),
  });
  await deployed.admin.review.run({kind: "author", ids: ["ada-author"], reviewed: true}, recentAdmin());
  assert.ok(store.rows.get("catalogAuthors/ada-author")?.reviewedAt instanceof Timestamp);
  assert.equal(store.rows.get("catalogAuthors/ada-author")?.createdBy, "reader");

  // One missing id refuses the whole call; the existing one is untouched.
  await assert.rejects(
    deployed.admin.review.run({kind: "work", ids: ["seen-work", "nowhere"], reviewed: true}, recentAdmin()),
    (error: {code?: string}) => error.code === "not-found",
  );
  assert.equal(store.rows.get("works/seen-work")?.reviewedAt, undefined);
});

test("merging editions aliases the sources, moves their readers' books to the survivor and fills what they left blank", async (t) => {
  const store = installCatalogStore(t);
  const now = Timestamp.fromMillis(1000);
  store.write(store.ref("works/sult"), activeWork("Sult", {
    coverUrl: "https://covers.test/work.jpg", subjects: ["Romaner"], fiction: true,
  }));
  store.write(store.ref("editions/full"), edition("sult", {
    isbn13: "9788205394810", publisher: "Gyldendal", publishedDate: "2009",
    coverUrl: "https://covers.test/full.jpg",
  }));
  store.write(store.ref("editions/bare"), edition("sult", {createdBy: "magnus", mergedFrom: ["older-alias"]}));
  store.write(store.ref("editions/older-alias"), edition("sult", {status: "merged", mergedInto: "bare"}));
  store.write(store.ref("isbnIndex/9788205394810"), {workId: "sult", editionId: "full"});
  store.write(store.ref("users/magnus"), {uid: "magnus"});
  store.write(store.ref("users/ghost"), {uid: "ghost", deletedAt: now});
  store.write(store.ref("users/magnus/books/sult"), {
    owner: store.ref("users/magnus"), title: "Sult", pageCount: 198, isbn: "", coverUrl: "",
    publisher: "", publishedDate: "", fiction: null, subjects: [],
    workId: "sult", editionId: "bare", matchMethod: "migration", linkedAt: Timestamp.fromMillis(500),
  });
  store.write(store.ref("users/magnus/books/own-cover"), {
    owner: store.ref("users/magnus"), title: "Sult", pageCount: 200, isbn: "",
    coverUrl: "https://covers.test/mine.jpg", publisher: "Own Press", fiction: false, subjects: ["Mine"],
    workId: "sult", editionId: "older-alias", matchMethod: "admin", linkedAt: Timestamp.fromMillis(600),
  });
  store.write(store.ref("users/ghost/books/frozen"), {
    owner: store.ref("users/ghost"), title: "Sult", pageCount: 198, isbn: "",
    workId: "sult", editionId: "bare", matchMethod: "migration", linkedAt: Timestamp.fromMillis(700),
  });
  const operation = {
    type: "mergeEditions", workId: "sult", sourceEditionIds: ["bare"], targetEditionId: "full",
  };
  const preview = await deployed.admin.catalogpreview.run({operation}, recentAdmin());
  // The preview names the inherited fields beside the link change.
  const bookChange = preview.changes.find(({kind, after}) => kind === "book" && after?.isbn === "9788205394810");
  assert.deepEqual(bookChange?.after, {
    workId: "sult", editionId: "full", matchMethod: "admin", linkedAt: 500,
    isbn: "9788205394810", coverUrl: "https://covers.test/full.jpg", publisher: "Gyldendal",
    publishedDate: "2009", fiction: true, subjects: ["Romaner"],
  });
  await deployed.admin.catalogapply.run({
    operationId: preview.operationId, operation, expected: preview.expected,
  }, recentAdmin());

  // The sources, chained aliases included, redirect to the survivor, which lists them.
  assert.equal(store.rows.get("editions/bare")?.status, "merged");
  assert.equal(store.rows.get("editions/bare")?.mergedInto, "full");
  assert.equal(store.rows.get("editions/bare")?.createdBy, "magnus");
  assert.equal(store.rows.get("editions/older-alias")?.mergedInto, "full");
  assert.deepEqual(store.rows.get("editions/full")?.mergedFrom, ["bare", "older-alias"]);
  assert.equal(store.rows.get("editions/full")?.status, undefined);
  assert.deepEqual(store.rows.get("isbnIndex/9788205394810"), {workId: "sult", editionId: "full"});

  // Magnus's bare book stands on the survivor and inherits what it lacked;
  // its title, page count and link time are its own.
  const moved = store.rows.get("users/magnus/books/sult");
  assert.equal(moved?.editionId, "full");
  assert.equal(moved?.matchMethod, "admin");
  assert.equal((moved?.linkedAt as {toMillis(): number}).toMillis(), 500);
  assert.equal(moved?.isbn, "9788205394810");
  assert.equal(moved?.coverUrl, "https://covers.test/full.jpg");
  assert.equal(moved?.publisher, "Gyldendal");
  assert.equal(moved?.publishedDate, "2009");
  assert.equal(moved?.fiction, true);
  assert.deepEqual(moved?.subjects, ["Romaner"]);
  assert.equal(moved?.pageCount, 198);
  assert.equal(moved?.title, "Sult");
  // A reader's own values are never replaced; only blanks fill.
  const kept = store.rows.get("users/magnus/books/own-cover");
  assert.equal(kept?.editionId, "full");
  assert.equal(kept?.coverUrl, "https://covers.test/mine.jpg");
  assert.equal(kept?.publisher, "Own Press");
  assert.equal(kept?.fiction, false);
  assert.deepEqual(kept?.subjects, ["Mine"]);
  assert.equal(kept?.isbn, "9788205394810");
  assert.equal(kept?.publishedDate, "2009");
  // A frozen account's book stays on its alias.
  assert.equal(store.rows.get("users/ghost/books/frozen")?.editionId, "bare");
  assert.equal(store.rows.get("users/ghost/books/frozen")?.isbn, "");

  // Aliases are neither targets nor editable nor mergeable again.
  for (const refused of [
    {type: "mergeEditions", workId: "sult", sourceEditionIds: ["full"], targetEditionId: "bare"},
    {type: "mergeEditions", workId: "sult", sourceEditionIds: ["bare"], targetEditionId: "full"},
    {type: "linkBooks", books: [{uid: "magnus", bookId: "sult"}], target: {workId: "sult", editionId: "bare"}},
    {type: "upsertEdition", editionId: "bare", workId: "sult", edition: {
      isbn13: null, title: "Renamed", publisher: "", publishedDate: "", language: "en",
      translatorNames: [], format: "full", suggestedPageCount: 300, coverUrl: "", externalIds: {},
    }},
    {type: "repointIsbn", isbn13: "9788205394810", editionId: "bare"},
  ]) {
    await assert.rejects(
      deployed.admin.catalogpreview.run({operation: refused}, recentAdmin()),
      (error: {details?: {reason?: string}}) => error.details?.reason === "catalog-invariant",
      JSON.stringify(refused),
    );
  }
  // Editions of another work do not merge across it.
  store.write(store.ref("works/other"), activeWork("Other"));
  store.write(store.ref("editions/elsewhere"), edition("other"));
  await assert.rejects(
    deployed.admin.catalogpreview.run({operation: {
      type: "mergeEditions", workId: "sult", sourceEditionIds: ["elsewhere"], targetEditionId: "full",
    }}, recentAdmin()),
    (error: {details?: {reason?: string}}) => error.details?.reason === "catalog-invariant",
  );
});
