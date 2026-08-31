import * as functions from "firebase-functions/v1";
import {logger} from "firebase-functions";
import {
  DocumentReference,
  DocumentSnapshot,
  FieldPath,
  Firestore,
  Query,
  QueryDocumentSnapshot,
  QuerySnapshot,
  Timestamp,
} from "firebase-admin/firestore";
import {createHash, randomUUID} from "node:crypto";
import {Buffer} from "node:buffer";
import {
  AdminBookTarget,
  AdminCatalogApplyRequest,
  AdminCatalogExpected,
  AdminCatalogOperation,
  CatalogAuthorInput,
  CatalogEditionInput,
  CatalogWorkInput,
  MatchMethod,
  normalizeCatalogIdentity,
  MATCH_METHODS,
  normalizeIsbn13,
  VersionedKind,
} from "./decoders";
import {
  CatalogDataFail,
  externalIndexId,
  normalizeCatalogTitle,
  StoredCatalogAuthor,
  StoredEdition,
  storedCatalogAuthor,
  storedEdition,
  StoredWork,
  storedWork,
  titleIndexId,
  titleIndexRow,
} from "./catalog";
import {CATALOG_LIMITS} from "./catalogLimits";

const MAX_WORKS = CATALOG_LIMITS.works;
const MAX_CATALOG_AUTHORS = CATALOG_LIMITS.catalogAuthors;
const MAX_EDITIONS = CATALOG_LIMITS.editions;
const BOOK_PAGE_SIZE = 100;
const MAX_ISBN_INDEXES = CATALOG_LIMITS.isbnIndexes;
const MAX_EXTERNAL_ID_INDEXES = CATALOG_LIMITS.externalIdIndexes;
const MAX_AUTHORS_PER_PERSONAL_BOOK = 6;
const MAX_TOUCHED_DOCUMENTS = 200;
const MAX_LINKED_EDITION_BOOKS = 100;
const AUDIT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_AUDIT_BYTES = 700_000;

type WorkStatus = StoredWork["status"];

