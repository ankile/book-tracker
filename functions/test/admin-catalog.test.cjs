require("./setup.cjs");

const assert = require("node:assert/strict");
const test = require("node:test");
const {getFirestore, Timestamp} = require("firebase-admin/firestore");
const {logger} = require("firebase-functions");

const deployed = require("../lib");
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
  t.mock.method(db, "collection", (name) => {
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
    (error) => error.code === "not-found",
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
    (error) => error.code === "failed-precondition" &&
      error.details.reason === "recent-auth-required" &&
      error.details.maxAgeSeconds === 900,
  );
  assert.equal(touched, true);
  touched = false;
  await assert.rejects(
    deployed.admin.catalogapply.run({attacker: true}, recentAdmin()),
    (error) => error.code === "invalid-argument",
  );
  assert.equal(touched, true);
});

function installCatalogStore(t) {
  const rows = new Map();
  const references = new Map();
  const updateTimes = new Map();
  let clock = 1;
  const snapshot = (reference) => ({
    exists: rows.has(reference.path),
    id: reference.id,
    ref: reference,
    data: () => rows.get(reference.path),
    get: (field) => rows.get(reference.path)?.[field],
    updateTime: rows.has(reference.path) ? updateTimes.get(reference.path) : undefined,
  });
  const querySnapshot = (query) => {
    const prefix = `${query.name}/`;
    const docs = [...rows.keys()].filter((path) => query.collectionGroup ?
      path.split("/").at(-2) === query.name : path.startsWith(prefix))
      .map((path) => references.get(path))
      .filter((reference) => query.filters.every(([field, operator, value]) => {
        const actual = rows.get(reference.path)?.[field];
        if (operator === "==") return actual === value;
        if (operator === "in") return value.includes(actual);
        if (operator === "array-contains") return Array.isArray(actual) && actual.includes(value);
        if (operator === "array-contains-any") {
          return Array.isArray(actual) && value.some((candidate) => actual.includes(candidate));
        }
        assert.fail(`unsupported query operator ${operator}`);
      }))
      .slice(0, query.maximum)
      .map(snapshot);
    return {docs, size: docs.length};
  };
  const makeQuery = (name, collectionGroup = false) => {
    const query = {
      _query: true,
      name,
      collectionGroup,
      filters: [],
      maximum: Infinity,
      where: (field, operator, value) => {
        query.filters.push([field, operator, value]);
        return query;
      },
      limit: (maximum) => {
        query.maximum = maximum;
        return query;
      },
      get: async () => querySnapshot(query),
    };
    return query;
  };
  const ref = (path) => {
    if (!references.has(path)) {
      const reference = {
        path,
        id: path.slice(path.lastIndexOf("/") + 1),
      };
      reference.get = async () => snapshot(reference);
      references.set(path, reference);
    }
    return references.get(path);
  };
  const write = (reference, data, merge = false) => {
    rows.set(reference.path, merge ? {...rows.get(reference.path), ...data} : data);
    updateTimes.set(reference.path, Timestamp.fromMillis(clock++));
  };
  t.mock.method(db, "collection", (name) => {
    const query = makeQuery(name);
    query.doc = (id) => ref(`${name}/${id}`);
    if (name === "adminAudit") query.add = async () => ({id: "view-audit"});
    return query;
  });
  t.mock.method(db, "collectionGroup", (name) => makeQuery(name, true));
  t.mock.method(db, "doc", (path) => ref(path));
  t.mock.method(db, "runTransaction", async (handler) => handler({
    get: async (value) => value._query ? querySnapshot(value) : snapshot(value),
    create: (reference, data) => {
      assert.equal(rows.has(reference.path), false, reference.path);
      write(reference, data);
    },
    set: (reference, data, options) => write(reference, data, options?.merge === true),
    delete: (reference) => {
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

function activeWork(title, overrides = {}) {
  const now = Timestamp.fromMillis(1000);
  return {
    canonicalTitle: title,
    alternateTitles: [],
    titleKeys: [title.toLowerCase().replace(/^the /, "")],
    authorIds: ["ada-author"],
    coverUrl: "",
    subjects: [],
    fiction: true,
    visibility: "searchable",
    status: "active",
    mergedFrom: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function edition(workId, overrides = {}) {
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
    visibility: "internal",
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
  assert.equal(store.rows.get("works/new-work").canonicalTitle, "The New Work");
  const audit = store.rows.get(`adminAudit/${preview.operationId}`);
  assert.equal(audit.type, "catalog-mutation");
  assert.equal(audit.operationType, "createWork");
  assert.equal(audit.uid, adminUid);
  assert.equal(audit.beforeAfter.some((row) => row.kind === "work"), true);
  assert.doesNotMatch(JSON.stringify(audit), /session|currentPage|activeTimer|pagesRead/);
});

test("catalog creation stops at the scan capacity while repair edits remain available", async (t) => {
  const store = installCatalogStore(t);
  for (let index = 0; index < 200; index += 1) {
    store.write(store.ref(`works/work-${index}`), activeWork(`Work ${index}`));
  }
  const create = {
    type: "createWork",
    workId: "over-capacity",
    visibility: "internal",
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
    (error) => error.code === "resource-exhausted" &&
      error.details.reason === "catalog-capacity" &&
      error.details.collection === "works" && error.details.maximum === 200,
  );
  const repair = {
    type: "editWork",
    workId: "work-0",
    visibility: "searchable",
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
  assert.equal(store.rows.get(bookRef.path).title, "Edited after preview");
  assert.equal(store.rows.get(bookRef.path).workId, "target-work");

  const stalePreview = await deployed.admin.catalogpreview.run({operation}, recentAdmin());
  store.write(bookRef, {workId: "other-work"}, true);
  await assert.rejects(deployed.admin.catalogapply.run({
    operationId: stalePreview.operationId,
    operation,
    expected: stalePreview.expected,
  }, recentAdmin()), (error) => error.code === "aborted" &&
    error.details.reason === "stale-preview");
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
    (error) => error.code === "failed-precondition" &&
      error.details.reason === "catalog-invariant",
  );
  store.write(bookRef, {owner: store.ref("users/other")}, true);
  store.write(store.ref("users/reader"), {uid: "reader", deletedAt: Timestamp.fromMillis(1)});
  await assert.rejects(
    deployed.admin.catalogpreview.run({operation: link}, recentAdmin()),
    (error) => error.code === "failed-precondition",
  );
  const unlink = {...link, target: null};
  const preview = await deployed.admin.catalogpreview.run({operation: unlink}, recentAdmin());
  assert.equal(preview.changes[0].after.workId, null);
});

test("searchable promotion requires consent provenance and rejects private work fields", async (t) => {
  const store = installCatalogStore(t);
  store.write(store.ref("users/private-reader/books/private-book"), {
    title: "Private",
    workId: null,
    editionId: null,
    matchMethod: null,
    linkedAt: null,
  });
  const create = {
    type: "createWork",
    workId: "private-derived-work",
    visibility: "searchable",
    work: {
      canonicalTitle: "Private Derived Work",
      alternateTitles: [],
      authorIds: ["ada-author"],
      coverUrl: "",
      subjects: [],
      fiction: true,
    },
    books: [{uid: "private-reader", bookId: "private-book"}],
  };
  await assert.rejects(
    deployed.admin.catalogpreview.run({operation: create}, recentAdmin()),
    (error) => error.code === "failed-precondition" &&
      error.details.reason === "catalog-invariant",
  );

  store.write(store.ref("works/internal-work"), activeWork("Internal Work", {
    visibility: "internal",
    sourceUid: "must-never-be-published",
  }));
  store.write(store.ref(`users/${adminUid}/books/operator-book`), {
    workId: "internal-work",
    editionId: null,
    matchMethod: "admin",
    linkedAt: Timestamp.fromMillis(100),
  });
  const edit = {
    type: "editWork",
    workId: "internal-work",
    visibility: "searchable",
    work: {
      canonicalTitle: "Internal Work",
      alternateTitles: [],
      authorIds: ["ada-author"],
      coverUrl: "",
      subjects: [],
      fiction: true,
    },
  };
  await assert.rejects(
    deployed.admin.catalogpreview.run({operation: edit}, recentAdmin()),
    (error) => error.code === "failed-precondition" &&
      error.details.reason === "catalog-invariant" &&
      /unsupported field sourceUid/.test(error.message),
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
  const externalId = require("../lib/catalog").externalIndexId({
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
  assert.equal(store.rows.get("editions/shared-edition").workId, "new-work");
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
  assert.equal(store.rows.get(bookRef.path).workId, "new-work");
  assert.equal(store.rows.get(bookRef.path).title, "Keep this title");
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
    (error) => error.code === "failed-precondition" &&
      error.details.reason === "catalog-invariant",
  );
  store.write(store.ref("isbnIndex/9780000000002"), {
    workId: "old-work", editionId: "another-edition",
  });
  await assert.rejects(
    deployed.admin.catalogpreview.run({operation}, recentAdmin()),
    (error) => error.code === "failed-precondition" &&
      error.details.reason === "catalog-invariant",
  );
});

test("each internal source needs its own provenance before a searchable merge", async (t) => {
  const store = installCatalogStore(t);
  store.write(store.ref("works/target"), activeWork("Target"));
  store.write(store.ref("works/consented"), activeWork("Consented", {visibility: "internal"}));
  store.write(store.ref("works/private"), activeWork("Private", {visibility: "internal"}));
  store.write(store.ref("users/reader/books/consented"), {
    workId: "consented", editionId: null, matchMethod: "isbn",
    linkedAt: Timestamp.fromMillis(1),
  });
  store.write(store.ref("users/reader"), {uid: "reader"});
  store.write(store.ref("users/reader/settings/bookSharing"), {
    profileUsername: "reader-name", timeZone: "UTC",
  });
  store.write(store.ref("profiles/reader-name"), {
    uid: "reader", public: true,
  });
  store.write(store.ref("users/private/books/private"), {
    workId: "private", editionId: null, matchMethod: "isbn",
    linkedAt: Timestamp.fromMillis(1),
  });
  await assert.rejects(deployed.admin.catalogpreview.run({operation: {
    type: "mergeWorks", sourceWorkIds: ["consented", "private"], targetWorkId: "target",
  }}, recentAdmin()), (error) => error.code === "failed-precondition" &&
    error.details.reason === "catalog-invariant" && /private/.test(error.message));
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
  const externalId = require("../lib/catalog").externalIndexId({
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
  assert.equal(store.rows.get("works/source-work").status, "merged");
  assert.equal(store.rows.get("works/source-work").mergedInto, "target-work");
  assert.deepEqual(store.rows.get("works/target-work").mergedFrom, ["source-work"]);
  assert.equal(store.rows.get("editions/source-edition").workId, "target-work");
  assert.equal(store.rows.get("isbnIndex/9780000000002").workId, "target-work");
  assert.equal(store.rows.get(`externalIdIndex/${externalId}`).workId, "target-work");
  assert.equal(store.rows.get("users/reader/books/old-link").workId, "source-work");
});