interface WorkData extends StoredWork {
  // The uid that created the work through catalog.create; absent for
  // works the migration or an administrator created.
  createdBy?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface AuthorData extends StoredCatalogAuthor {
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface EditionData extends StoredEdition {
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// A type alias, not an interface: these records go on the wire as plain
// change payloads.
type LinkState = {
  workId: string | null;
  editionId: string | null;
  matchMethod: MatchMethod | null;
  linkedAt: number | null;
};

interface CatalogVersion {
  kind: VersionedKind;
  id: string;
  exists: boolean;
  updatedAt: number | null;
}

interface PlannedChange {
  kind: VersionedKind | "book";
  id: string;
  action: "create" | "update" | "delete";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ref: DocumentReference;
  write: {type: "create" | "set"; data: Record<string, unknown>} |
    {type: "delete"};
}

interface Plan {
  expected: AdminCatalogExpected;
  changes: PlannedChange[];
  // Set by mergeAuthors: after the atomic redirect commits, the apply pass
  // canonicalizes every work and live-account book that still names an
  // absorbed author (see canonicalizeMergedAuthorReferrers).
  canonicalize: {absorbed: string[]; targetId: string} | null;
}

type Readable = DocumentReference | Query;
interface PlanReader {
  get(_value: Readable): Promise<DocumentSnapshot | QuerySnapshot>;
}

function failedPrecondition(
  message: string,
  reason: "catalog-invariant" | "identifier-conflict",
): never {
  throw new functions.https.HttpsError(
    "failed-precondition",
    message,
    {reason},
  );
}

function operationTooLarge(): never {
  throw new functions.https.HttpsError(
    "resource-exhausted",
    "The catalog operation touches too many documents.",
    {reason: "operation-too-large", maxTouchedDocuments: MAX_TOUCHED_DOCUMENTS},
  );
}

function catalogCapacity(collection: string, maximum: number): never {
  throw new functions.https.HttpsError(
    "resource-exhausted",
    `The ${collection} catalog capacity of ${maximum} documents has been reached.`,
    {reason: "catalog-capacity", collection, maximum},
  );
}

// The stored-document decoders are catalog.ts's, reported as a
// failed-precondition the console can render.
const catalogInvariant: CatalogDataFail = (message) =>
  failedPrecondition(message, "catalog-invariant");

function storedTimestamp(snapshot: DocumentSnapshot, field: string): Timestamp {
  const value = snapshot.get(field);
  if (!(value instanceof Timestamp)) {
    catalogInvariant(`${snapshot.ref.path}.${field} must be a timestamp.`);
  }
  return value;
}

// The admin path is the only writer that must reject an unknown stored
// field: it round-trips whole documents, so a field it cannot see would be
// dropped on the next write.
function assertStoredKeys(
  snapshot: DocumentSnapshot,
  allowed: readonly string[],
): void {
  const data = snapshot.data();
  if (data === undefined) {
    catalogInvariant(`Missing catalog document ${snapshot.ref.path}.`);
  }
  const allowedKeys = new Set(allowed);
  const extra = Object.keys(data).find((key) => !allowedKeys.has(key));
  if (extra !== undefined) {
    failedPrecondition(
      `Catalog document ${snapshot.ref.path} contains unsupported field ${extra}.`,
      "catalog-invariant",
    );
  }
}

function workFrom(snapshot: DocumentSnapshot): WorkData {
  const work = storedWork(snapshot, catalogInvariant);
  assertStoredKeys(snapshot, [
    "canonicalTitle", "alternateTitles", "titleKeys", "authorIds",
    "coverUrl", "subjects", "fiction", "status", "mergedInto", "mergedFrom",
    "createdBy", "createdAt", "updatedAt",
  ]);
  const createdBy = snapshot.get("createdBy");
  if (createdBy !== undefined && typeof createdBy !== "string") {
    catalogInvariant(`Invalid creator ${snapshot.ref.path}.`);
  }
  return {
    ...work,
    ...(createdBy === undefined ? {} : {createdBy}),
    createdAt: storedTimestamp(snapshot, "createdAt"),
    updatedAt: storedTimestamp(snapshot, "updatedAt"),
  };
}

function authorFrom(snapshot: DocumentSnapshot): AuthorData {
  const author = storedCatalogAuthor(snapshot, catalogInvariant);
  assertStoredKeys(snapshot, [
    "canonicalName", "alternateNames", "nameKeys", "sortName", "kind",
    "status", "mergedInto", "mergedFrom", "createdAt", "updatedAt",
  ]);
  return {
    ...author,
    createdAt: storedTimestamp(snapshot, "createdAt"),
    updatedAt: storedTimestamp(snapshot, "updatedAt"),
  };
}

function editionFrom(snapshot: DocumentSnapshot): EditionData {
  const edition = storedEdition(snapshot, catalogInvariant);
  assertStoredKeys(snapshot, [
    "workId", "isbn13", "title", "publisher",
    "publishedDate", "language", "translatorNames", "format",
    "suggestedPageCount", "coverUrl", "externalIds", "createdAt", "updatedAt",
  ]);
  return {
    ...edition,
    createdAt: storedTimestamp(snapshot, "createdAt"),
    updatedAt: storedTimestamp(snapshot, "updatedAt"),
  };
}

function workInputData(
  work: CatalogWorkInput,
  status: WorkStatus,
  now: Timestamp,
  existing?: WorkData,
): WorkData {
  const titleKeys = [...new Set(
    [work.canonicalTitle, ...work.alternateTitles]
      .map(normalizeCatalogTitle)
      .filter(Boolean),
  )];
  return {
    ...work,
    titleKeys,
    status,
    mergedFrom: existing?.mergedFrom ?? [],
    ...(existing?.createdBy === undefined ? {} : {createdBy: existing.createdBy}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function authorInputData(
  author: CatalogAuthorInput,
  now: Timestamp,
  existing?: AuthorData,
): AuthorData {
  const canonicalKey = normalizeCatalogIdentity(author.canonicalName);
  const alternateByKey = new Map<string, string>();
  const candidates = existing !== undefined &&
    normalizeCatalogIdentity(existing.canonicalName) !== canonicalKey ?
    [...author.alternateNames, existing.canonicalName] : author.alternateNames;
  for (const name of candidates) {
    const key = normalizeCatalogIdentity(name);
    if (key !== canonicalKey && !alternateByKey.has(key)) alternateByKey.set(key, name);
  }
  const alternateNames = [...alternateByKey.values()];
  if (alternateNames.length > 20) {
    failedPrecondition("A catalog author may have at most 20 alternate names.", "catalog-invariant");
  }
  return {
    ...author,
    alternateNames,
    nameKeys: [...new Set(
      [author.canonicalName, ...alternateNames].map(normalizeCatalogIdentity),
    )],
    status: "active",
    mergedFrom: existing?.mergedFrom ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function editionInputData(
  workId: string,
  edition: CatalogEditionInput,
  now: Timestamp,
  existing?: EditionData,
): EditionData {
  return {
    workId,
    ...edition,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function operationHash(operation: AdminCatalogOperation): string {
  return createHash("sha256").update(JSON.stringify(operation)).digest("hex");
}

function wireWork(work: WorkData): Record<string, unknown> {
  return {
    canonicalTitle: work.canonicalTitle,
    alternateTitles: work.alternateTitles,
    authorIds: work.authorIds,
    coverUrl: work.coverUrl,
    subjects: work.subjects,
    fiction: work.fiction,
    status: work.status,
    mergedInto: work.mergedInto ?? null,
    mergedFrom: work.mergedFrom,
    updatedAt: work.updatedAt.toMillis(),
  };
}

function wireAuthor(author: AuthorData): Record<string, unknown> {
  return {
    canonicalName: author.canonicalName,
    alternateNames: author.alternateNames,
    nameKeys: author.nameKeys,
    sortName: author.sortName,
    kind: author.kind,
    status: author.status,
    mergedInto: author.mergedInto ?? null,
    mergedFrom: author.mergedFrom,
    updatedAt: author.updatedAt.toMillis(),
  };
}

function wireEdition(edition: EditionData): Record<string, unknown> {
  return {
    workId: edition.workId,
    isbn13: edition.isbn13,
    title: edition.title,
    publisher: edition.publisher,
    publishedDate: edition.publishedDate,
    language: edition.language,
    translatorNames: edition.translatorNames,
    format: edition.format,
    suggestedPageCount: edition.suggestedPageCount,
    coverUrl: edition.coverUrl,
    externalIds: edition.externalIds,
    updatedAt: edition.updatedAt.toMillis(),
  };
}

// The plan path fails the whole call on a malformed link; the scan hands in
// its own reporter so one bad book is dropped from the page instead.
function linkFrom(
  snapshot: DocumentSnapshot,
  fail: CatalogDataFail = (message) => {
    throw new Error(message);
  },
): LinkState {
  const workId = snapshot.get("workId");
  const editionId = snapshot.get("editionId");
  const matchMethod = snapshot.get("matchMethod");
  const linkedAt = snapshot.get("linkedAt");
  if (workId !== undefined && workId !== null && typeof workId !== "string" ||
      editionId !== undefined && editionId !== null && typeof editionId !== "string" ||
      matchMethod !== undefined && matchMethod !== null &&
        (typeof matchMethod !== "string" ||
         !MATCH_METHODS.includes(matchMethod as MatchMethod)) ||
      linkedAt !== undefined && linkedAt !== null && !(linkedAt instanceof Timestamp)) {
    fail(`Invalid catalog link at ${snapshot.ref.path}.`);
  }
  return {
    workId: workId ?? null,
    editionId: editionId ?? null,
    matchMethod: matchMethod ?? null,
    linkedAt: linkedAt instanceof Timestamp ? linkedAt.toMillis() : null,
  };
}

async function repointIsbnBookChanges(
  reader: PlanReader,
  db: Firestore,
  editionIds: readonly string[],
  target: {workId: string; editionId: string},
  nextIsbn13: string,
  now: Timestamp,
): Promise<{changes: PlannedChange[]; versions: AdminCatalogExpected["books"]}> {
  const snapshots = new Map<string, DocumentSnapshot>();
  for (const editionId of new Set(editionIds)) {
    const linked = await many(reader, db.collectionGroup("books")
      .where("editionId", "==", editionId)
      .limit(MAX_LINKED_EDITION_BOOKS + 1));
    if (linked.size > MAX_LINKED_EDITION_BOOKS) operationTooLarge();
    for (const snapshot of linked.docs) {
      if (snapshot.get("matchMethod") === "isbn") snapshots.set(snapshot.ref.path, snapshot);
    }
  }
  const affected = [...snapshots.values()];
  if (affected.length > MAX_LINKED_EDITION_BOOKS) operationTooLarge();
  await validateLinkOwners(reader, db, affected);
  const versions = affected.map((snapshot) => {
    const path = snapshot.ref.path.split("/");
    return bookVersion(
      snapshot,
      {uid: path[1], bookId: path[3]},
      normalizeIsbn13(snapshot.get("isbn")),
    );
  });
  const changes = affected.map((snapshot) => {
    const before = linkFrom(snapshot);
    if (before.workId === null) {
      failedPrecondition("ISBN-derived book has no work.", "catalog-invariant");
    }
    const keepsIsbnProvenance = normalizeIsbn13(snapshot.get("isbn")) === nextIsbn13;
    const after: LinkState = keepsIsbnProvenance ? {
      workId: target.workId,
      editionId: target.editionId,
      matchMethod: "isbn",
      linkedAt: now.toMillis(),
    } : {
      workId: before.workId,
      editionId: null,
      matchMethod: "admin",
      linkedAt: now.toMillis(),
    };
    return change(
      "book",
      snapshot.ref,
      "update",
      before,
      after,
      {type: "set", data: {...after, linkedAt: now}},
    );
  });
  return {changes, versions};
}

function bookVersion(
  snapshot: DocumentSnapshot,
  target: AdminBookTarget,
  decisionIsbn13: string | null = null,
) {
  if (!snapshot.exists) failedPrecondition("Personal book no longer exists.", "catalog-invariant");
  return {
    uid: target.uid,
    bookId: target.bookId,
    ...linkFrom(snapshot),
    decisionIsbn13,
  };
}

async function validateLinkOwners(
  reader: PlanReader,
  db: Firestore,
  snapshots: DocumentSnapshot[],
): Promise<void> {
  const users = new Map<string, DocumentSnapshot>();
  for (const snapshot of snapshots) {
    if (!snapshot.exists) failedPrecondition("Personal book no longer exists.", "catalog-invariant");
    const path = snapshot.ref.path.split("/");
    const uid = path[1];
    const owner = snapshot.get("owner") as {path?: unknown} | undefined;
    if (path.length !== 4 || path[0] !== "users" || path[2] !== "books" ||
        owner?.path !== `users/${uid}`) {
      failedPrecondition("Personal book owner is missing or forged.", "catalog-invariant");
    }
    if (!users.has(uid)) {
      users.set(uid, await one(reader, db.collection("users").doc(uid)));
    }
    const user = users.get(uid)!;
    if (!user.exists || user.get("deletedAt") !== undefined) {
      failedPrecondition("Personal book owner is missing or deleted.", "catalog-invariant");
    }
  }
}

function versionOf(
  kind: CatalogVersion["kind"],
  snapshot: DocumentSnapshot,
): CatalogVersion {
  if (!snapshot.exists) return {kind, id: snapshot.id, exists: false, updatedAt: null};
  // Firestore stamps every existing document; without it the apply-time
  // comparison would silently accept any concurrent edit.
  const updateTime = snapshot.updateTime;
  if (updateTime === undefined) {
    throw new Error(`Missing update time for ${snapshot.ref.path}.`);
  }
  return {kind, id: snapshot.id, exists: true, updatedAt: updateTime.toMillis()};
}

function change(
  kind: PlannedChange["kind"],
  ref: DocumentReference,
  action: PlannedChange["action"],
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  write: PlannedChange["write"],
): PlannedChange {
  return {kind, id: ref.id, action, before, after, ref, write};
}

async function one(
  reader: PlanReader,
  ref: DocumentReference,
): Promise<DocumentSnapshot> {
  return await reader.get(ref) as DocumentSnapshot;
}

async function many(reader: PlanReader, query: Query): Promise<QuerySnapshot> {
  return await reader.get(query) as QuerySnapshot;
}

async function ensureCollectionCapacity(
  reader: PlanReader,
  query: Query,
  maximum: number,
  additions: number,
  collection: string,
): Promise<void> {
  if (additions <= 0) return;
  const rows = await many(reader, query.limit(maximum + 1));
  if (rows.size + additions > maximum) catalogCapacity(collection, maximum);
}

async function unmergedWork(
  reader: PlanReader,
  db: Firestore,
  workId: string,
): Promise<{snapshot: DocumentSnapshot; work: WorkData}> {
  const snapshot = await one(reader, db.collection("works").doc(workId));
  const work = workFrom(snapshot);
  if (work.status === "merged") {
    failedPrecondition("Operation target must not be a merged work.", "catalog-invariant");
  }
  return {snapshot, work};
}

async function activeAuthor(
  reader: PlanReader,
  db: Firestore,
  authorId: string,
): Promise<{snapshot: DocumentSnapshot; author: AuthorData}> {
  const snapshot = await one(reader, db.collection("catalogAuthors").doc(authorId));
  const author = authorFrom(snapshot);
  if (author.status !== "active") {
    failedPrecondition("Operation target must be an active catalog author.", "catalog-invariant");
  }
  return {snapshot, author};
}

async function validateWorkAuthors(
  reader: PlanReader,
  db: Firestore,
  authorIds: readonly string[],
): Promise<CatalogVersion[]> {
  const authors = await Promise.all(authorIds.map((authorId) =>
    activeAuthor(reader, db, authorId),
  ));
  return authors.map(({snapshot}) => versionOf("author", snapshot));
}

async function titleIndexChanges(
  reader: PlanReader,
  db: Firestore,
  workId: string,
  work: WorkData,
): Promise<{changes: PlannedChange[]; versions: CatalogVersion[]}> {
  const existing = await many(
    reader,
    db.collection("workTitleIndex").where("workId", "==", workId).limit(22),
  );
  if (existing.size > 21) operationTooLarge();
  // Each key keeps the spelling it was derived from; workInputData derives
  // the keys from these same titles, so a key with no title is corruption.
  const titles = new Map<string, string>();
  for (const title of [work.canonicalTitle, ...work.alternateTitles]) {
    const key = normalizeCatalogTitle(title);
    if (key !== "" && !titles.has(key)) titles.set(key, title);
  }
  const desired = new Map(work.titleKeys.map((titleKey) => {
    const title = titles.get(titleKey);
    if (title === undefined) {
      catalogInvariant(`Work ${workId} has title key ${titleKey} with no title.`);
    }
    return [
      titleIndexId(workId, titleKey),
      titleIndexRow(workId, title, titleKey, work.status),
    ] as const;
  }));
  const changes: PlannedChange[] = [];
  const versions = existing.docs.map((snapshot) =>
    versionOf("title-index", snapshot),
  );
  for (const snapshot of existing.docs) {
    const next = desired.get(snapshot.id);
    if (next === undefined) {
      changes.push(change(
        "title-index", snapshot.ref, "delete", snapshot.data(), null, {type: "delete"},
      ));
    } else {
      changes.push(change(
        "title-index", snapshot.ref, "update", snapshot.data(), next,
        {type: "set", data: next},
      ));
      desired.delete(snapshot.id);
    }
  }
  for (const [id, row] of desired) {
    const ref = db.collection("workTitleIndex").doc(id);
    const snapshot = await one(reader, ref);
    if (!versions.some((version) => version.id === id)) {
      versions.push(versionOf("title-index", snapshot));
    }
    if (snapshot.exists) {
      failedPrecondition("Title index is owned by another work.", "catalog-invariant");
    }
    changes.push(change("title-index", ref, "create", null, row, {type: "create", data: row}));
  }
  return {changes, versions};
}

async function externalIndexChanges(
  reader: PlanReader,
  db: Firestore,
  editionId: string,
  workId: string,
  desiredIds: Record<string, string>,
): Promise<{changes: PlannedChange[]; versions: CatalogVersion[]}> {
  const existing = await many(reader, db.collection("externalIdIndex")
    .where("editionId", "==", editionId).limit(11));
  if (existing.size > 10) {
    failedPrecondition("Edition has too many external identifiers.", "catalog-invariant");
  }
  const desired = new Map(Object.entries(desiredIds).map(([provider, id]) => [
    externalIndexId({provider, id}),
    {workId, editionId, provider, externalId: id},
  ]));
  const changes: PlannedChange[] = [];
  const versions: CatalogVersion[] = [];
  for (const snapshot of existing.docs) {
    versions.push(versionOf("external-id", snapshot));
    const next = desired.get(snapshot.id);
    if (next === undefined) {
      changes.push(change(
        "external-id", snapshot.ref, "delete", snapshot.data(), null, {type: "delete"},
      ));
    } else {
      changes.push(change(
        "external-id", snapshot.ref, "update", snapshot.data(), next,
        {type: "set", data: next},
      ));
      desired.delete(snapshot.id);
    }
  }
  for (const [id, row] of desired) {
    const ref = db.collection("externalIdIndex").doc(id);
    const snapshot = await one(reader, ref);
    versions.push(versionOf("external-id", snapshot));
    if (snapshot.exists && snapshot.get("editionId") !== editionId) {
      failedPrecondition("External identifier is already assigned.", "identifier-conflict");
    }
    changes.push(change(
      "external-id", ref, snapshot.exists ? "update" : "create",
      snapshot.data() ?? null, row,
      {type: snapshot.exists ? "set" : "create", data: row},
    ));
  }
  return {changes, versions};
}

async function linkChanges(
  reader: PlanReader,
  db: Firestore,
  targets: AdminBookTarget[],
  target: {workId: string; editionId: string | null} | null,
  now: Timestamp,
  validateTarget = true,
): Promise<{changes: PlannedChange[]; versions: AdminCatalogExpected["books"]}> {
  if (target !== null && validateTarget) {
    const resolved = await unmergedWork(reader, db, target.workId);
    if (target.editionId !== null) {
      const editionSnapshot = await one(
        reader,
        db.collection("editions").doc(target.editionId),
      );
      const edition = editionFrom(editionSnapshot);
      if (edition.workId !== resolved.snapshot.id) {
        failedPrecondition("Edition belongs to another work.", "catalog-invariant");
      }
    }
  }
  const snapshots = await Promise.all(targets.map(({uid, bookId}) =>
    one(reader, db.doc(`users/${uid}/books/${bookId}`)),
  ));
  if (target !== null) await validateLinkOwners(reader, db, snapshots);
  const versions = snapshots.map((snapshot, index) =>
    bookVersion(snapshot, targets[index]),
  );
  const changes = snapshots.map((snapshot) => {
    const before = linkFrom(snapshot);
    const after: LinkState = target === null ? {
      workId: null,
      editionId: null,
      matchMethod: null,
      linkedAt: null,
    } : {
      workId: target.workId,
      editionId: target.editionId,
      matchMethod: "admin",
      linkedAt: now.toMillis(),
    };
    const data = {
      workId: after.workId,
      editionId: after.editionId,
      matchMethod: after.matchMethod,
      linkedAt: target === null ? null : now,
    };
    return change("book", snapshot.ref, "update", before, after, {type: "set", data});
  });
  return {changes, versions};
}

// One document may be versioned twice by one plan (an alias that is also a
// merge source, say). The two readings must agree: collapsing disagreeing
// versions would compare the preview against a state neither side saw.
function collapseVersions<Version>(
  versions: readonly Version[],
  keyOf: (_version: Version) => string,
): Version[] {
  const byKey = new Map<string, Version>();
  for (const version of versions) {
    const key = keyOf(version);
    const prior = byKey.get(key);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(version)) {
      failedPrecondition(
        `Catalog plan disagrees about ${key}.`,
        "catalog-invariant",
      );
    }
    byKey.set(key, version);
  }
  return [...byKey.values()].sort((left, right) =>
    keyOf(left).localeCompare(keyOf(right)),
  );
}

function sortExpected(expected: AdminCatalogExpected): AdminCatalogExpected {
  return {
    catalog: collapseVersions(expected.catalog, (version) =>
      `${version.kind}/${version.id}`,
    ),
    books: collapseVersions(expected.books, (version) =>
      `${version.uid}/${version.bookId}`,
    ),
  };
}

async function planOperation(
  reader: PlanReader,
  db: Firestore,
  operation: AdminCatalogOperation,
  now: Timestamp,
): Promise<Plan> {
  const catalog: CatalogVersion[] = [];
  let books: AdminCatalogExpected["books"] = [];
  const changes: PlannedChange[] = [];
  let canonicalize: Plan["canonicalize"] = null;

  if (operation.type === "upsertAuthor") {
    const ref = db.collection("catalogAuthors").doc(operation.authorId);
    const snapshot = await one(reader, ref);
    catalog.push(versionOf("author", snapshot));
    const current = snapshot.exists ? authorFrom(snapshot) : undefined;
    if (current?.status === "merged") {
      failedPrecondition("Merged catalog authors cannot be edited.", "catalog-invariant");
    }
    if (current === undefined) {
      await ensureCollectionCapacity(
        reader,
        db.collection("catalogAuthors"),
        MAX_CATALOG_AUTHORS,
        1,
        "authors",
      );
    }
    const next = authorInputData(operation.author, now, current);
    const nameMatches = await many(reader, db.collection("catalogAuthors")
      .where("nameKeys", "array-contains-any", next.nameKeys)
      .limit(MAX_CATALOG_AUTHORS + 1));
    if (nameMatches.size > MAX_CATALOG_AUTHORS) operationTooLarge();
    for (const match of nameMatches.docs) {
      if (match.id === operation.authorId) continue;
      const matchingAuthor = authorFrom(match);
      if (matchingAuthor.status === "merged" &&
          matchingAuthor.mergedInto === operation.authorId) continue;
      failedPrecondition(
        "Another catalog author already owns one of these names.",
        "catalog-invariant",
      );
    }
    changes.push(change(
      "author",
      ref,
      current === undefined ? "create" : "update",
      current === undefined ? null : wireAuthor(current),
      wireAuthor(next),
      {type: current === undefined ? "create" : "set", data: {...next}},
    ));
  } else if (operation.type === "mergeAuthors") {
    const source = await activeAuthor(reader, db, operation.sourceAuthorId);
    const target = await activeAuthor(reader, db, operation.targetAuthorId);
    catalog.push(
      versionOf("author", source.snapshot),
      versionOf("author", target.snapshot),
    );
    const absorbed = [...new Set([source.snapshot.id, ...source.author.mergedFrom])];
    const mergedFrom = [...new Set([...target.author.mergedFrom, ...absorbed])];
    if (mergedFrom.length > 29 || mergedFrom.includes(target.snapshot.id)) {
      failedPrecondition("A canonical author may have at most 29 aliases.", "catalog-invariant");
    }
    const aliases = await Promise.all(absorbed.map((authorId) =>
      one(reader, db.collection("catalogAuthors").doc(authorId)),
    ));
    for (const alias of aliases) {
      const old = authorFrom(alias);
      catalog.push(versionOf("author", alias));
      const next: AuthorData = {
        ...old,
        status: "merged",
        mergedInto: target.snapshot.id,
        mergedFrom: [],
        updatedAt: now,
      };
      changes.push(change(
        "author", alias.ref, "update", wireAuthor(old), wireAuthor(next),
        {type: "set", data: {...next}},
      ));
    }
    const aliasCandidates = [
      ...target.author.alternateNames,
      source.author.canonicalName,
      ...source.author.alternateNames,
    ];
    const canonicalKey = normalizeCatalogIdentity(target.author.canonicalName);
    const aliasesByKey = new Map<string, string>();
    for (const name of aliasCandidates) {
      const key = normalizeCatalogIdentity(name);
      if (key !== canonicalKey && !aliasesByKey.has(key)) aliasesByKey.set(key, name);
    }
    const nextTarget = authorInputData({
      canonicalName: target.author.canonicalName,
      alternateNames: [...aliasesByKey.values()],
      sortName: target.author.sortName,
      kind: target.author.kind,
    }, now, {...target.author, mergedFrom});
    nextTarget.mergedFrom = mergedFrom;
    if (nextTarget.alternateNames.length > 20) {
      failedPrecondition("Merged author aliases exceed the catalog limit.", "catalog-invariant");
    }
    changes.push(change(
      "author",
      target.snapshot.ref,
      "update",
      wireAuthor(target.author),
      wireAuthor(nextTarget),
      {type: "set", data: {...nextTarget}},
    ));
    // The transaction touches only the author documents, so a merge never
    // refuses on the size of the author's catalog or readership; the works
    // and live-account books naming an absorbed id are canonicalized right
    // after it commits, in pages (canonicalizeMergedAuthorReferrers).
    // Until that sweep lands — seconds — and forever for books in
    // tombstoned accounts (frozen), the alias resolves in one hop
    // everywhere, so reading data is never wrong in the gap.
    canonicalize = {absorbed, targetId: target.snapshot.id};
  } else if (operation.type === "createWork") {
    const ref = db.collection("works").doc(operation.workId);
    const snapshot = await one(reader, ref);
    catalog.push(versionOf("work", snapshot));
    if (snapshot.exists) failedPrecondition("Work ID already exists.", "catalog-invariant");
    await ensureCollectionCapacity(
      reader, db.collection("works"), MAX_WORKS, 1, "works",
    );
    catalog.push(...await validateWorkAuthors(reader, db, operation.work.authorIds));
    // Catalog data is public whoever contributed it: any personal book may
    // seed a work, so no consent check sits here.
    const work = workInputData(operation.work, operation.status, now);
    changes.push(change("work", ref, "create", null, wireWork(work), {
      type: "create", data: {...work},
    }));
    const indexes = await titleIndexChanges(reader, db, operation.workId, work);
    changes.push(...indexes.changes);
    catalog.push(...indexes.versions);
    const linked = await linkChanges(
      reader,
      db,
      operation.books,
      {workId: operation.workId, editionId: null},
      now,
      false,
    );
    changes.push(...linked.changes);
    books = linked.versions;
  } else if (operation.type === "linkBooks") {
    const linked = await linkChanges(reader, db, operation.books, operation.target, now);
    changes.push(...linked.changes);
    books = linked.versions;
    if (operation.target !== null) {
      const workSnapshot = await one(
        reader, db.collection("works").doc(operation.target.workId),
      );
      catalog.push(versionOf("work", workSnapshot));
      if (operation.target.editionId !== null) {
        catalog.push(versionOf("edition", await one(
          reader, db.collection("editions").doc(operation.target.editionId),
        )));
      }
    }
  } else if (operation.type === "editWork") {
    const current = await unmergedWork(reader, db, operation.workId);
    catalog.push(versionOf("work", current.snapshot));
    catalog.push(...await validateWorkAuthors(reader, db, operation.work.authorIds));
    const next = workInputData(operation.work, operation.status, now, current.work);
    changes.push(change(
      "work", current.snapshot.ref, "update", wireWork(current.work), wireWork(next),
      {type: "set", data: {...next}},
    ));
    const indexes = await titleIndexChanges(reader, db, operation.workId, next);
    changes.push(...indexes.changes);
    catalog.push(...indexes.versions);
  } else if (operation.type === "mergeWorks") {
    const target = await unmergedWork(reader, db, operation.targetWorkId);
    catalog.push(versionOf("work", target.snapshot));
    const sources = await Promise.all(operation.sourceWorkIds.map((id) =>
      unmergedWork(reader, db, id),
    ));
    catalog.push(...sources.map(({snapshot}) => versionOf("work", snapshot)));
    const absorbed = [...new Set(sources.flatMap(({snapshot, work}) =>
      [snapshot.id, ...work.mergedFrom],
    ))];
    const mergedFrom = [...new Set([...target.work.mergedFrom, ...absorbed])];
    if (mergedFrom.length > 29 || mergedFrom.includes(target.snapshot.id)) {
      failedPrecondition("A canonical work may have at most 29 aliases.", "catalog-invariant");
    }
    const aliases = await Promise.all(absorbed.map((id) =>
      one(reader, db.collection("works").doc(id)),
    ));
    catalog.push(...aliases.map((snapshot) => versionOf("work", snapshot)));
    for (const alias of aliases) {
      const old = workFrom(alias);
      const next: WorkData = {
        ...old,
        status: "merged",
        mergedInto: target.snapshot.id,
        mergedFrom: [],
        updatedAt: now,
      };
      changes.push(change(
        "work", alias.ref, "update", wireWork(old), wireWork(next),
        {type: "set", data: {...next}},
      ));
    }
    const sourceTitles = sources.flatMap(({work}) =>
      [work.canonicalTitle, ...work.alternateTitles],
    );
    const alternateTitles = [...new Set([
      ...target.work.alternateTitles,
      ...sourceTitles.filter((title) => title !== target.work.canonicalTitle),
    ])];
    if (alternateTitles.length > 20) {
      failedPrecondition("Merged title aliases exceed the catalog limit.", "catalog-invariant");
    }
    const nextTarget = workInputData({
      canonicalTitle: target.work.canonicalTitle,
      alternateTitles,
      authorIds: target.work.authorIds,
      coverUrl: target.work.coverUrl,
      subjects: target.work.subjects,
      fiction: target.work.fiction,
    }, target.work.status, now, {...target.work, mergedFrom});
    nextTarget.mergedFrom = mergedFrom;
    changes.push(change(
      "work", target.snapshot.ref, "update", wireWork(target.work), wireWork(nextTarget),
      {type: "set", data: {...nextTarget}},
    ));
    const editionRows = await many(reader, db.collection("editions")
      .where("workId", "in", absorbed).limit(MAX_EDITIONS + 1));
    if (editionRows.size > MAX_EDITIONS) operationTooLarge();
    for (const snapshot of editionRows.docs) {
      const old = editionFrom(snapshot);
      catalog.push(versionOf("edition", snapshot));
      const next = {...old, workId: target.snapshot.id, updatedAt: now};
      changes.push(change(
        "edition", snapshot.ref, "update", wireEdition(old), wireEdition(next),
        {type: "set", data: next},
      ));
    }
    const isbnRows = await many(reader, db.collection("isbnIndex")
      .where("workId", "in", absorbed).limit(MAX_ISBN_INDEXES + 1));
    if (isbnRows.size > MAX_ISBN_INDEXES) operationTooLarge();
    for (const snapshot of isbnRows.docs) {
      catalog.push(versionOf("isbn", snapshot));
      const next = {...snapshot.data(), workId: target.snapshot.id};
      changes.push(change(
        "isbn", snapshot.ref, "update", snapshot.data(), next,
        {type: "set", data: next},
      ));
    }
    const externalRows = await many(reader, db.collection("externalIdIndex")
      .where("workId", "in", absorbed).limit(MAX_EXTERNAL_ID_INDEXES + 1));
    if (externalRows.size > MAX_EXTERNAL_ID_INDEXES) operationTooLarge();
    for (const snapshot of externalRows.docs) {
      catalog.push(versionOf("external-id", snapshot));
      const next = {...snapshot.data(), workId: target.snapshot.id};
      changes.push(change(
        "external-id", snapshot.ref, "update", snapshot.data(), next,
        {type: "set", data: next},
      ));
    }
    for (const sourceId of absorbed) {
      const indexes = await many(reader, db.collection("workTitleIndex")
        .where("workId", "==", sourceId).limit(22));
      for (const snapshot of indexes.docs) {
        catalog.push(versionOf("title-index", snapshot));
        changes.push(change(
          "title-index", snapshot.ref, "delete", snapshot.data(), null, {type: "delete"},
        ));
      }
    }
    const targetIndexes = await titleIndexChanges(
      reader, db, target.snapshot.id, nextTarget,
    );
    changes.push(...targetIndexes.changes);
    catalog.push(...targetIndexes.versions);
  } else if (operation.type === "upsertEdition") {
    const work = await unmergedWork(reader, db, operation.workId);
    catalog.push(versionOf("work", work.snapshot));
    const ref = db.collection("editions").doc(operation.editionId);
    const snapshot = await one(reader, ref);
    catalog.push(versionOf("edition", snapshot));
    const old = snapshot.exists ? editionFrom(snapshot) : undefined;
    if (old === undefined) {
      await ensureCollectionCapacity(
        reader, db.collection("editions"), MAX_EDITIONS, 1, "editions",
      );
    }
    if (old !== undefined && old.isbn13 !== operation.edition.isbn13) {
      failedPrecondition("Use repointIsbn to change an edition ISBN.", "identifier-conflict");
    }
    if (old === undefined && operation.edition.isbn13 !== null) {
      const isbn = await one(reader, db.collection("isbnIndex").doc(operation.edition.isbn13));
      catalog.push(versionOf("isbn", isbn));
      if (isbn.exists) failedPrecondition("ISBN is already assigned.", "identifier-conflict");
      await ensureCollectionCapacity(
        reader, db.collection("isbnIndex"), MAX_ISBN_INDEXES, 1, "ISBN indexes",
      );
      const row = {workId: operation.workId, editionId: operation.editionId};
      changes.push(change("isbn", isbn.ref, "create", null, row, {type: "create", data: row}));
    }
    const next = editionInputData(operation.workId, operation.edition, now, old);
    changes.push(change(
      "edition", ref, old === undefined ? "create" : "update",
      old === undefined ? null : wireEdition(old), wireEdition(next),
      {type: old === undefined ? "create" : "set", data: {...next}},
    ));
    const external = await externalIndexChanges(
      reader,
      db,
      operation.editionId,
      operation.workId,
      operation.edition.externalIds,
    );
    catalog.push(...external.versions);
    const externalAdditions = external.changes.filter(({action}) => action === "create").length -
      external.changes.filter(({action}) => action === "delete").length;
    await ensureCollectionCapacity(
      reader,
      db.collection("externalIdIndex"),
      MAX_EXTERNAL_ID_INDEXES,
      externalAdditions,
      "external ID indexes",
    );
    changes.push(...external.changes);
    if (old !== undefined && old.workId !== operation.workId) {
      const linked = await many(reader, db.collectionGroup("books")
        .where("editionId", "==", operation.editionId)
        .limit(MAX_LINKED_EDITION_BOOKS + 1));
      if (linked.size > MAX_LINKED_EDITION_BOOKS) operationTooLarge();
      await validateLinkOwners(reader, db, linked.docs);
      books = linked.docs.map((book) => {
        const path = book.ref.path.split("/");
        return bookVersion(book, {uid: path[1], bookId: path[3]});
      });
      for (const book of linked.docs) {
        const before = linkFrom(book);
        const after = {
          workId: operation.workId,
          editionId: operation.editionId,
          matchMethod: "admin" as const,
          linkedAt: now.toMillis(),
        };
        changes.push(change(
          "book", book.ref, "update", before, after,
          {type: "set", data: {...after, linkedAt: now}},
        ));
      }
      if (old.isbn13 !== null) {
        const isbn = await one(reader, db.collection("isbnIndex").doc(old.isbn13));
        catalog.push(versionOf("isbn", isbn));
        if (!isbn.exists || isbn.get("editionId") !== operation.editionId ||
            isbn.get("workId") !== old.workId) {
          failedPrecondition(
            "Edition ISBN index is missing or owned elsewhere.",
            "catalog-invariant",
          );
        }
        const row = {workId: operation.workId, editionId: operation.editionId};
        changes.push(change(
          "isbn", isbn.ref, "update", isbn.data() ?? null, row,
          {type: "set", data: row},
        ));
      }
    }
  } else if (operation.type === "repointIsbn") {
    const targetSnapshot = await one(
      reader, db.collection("editions").doc(operation.editionId),
    );
    const target = editionFrom(targetSnapshot);
    catalog.push(versionOf("edition", targetSnapshot));
    const isbnRef = db.collection("isbnIndex").doc(operation.isbn13);
    const isbn = await one(reader, isbnRef);
    catalog.push(versionOf("isbn", isbn));
    const oldEditionId = isbn.exists ? isbn.get("editionId") : null;
    if (oldEditionId !== null && typeof oldEditionId !== "string") {
      throw new Error(`Invalid ISBN index ${isbn.ref.path}.`);
    }
    if (oldEditionId !== null && oldEditionId !== operation.editionId) {
      const oldSnapshot = await one(reader, db.collection("editions").doc(oldEditionId));
      catalog.push(versionOf("edition", oldSnapshot));
      if (oldSnapshot.exists) {
        const old = editionFrom(oldSnapshot);
        if (old.isbn13 === operation.isbn13) {
          const cleared = {...old, isbn13: null, updatedAt: now};
          changes.push(change(
            "edition", oldSnapshot.ref, "update", wireEdition(old), wireEdition(cleared),
            {type: "set", data: cleared},
          ));
        }
      }
    }
    if (target.isbn13 !== null && target.isbn13 !== operation.isbn13) {
      const priorRef = db.collection("isbnIndex").doc(target.isbn13);
      const prior = await one(reader, priorRef);
      catalog.push(versionOf("isbn", prior));
      if (prior.exists && prior.get("editionId") === operation.editionId) {
        changes.push(change(
          "isbn", priorRef, "delete", prior.data() ?? null, null, {type: "delete"},
        ));
      }
    }
    const nextTarget = {...target, isbn13: operation.isbn13, updatedAt: now};
    changes.push(change(
      "edition", targetSnapshot.ref, "update", wireEdition(target), wireEdition(nextTarget),
      {type: "set", data: nextTarget},
    ));
    const isbnRow = {workId: target.workId, editionId: operation.editionId};
    changes.push(change(
      "isbn", isbnRef, isbn.exists ? "update" : "create", isbn.data() ?? null,
      isbnRow, {type: isbn.exists ? "set" : "create", data: isbnRow},
    ));
    const repairedBooks = await repointIsbnBookChanges(
      reader,
      db,
      [operation.editionId, ...(oldEditionId === null ? [] : [oldEditionId])],
      {workId: target.workId, editionId: operation.editionId},
      operation.isbn13,
      now,
    );
    changes.push(...repairedBooks.changes);
    books = repairedBooks.versions;
  }

  const byPath = new Map<string, PlannedChange>();
  for (const planned of changes) byPath.set(planned.ref.path, planned);
  const deduplicated = [...byPath.values()];
  if (deduplicated.length + 1 > MAX_TOUCHED_DOCUMENTS) operationTooLarge();
  return {
    expected: sortExpected({catalog, books}),
    changes: deduplicated,
    canonicalize,
  };
}

function wireChanges(changes: PlannedChange[]) {
  return changes.map(({kind, id, action, before, after}) => ({
    kind, id, action, before, after,
  }));
}

export async function previewAdminCatalogOperation(
  db: Firestore,
  operation: AdminCatalogOperation,
) {
  const reader: PlanReader = {get: async (value) => value.get()};
  const plan = await planOperation(reader, db, operation, Timestamp.now());
  return {
    operationId: randomUUID(),
    operationHash: operationHash(operation),
    expected: plan.expected,
    changes: wireChanges(plan.changes),
    touchedDocuments: plan.changes.length + 1,
  };
}

function expectedEqual(
  left: AdminCatalogExpected,
  right: AdminCatalogExpected,
): boolean {
  return JSON.stringify(sortExpected(left)) === JSON.stringify(sortExpected(right));
}

// A merge pays its whole cost up front: after the atomic author redirect
// commits, every work and live-account book naming an absorbed id is
// rewritten to the canonical id here, in id-ordered pages of batched
// writes, so no per-transaction ceiling applies. This is a repair pass,
// not a correctness requirement — every reader resolves the one-hop alias,
// which also covers the seconds before this lands, a crash between pages
// (the scan reports leftover aliases), and books in tombstoned accounts,
// which stay frozen on the alias. Book updatedAt is never touched: it
// drives the reading-list order.
const CANONICALIZE_PAGE = 200;

async function canonicalizeMergedAuthorReferrers(
  db: Firestore,
  {absorbed, targetId}: NonNullable<Plan["canonicalize"]>,
): Promise<void> {
  const rewrite = (value: unknown, path: string): string[] => {
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
      throw new Error(`${path}.authorIds must be a string array.`);
    }
    return [...new Set(value.map((id) => (absorbed.includes(id) ? targetId : id)))];
  };
  let works = 0;
  let liveBooks = 0;
  let frozenBooks = 0;
  for (const authorId of absorbed) {
    for (const scope of ["works", "books"] as const) {
      let cursor: QueryDocumentSnapshot | null = null;
      for (;;) {
        let query = (scope === "works" ? db.collection("works") : db.collectionGroup("books"))
          .where("authorIds", "array-contains", authorId)
          .orderBy(FieldPath.documentId())
          .limit(CANONICALIZE_PAGE);
        if (cursor !== null) query = query.startAfter(cursor);
        const page = await query.get();
        if (page.docs.length === 0) break;
        let live = new Set<string>();
        if (scope === "books") {
          const owners = [...new Set(page.docs.map((snapshot) => {
            const path = snapshot.ref.path.split("/");
            if (path.length !== 4 || path[0] !== "users" || path[2] !== "books") {
              throw new Error(`Unexpected personal book path ${snapshot.ref.path}.`);
            }
            return path[1];
          }))];
          const users = await db.getAll(...owners.map((uid) => db.collection("users").doc(uid)));
          live = new Set(users.filter((snapshot) =>
            snapshot.exists && snapshot.get("deletedAt") === undefined,
          ).map(({id}) => id));
        }
        const batch = db.batch();
        for (const snapshot of page.docs) {
          if (scope === "works") {
            batch.update(snapshot.ref, {
              authorIds: rewrite(snapshot.get("authorIds"), snapshot.ref.path),
              updatedAt: Timestamp.now(),
            });
            works += 1;
          } else if (live.has(snapshot.ref.path.split("/")[1])) {
            batch.update(snapshot.ref, {
              authorIds: rewrite(snapshot.get("authorIds"), snapshot.ref.path),
            });
            liveBooks += 1;
          } else {
            frozenBooks += 1;
          }
        }
        await batch.commit();
        cursor = page.docs[page.docs.length - 1];
        if (page.docs.length < CANONICALIZE_PAGE) break;
      }
    }
  }
  logger.info("admin.catalog.merge_canonicalized", {
    targetId, absorbed, works, liveBooks, frozenBooks,
  });
}

export async function applyAdminCatalogOperation(
  db: Firestore,
  adminUid: string,
  request: AdminCatalogApplyRequest,
) {
  const hash = operationHash(request.operation);
  const auditRef = db.collection("adminAudit").doc(request.operationId);
  let canonicalize: Plan["canonicalize"] = null;
  const result = await db.runTransaction(async (transaction) => {
    const existingAudit = await transaction.get(auditRef);
    if (existingAudit.exists) {
      if (existingAudit.get("operationHash") !== hash) {
        failedPrecondition("Operation ID was already used.", "catalog-invariant");
      }
      return existingAudit.get("result");
    }
    const reader: PlanReader = {
      get: async (value) => transaction.get(value as DocumentReference),
    };
    const now = Timestamp.now();
    const plan = await planOperation(reader, db, request.operation, now);
    canonicalize = plan.canonicalize;
    if (!expectedEqual(plan.expected, request.expected)) {
      throw new functions.https.HttpsError(
        "aborted",
        "Catalog state changed after preview.",
        {reason: "stale-preview"},
      );
    }
    for (const planned of plan.changes) {
      if (planned.write.type === "delete") transaction.delete(planned.ref);
      else if (planned.write.type === "create") {
        transaction.create(planned.ref, planned.write.data);
      } else {
        if (planned.kind === "book") {
          transaction.set(planned.ref, planned.write.data, {merge: true});
        } else {
          transaction.set(planned.ref, planned.write.data);
        }
      }
    }
    const applied = {
      operationId: request.operationId,
      applied: true as const,
      touchedDocuments: plan.changes.length + 1,
    };
    const audit = {
      type: "catalog-mutation",
      operationType: request.operation.type,
      operationId: request.operationId,
      operationHash: hash,
      uid: adminUid,
      at: now,
      expiresAt: Timestamp.fromMillis(now.toMillis() + AUDIT_RETENTION_MS),
      touchedDocuments: applied.touchedDocuments,
      beforeAfter: wireChanges(plan.changes),
      result: applied,
    };
    if (Buffer.byteLength(JSON.stringify(audit), "utf8") > MAX_AUDIT_BYTES) {
      operationTooLarge();
    }
    transaction.create(auditRef, audit);
    return applied;
  });
  // Only a fresh apply sweeps: an idempotent replay returned the audited
  // result above without re-planning, and the first pass already ran it.
  if (canonicalize !== null) await canonicalizeMergedAuthorReferrers(db, canonicalize);
  return result;
}

function tokenAgreement(left: string, right: string): number {
  const leftTokens = new Set(normalizeCatalogIdentity(left).split(" ").filter(Boolean));
  const rightTokens = new Set(normalizeCatalogIdentity(right).split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / new Set([...leftTokens, ...rightTokens]).size;
}

function ensureBound(snapshot: QuerySnapshot, maximum: number, label: string): void {
  if (snapshot.size > maximum) {
    throw new functions.https.HttpsError(
      "resource-exhausted",
      `Admin catalog ${label} exceeds the ${maximum}-document bound.`,
    );
  }
}

// The finding codes the console renders (src/routes/admin/catalog). The
// union is the contract: a code added here without a label there shows up
// as a bare string, and the client decoder refuses one it does not know.
export type AdminCatalogFindingCode =
  | "book-row-anomaly"
  | "book-link-anomaly"
  | "unmatched-isbn-candidate"
  | "unmatched-title-author-candidate"
  | "likely-title-author-candidate"
  | "edition-missing-work"
  | "isbn-index-mismatch"
  | "external-id-index-mismatch"
  | "work-invariant"
  | "duplicate-author-name"
  | "suspected-duplicate-works";

interface AdminCatalogFinding {
  code: AdminCatalogFindingCode;
  severity: "error" | "warning";
  message: string;
  workIds: string[];
  editionIds: string[];
  books: AdminBookTarget[];
}

// One malformed personal book is reported and skipped, never coerced into
// a plausible-looking row: the console curates identity, so a silently
// invented title or link is worse than a missing row. Everything else
// still fails the call.
class ScanRowError extends Error {}

const scanRowError: CatalogDataFail = (message) => {
  throw new ScanRowError(message);
};

// Absent is legitimate (a book need not carry a publisher or a cover); a
// value of the wrong type is a schema violation.
function scanText(snapshot: DocumentSnapshot, field: string): string {
  const value = snapshot.get(field);
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    scanRowError(`${snapshot.ref.path}.${field} must be a string.`);
  }
  return value;
}

// A display hint, not identity: an absent or nonsensical page count renders
// as an em dash instead of costing the row.
function scanPageCount(snapshot: DocumentSnapshot): number | null {
  const value = snapshot.get("pageCount");
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ?
    value : null;
}

export async function scanAdminCatalog(db: Firestore, bookCursor: string | null) {
  // A continuation page answers for its hundred books only: the catalog
  // inventory and every catalog-level finding came with the first page and
  // do not change between pages, so they are not re-serialised (and the
  // external ID index, which only feeds them, is not even read). Works stay
  // on the wire because the page's link candidates and per-work book counts
  // are stated against them.
  const firstPage = bookCursor === null;
  let bookQuery = db.collectionGroup("books").orderBy(FieldPath.documentId());
  if (!firstPage) bookQuery = bookQuery.startAfter(db.doc(bookCursor));
  const [
    catalogAuthorRows,
    workRows,
    editionRows,
    bookRows,
    isbnRows,
    externalRows,
  ] =
    await Promise.all([
      db.collection("catalogAuthors").limit(MAX_CATALOG_AUTHORS + 1).get(),
      db.collection("works").limit(MAX_WORKS + 1).get(),
      db.collection("editions").limit(MAX_EDITIONS + 1).get(),
      bookQuery.limit(BOOK_PAGE_SIZE + 1).get(),
      db.collection("isbnIndex").limit(MAX_ISBN_INDEXES + 1).get(),
      firstPage ?
        db.collection("externalIdIndex").limit(MAX_EXTERNAL_ID_INDEXES + 1).get() :
        null,
    ]);
  ensureBound(catalogAuthorRows, MAX_CATALOG_AUTHORS, "catalog authors");
  ensureBound(workRows, MAX_WORKS, "works");
  ensureBound(editionRows, MAX_EDITIONS, "editions");
  ensureBound(isbnRows, MAX_ISBN_INDEXES, "ISBN indexes");
  if (externalRows !== null) {
    ensureBound(externalRows, MAX_EXTERNAL_ID_INDEXES, "external ID indexes");
  }
  const bookPage = bookRows.docs.slice(0, BOOK_PAGE_SIZE);
  const nextBookCursor = bookRows.size > BOOK_PAGE_SIZE ?
    bookPage[bookPage.length - 1]?.ref.path ?? null : null;

  const catalogAuthorById = new Map(catalogAuthorRows.docs.map((snapshot) =>
    [snapshot.id, authorFrom(snapshot)],
  ));
  const workById = new Map(workRows.docs.map((snapshot) =>
    [snapshot.id, workFrom(snapshot)],
  ));
  const editionById = new Map(editionRows.docs.map((snapshot) =>
    [snapshot.id, editionFrom(snapshot)],
  ));
  const isbnMappings = new Map(isbnRows.docs.flatMap((snapshot) => {
    const workId = snapshot.get("workId");
    const editionId = snapshot.get("editionId");
    return typeof workId === "string" && typeof editionId === "string" ?
      [[snapshot.id, {workId, editionId}]] : [];
  }));
  const resolvedWorkId = (workId: string): string | null => {
    const work = workById.get(workId);
    if (work === undefined) return null;
    if (work.status !== "merged") return workId;
    if (work.mergedInto === undefined) return null;
    const target = workById.get(work.mergedInto);
    return target !== undefined && target.status !== "merged" ? work.mergedInto : null;
  };
  const resolvedCatalogAuthorId = (authorId: string): string | null => {
    const author = catalogAuthorById.get(authorId);
    if (author === undefined) return null;
    if (author.status === "active") return authorId;
    if (author.mergedInto === undefined) return null;
    return catalogAuthorById.get(author.mergedInto)?.status === "active" ?
      author.mergedInto : null;
  };
  const catalogAuthorKeySets = (work: WorkData): Array<Set<string>> =>
    work.authorIds.flatMap((authorId) => {
      const resolvedId = resolvedCatalogAuthorId(authorId);
      const author = resolvedId === null ? undefined : catalogAuthorById.get(resolvedId);
      return author === undefined || author.kind === "placeholder" ? [] :
        [new Set([normalizeCatalogIdentity(author.canonicalName), ...author.nameKeys])];
    });
  const exactAuthorSet = (work: WorkData, bookKeys: ReadonlySet<string>): boolean => {
    const sets = catalogAuthorKeySets(work);
    return sets.length > 0 && sets.length === bookKeys.size &&
      sets.every((keys) => [...bookKeys].some((bookKey) => keys.has(bookKey))) &&
      [...bookKeys].every((bookKey) => sets.some((keys) => keys.has(bookKey)));
  };
  const catalogAuthorNames = (work: WorkData): string[] =>
    [...new Set(work.authorIds.flatMap((authorId) => {
      const resolvedId = resolvedCatalogAuthorId(authorId);
      if (resolvedId === null) return [];
      const author = catalogAuthorById.get(resolvedId);
      return author === undefined || author.kind === "placeholder" ? [] :
        [author.canonicalName];
    }))];
  const validSegment = (value: unknown): value is string =>
    typeof value === "string" && value !== "" && !value.includes("/") &&
    Buffer.byteLength(value, "utf8") <= 1500;
  const pageOwners = [...new Set(bookPage.flatMap((snapshot) => {
    const path = snapshot.ref.path.split("/");
    return path.length === 4 && path[0] === "users" && path[2] === "books" &&
      validSegment(path[1]) ? [path[1]] : [];
  }))];
  const userSnapshots = pageOwners.length === 0 ? [] :
    await db.getAll(...pageOwners.map((uid) => db.collection("users").doc(uid)));
  const liveUsers = new Set(userSnapshots.filter((snapshot) =>
    snapshot.exists && snapshot.get("deletedAt") === undefined,
  ).map(({id}) => id));

  const authorProblems = new Set<string>();
  for (const snapshot of bookPage) {
    const ids = snapshot.get("authorIds");
    if (ids === undefined) continue;
    if (!Array.isArray(ids) || ids.length > MAX_AUTHORS_PER_PERSONAL_BOOK ||
        new Set(ids).size !== ids.length || ids.some((id) => !validSegment(id))) {
      authorProblems.add(snapshot.ref.path);
      continue;
    }
    for (const id of ids) {
      if (resolvedCatalogAuthorId(id) === null) authorProblems.add(snapshot.ref.path);
    }
  }
  // The catalog is the only author source: a personal book names authors by
  // catalog ID (migrate-book-author-ids.ts converted the last of the legacy
  // shapes in 2026-08), and the loop above already reported every ID this
  // cannot resolve.
  const authorNames = (snapshot: DocumentSnapshot): string[] => {
    const ids = snapshot.get("authorIds");
    if (!Array.isArray(ids)) return [];
    return [...new Set(ids.flatMap((id) => {
      const resolvedId = typeof id === "string" ? resolvedCatalogAuthorId(id) : null;
      const resolved = resolvedId === null ? undefined : catalogAuthorById.get(resolvedId);
      return resolved === undefined || resolved.kind === "placeholder" ?
        [] : [resolved.canonicalName];
    }))];
  };

  const findings: AdminCatalogFinding[] = [];
  const linkedCounts = new Map<string, number>();
  const books = bookPage.flatMap((snapshot) => {
    const path = snapshot.ref.path.split("/");
    if (path.length !== 4 || path[0] !== "users" || path[2] !== "books") {
      findings.push({
        code: "book-row-anomaly",
        severity: "error",
        message: "Unexpected book collection-group path.",
        workIds: [],
        editionIds: [],
        books: [],
      });
      return [];
    }
    const uid = path[1];
    let row;
    try {
      const rawIsbn = scanText(snapshot, "isbn");
      const isbn13 = normalizeIsbn13(rawIsbn);
      const title = snapshot.get("title");
      if (typeof title !== "string" || title === "") {
        scanRowError(`${snapshot.ref.path}.title must be a non-empty string.`);
      }
      const link = linkFrom(snapshot, scanRowError);
      row = {
        uid,
        bookId: snapshot.id,
        title,
        authorNames: authorNames(snapshot),
        // The same normalizer the link/apply path uses, so an ISBN-10 that
        // apply would happily link is also reported as a candidate here.
        isbn13,
        rawIsbn: isbn13 === null && rawIsbn !== "" ? rawIsbn : null,
        pageCount: scanPageCount(snapshot),
        publisher: scanText(snapshot, "publisher"),
        coverUrl: scanText(snapshot, "coverUrl"),
        workId: link.workId,
        editionId: link.editionId,
      };
    } catch (error) {
      if (!(error instanceof ScanRowError)) throw error;
      findings.push({
        code: "book-row-anomaly",
        severity: "error",
        message: error.message,
        workIds: [],
        editionIds: [],
        books: [{uid, bookId: snapshot.id}],
      });
      return [];
    }
    if (row.workId !== null) {
      const resolved = resolvedWorkId(row.workId) ?? row.workId;
      linkedCounts.set(resolved, (linkedCounts.get(resolved) ?? 0) + 1);
    }
    let anomaly: string | null = !liveUsers.has(uid) ? "orphaned data" :
      authorProblems.has(snapshot.ref.path) ? "missing or malformed author" : null;
    const resolvedBookWork = row.workId === null ? null : resolvedWorkId(row.workId);
    if (row.workId !== null && resolvedBookWork === null) anomaly = "missing or broken work";
    const linkedEdition = row.editionId === null ? null : editionById.get(row.editionId);
    if (row.editionId !== null && linkedEdition === undefined) anomaly = "missing edition";
    if (linkedEdition !== null && linkedEdition !== undefined && resolvedBookWork !== null &&
        resolvedWorkId(linkedEdition.workId) !== resolvedBookWork) {
      anomaly = "edition belongs to another work";
    }
    if (anomaly !== null) findings.push({
      code: "book-link-anomaly",
      severity: "error",
      message: anomaly,
      workIds: row.workId === null ? [] : [row.workId],
      editionIds: row.editionId === null ? [] : [row.editionId],
      books: [{uid, bookId: snapshot.id}],
    });
    return [{...row, anomaly}];
  });
  for (const book of books) {
    if (book.anomaly !== null || book.workId !== null) continue;
    const mapping = book.isbn13 === null ? undefined : isbnMappings.get(book.isbn13);
    if (mapping !== undefined && resolvedWorkId(mapping.workId) !== null) {
      findings.push({
        code: "unmatched-isbn-candidate",
        severity: "warning",
        message: "Unmatched book has an exact catalog ISBN candidate.",
        workIds: [resolvedWorkId(mapping.workId) ?? mapping.workId],
        editionIds: [mapping.editionId],
        books: [{uid: book.uid, bookId: book.bookId}],
      });
      continue;
    }
    const key = normalizeCatalogTitle(book.title);
    const normalizedAuthors = new Set(book.authorNames.map(normalizeCatalogIdentity));
    // "Exact" is the migration contract: the complete normalized author
    // identity agrees, aliases included. A book by [A, B] against a work by
    // [A, C] is partial overlap and stays in the similarity path below —
    // the admin UI offers this label as a one-click link.
    const candidates = [...workById].filter(([, work]) =>
      work.status === "active" && work.titleKeys.includes(key) &&
      exactAuthorSet(work, normalizedAuthors),
    );
    if (candidates.length > 0) {
      findings.push({
        code: "unmatched-title-author-candidate",
        severity: "warning",
        message: "Unmatched book has an exact normalized title and author candidate.",
        workIds: candidates.map(([id]) => id),
        editionIds: [],
        books: [{uid: book.uid, bookId: book.bookId}],
      });
      continue;
    }
    const likely = [...workById].flatMap(([id, work]) => {
      if (work.status !== "active") return [];
      const titleScore = Math.max(...work.titleKeys.map((titleKey) =>
        tokenAgreement(key, titleKey),
      ));
      const authorScore = Math.max(0, ...book.authorNames.flatMap((bookAuthor) =>
        catalogAuthorNames(work).map((workAuthor) => tokenAgreement(bookAuthor, workAuthor)),
      ));
      const score = titleScore * 0.75 + authorScore * 0.25;
      return titleScore >= 0.5 && authorScore >= 0.5 && score >= 0.6 ? [{id, score}] : [];
    }).sort((left, right) => right.score - left.score).slice(0, 5);
    if (likely.length > 0) findings.push({
      code: "likely-title-author-candidate",
      severity: "warning",
      message: "Unmatched book has a similar normalized title and author candidate; confirm manually.",
      workIds: likely.map(({id}) => id),
      editionIds: [],
      books: [{uid: book.uid, bookId: book.bookId}],
    });
  }
  const editionCounts = new Map<string, number>();
  for (const [editionId, edition] of editionById) {
    editionCounts.set(edition.workId, (editionCounts.get(edition.workId) ?? 0) + 1);
    if (firstPage && !workById.has(edition.workId)) findings.push({
      code: "edition-missing-work",
      severity: "error",
      message: "Edition targets a missing work.",
      workIds: [edition.workId],
      editionIds: [editionId],
      books: [],
    });
  }
  if (firstPage) {
    for (const snapshot of isbnRows.docs) {
      const editionId = snapshot.get("editionId");
      const workId = snapshot.get("workId");
      const edition = typeof editionId === "string" ? editionById.get(editionId) : undefined;
      if (edition === undefined || edition.isbn13 !== snapshot.id || edition.workId !== workId) {
        findings.push({
          code: "isbn-index-mismatch",
          severity: "error",
          message: "ISBN index disagrees with its edition.",
          workIds: typeof workId === "string" ? [workId] : [],
          editionIds: typeof editionId === "string" ? [editionId] : [],
          books: [],
        });
      }
    }
  }
  for (const snapshot of externalRows?.docs ?? []) {
    const editionId = snapshot.get("editionId");
    const workId = snapshot.get("workId");
    const provider = snapshot.get("provider");
    const externalId = snapshot.get("externalId");
    const edition = typeof editionId === "string" ? editionById.get(editionId) : undefined;
    if (edition === undefined || edition.workId !== workId ||
        typeof provider !== "string" || typeof externalId !== "string" ||
        edition.externalIds[provider] !== externalId ||
        externalIndexId({provider, id: externalId}) !== snapshot.id) {
      findings.push({
        code: "external-id-index-mismatch",
        severity: "error",
        message: "External ID index disagrees with its edition.",
        workIds: typeof workId === "string" ? [workId] : [],
        editionIds: typeof editionId === "string" ? [editionId] : [],
        books: [],
      });
    }
  }
  const workWarnings = new Map<string, string[]>();
  const catalogAuthorWorkCounts = new Map<string, number>();
  for (const [id, work] of workById) {
    const warnings: string[] = [];
    if (work.status === "merged" &&
        (work.mergedInto === undefined || (workById.get(work.mergedInto)?.status ?? "merged") === "merged")) {
      warnings.push("broken redirect");
    }
    if (work.status !== "merged" && work.mergedFrom.length > 29) {
      warnings.push("too many aliases");
    }
    // Merges canonicalize work references right after the redirect commits,
    // so a surviving alias here means that sweep was interrupted; it still
    // resolves, but the operator should know.
    for (const authorId of work.authorIds) {
      const resolvedId = resolvedCatalogAuthorId(authorId);
      if (resolvedId === null) warnings.push(`broken author reference ${authorId}`);
      else {
        catalogAuthorWorkCounts.set(
          resolvedId,
          (catalogAuthorWorkCounts.get(resolvedId) ?? 0) + 1,
        );
        if (resolvedId !== authorId) warnings.push(`stale author alias ${authorId}`);
      }
    }
    workWarnings.set(id, warnings);
    if (firstPage) {
      for (const warning of warnings) findings.push({
        code: "work-invariant",
        severity: "error",
        message: warning,
        workIds: [id],
        editionIds: [],
        books: [],
      });
    }
  }
  const catalogAuthorWarnings = new Map<string, string[]>();
  if (firstPage) {
    const activeAuthorNameOwners = new Map<string, string[]>();
    for (const [id, author] of catalogAuthorById) {
      const warnings: string[] = [];
      if (author.status === "merged" &&
          (author.mergedInto === undefined ||
           catalogAuthorById.get(author.mergedInto)?.status !== "active")) {
        warnings.push("broken redirect");
      }
      if (author.status === "active" && author.mergedFrom.length > 29) {
        warnings.push("too many aliases");
      }
      const expectedNameKeys = [...new Set(
        [author.canonicalName, ...author.alternateNames].map(normalizeCatalogIdentity),
      )];
      if (JSON.stringify(author.nameKeys) !== JSON.stringify(expectedNameKeys)) {
        warnings.push("name index mismatch");
      }
      if (author.status === "active") {
        for (const key of author.nameKeys) {
          activeAuthorNameOwners.set(key, [...(activeAuthorNameOwners.get(key) ?? []), id]);
        }
      }
      catalogAuthorWarnings.set(id, warnings);
    }
    for (const [nameKey, authorIds] of activeAuthorNameOwners) {
      if (authorIds.length < 2) continue;
      findings.push({
        code: "duplicate-author-name",
        severity: "error",
        message: `Active catalog authors share normalized name ${nameKey}.`,
        workIds: [],
        editionIds: [],
        books: [],
      });
      for (const authorId of authorIds) {
        catalogAuthorWarnings.get(authorId)?.push(`duplicate name ${nameKey}`);
      }
    }
    const identities = new Map<string, string[]>();
    for (const [id, work] of workById) {
      if (work.status !== "active") continue;
      const authorsKey = work.authorIds.map((authorId) => resolvedCatalogAuthorId(authorId) ?? authorId)
        .sort().join("\0");
      for (const titleKey of work.titleKeys) {
        const key = `${titleKey}\0${authorsKey}`;
        identities.set(key, [...(identities.get(key) ?? []), id]);
      }
    }
    const duplicateSets = new Set<string>();
    for (const ids of identities.values()) {
      if (ids.length < 2) continue;
      const workIds = [...new Set(ids)].sort();
      const key = workIds.join("\0");
      if (duplicateSets.has(key)) continue;
      duplicateSets.add(key);
      findings.push({
        code: "suspected-duplicate-works",
        severity: "warning",
        message: "Active works share an exact normalized title and author set.",
        workIds,
        editionIds: [],
        books: [],
      });
    }
  }
  return {
    authors: !firstPage ? [] : [...catalogAuthorById].map(([authorId, author]) => ({
      authorId,
      canonicalName: author.canonicalName,
      alternateNames: author.alternateNames,
      sortName: author.sortName,
      kind: author.kind,
      status: author.status,
      mergedFrom: author.mergedFrom,
      workCount: catalogAuthorWorkCounts.get(authorId) ?? 0,
      warnings: catalogAuthorWarnings.get(authorId) ?? [],
    })),
    works: [...workById].map(([workId, work]) => ({
      workId,
      canonicalTitle: work.canonicalTitle,
      alternateTitles: work.alternateTitles,
      authorIds: work.authorIds,
      coverUrl: work.coverUrl,
      subjects: work.subjects,
      fiction: work.fiction,
      status: work.status,
      mergedFrom: work.mergedFrom,
      createdBy: work.createdBy ?? null,
      createdAt: work.createdAt.toMillis(),
      editionCount: editionCounts.get(workId) ?? 0,
      linkedBookCount: linkedCounts.get(workId) ?? 0,
      warnings: workWarnings.get(workId) ?? [],
    })),
    editions: !firstPage ? [] : [...editionById].map(([editionId, edition]) => ({
      editionId,
      workId: edition.workId,
      isbn13: edition.isbn13,
      title: edition.title,
      publisher: edition.publisher,
      publishedDate: edition.publishedDate,
      language: edition.language,
      translatorNames: edition.translatorNames,
      format: edition.format,
      suggestedPageCount: edition.suggestedPageCount,
      coverUrl: edition.coverUrl,
      externalIds: edition.externalIds,
    })),
    books,
    nextBookCursor,
    bookCountsComplete: firstPage && nextBookCursor === null,
    findings,
    limits: {
      catalogAuthors: MAX_CATALOG_AUTHORS,
      works: MAX_WORKS,
      books: BOOK_PAGE_SIZE,
    },
  };
}
