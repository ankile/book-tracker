import * as functions from "firebase-functions/v1";
import {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Query,
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
  AdminReviewRequest,
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
import {CATALOG_LIMITS} from "./shared/catalogLimits";
import {effectiveLanguage} from "./shared/language";

const MAX_WORKS = CATALOG_LIMITS.works;
const MAX_CATALOG_AUTHORS = CATALOG_LIMITS.catalogAuthors;
const MAX_EDITIONS = CATALOG_LIMITS.editions;
const MAX_ISBN_INDEXES = CATALOG_LIMITS.isbnIndexes;
const MAX_EXTERNAL_ID_INDEXES = CATALOG_LIMITS.externalIdIndexes;
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
  // When the operator last marked the work reviewed (admin.review);
  // absent until then. Edits keep it; only admin.review moves it.
  reviewedAt?: Timestamp;
}

interface AuthorData extends StoredCatalogAuthor {
  createdAt: Timestamp;
  updatedAt: Timestamp;
  reviewedAt?: Timestamp;
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

function optionalStoredTimestamp(
  snapshot: DocumentSnapshot,
  field: string,
): {[key: string]: Timestamp} {
  const value = snapshot.get(field);
  if (value === undefined) return {};
  if (!(value instanceof Timestamp)) {
    catalogInvariant(`${snapshot.ref.path}.${field} must be a timestamp.`);
  }
  return {[field]: value};
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
    "coverUrl", "subjects", "fiction", "language", "status", "mergedInto", "mergedFrom",
    "createdBy", "createdAt", "updatedAt", "reviewedAt",
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
    ...optionalStoredTimestamp(snapshot, "reviewedAt"),
  };
}

function authorFrom(snapshot: DocumentSnapshot): AuthorData {
  const author = storedCatalogAuthor(snapshot, catalogInvariant);
  assertStoredKeys(snapshot, [
    "canonicalName", "alternateNames", "nameKeys", "sortName", "kind",
    "status", "mergedInto", "mergedFrom", "createdBy", "createdAt", "updatedAt", "reviewedAt",
  ]);
  return {
    ...author,
    createdAt: storedTimestamp(snapshot, "createdAt"),
    updatedAt: storedTimestamp(snapshot, "updatedAt"),
    ...optionalStoredTimestamp(snapshot, "reviewedAt"),
  };
}

function editionFrom(snapshot: DocumentSnapshot): EditionData {
  const edition = storedEdition(snapshot, catalogInvariant);
  assertStoredKeys(snapshot, [
    "workId", "isbn13", "title", "publisher",
    "publishedDate", "language", "translatorNames", "format",
    "suggestedPageCount", "coverUrl", "externalIds", "createdBy", "createdAt", "updatedAt",
    "status", "mergedInto", "mergedFrom",
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
    ...(existing?.reviewedAt === undefined ? {} : {reviewedAt: existing.reviewedAt}),
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
    ...(existing?.createdBy === undefined ? {} : {createdBy: existing.createdBy}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(existing?.reviewedAt === undefined ? {} : {reviewedAt: existing.reviewedAt}),
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
    ...(existing?.createdBy === undefined ? {} : {createdBy: existing.createdBy}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(existing?.status === undefined ? {} : {status: existing.status}),
    ...(existing?.mergedInto === undefined ? {} : {mergedInto: existing.mergedInto}),
    ...(existing?.mergedFrom === undefined ? {} : {mergedFrom: existing.mergedFrom}),
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
    language: work.language,
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
    status: edition.status ?? "active",
    mergedInto: edition.mergedInto ?? null,
    mergedFrom: edition.mergedFrom ?? [],
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

async function activeEdition(
  reader: PlanReader,
  db: Firestore,
  editionId: string,
): Promise<{snapshot: DocumentSnapshot; edition: EditionData}> {
  const snapshot = await one(reader, db.collection("editions").doc(editionId));
  const edition = editionFrom(snapshot);
  if (edition.status === "merged") {
    failedPrecondition("Operation target must not be a merged edition.", "catalog-invariant");
  }
  return {snapshot, edition};
}

// The metadata a book moved between editions inherits: only fields its
// reader left blank, from the surviving edition (ISBN, cover, publisher,
// publication date) and the work (cover fallback, fiction, subjects). The
// page count and title are the reader's own and are never touched.
function inheritedBookMetadata(
  snapshot: DocumentSnapshot,
  edition: EditionData,
  work: WorkData,
): {before: Record<string, unknown>; after: Record<string, unknown>} {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const fillText = (field: string, value: string): void => {
    const current = snapshot.get(field);
    if (value !== "" && (current === undefined || current === null || current === "")) {
      before[field] = current ?? null;
      after[field] = value;
    }
  };
  fillText("isbn", edition.isbn13 ?? "");
  fillText("coverUrl", edition.coverUrl !== "" ? edition.coverUrl : work.coverUrl);
  fillText("publisher", edition.publisher);
  fillText("publishedDate", edition.publishedDate);
  const fiction = snapshot.get("fiction");
  if ((fiction === undefined || fiction === null) && work.fiction !== null) {
    before.fiction = null;
    after.fiction = work.fiction;
  }
  const subjects = snapshot.get("subjects");
  if ((subjects === undefined || (Array.isArray(subjects) && subjects.length === 0)) &&
      work.subjects.length > 0) {
    before.subjects = subjects ?? [];
    after.subjects = work.subjects;
  }
  return {before, after};
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

// Works carry canonical author ids (the scan reports a stale alias on one,
// and mergeAuthors rewrites them), so an id that names a merged author —
// an admin form or client that loaded its list before the merge — resolves
// one hop to the survivor rather than failing the operation. Both documents
// are versioned: the plan is stale if either moves under the preview.
async function resolveWorkAuthors(
  reader: PlanReader,
  db: Firestore,
  authorIds: readonly string[],
): Promise<{authorIds: string[]; versions: CatalogVersion[]}> {
  const versions: CatalogVersion[] = [];
  const resolved: string[] = [];
  for (const authorId of authorIds) {
    const snapshot = await one(reader, db.collection("catalogAuthors").doc(authorId));
    const author = authorFrom(snapshot);
    versions.push(versionOf("author", snapshot));
    if (author.status === "active") {
      resolved.push(snapshot.id);
      continue;
    }
    if (author.mergedInto === undefined || author.mergedInto === snapshot.id) {
      failedPrecondition(`Broken author redirect at ${snapshot.ref.path}.`, "catalog-invariant");
    }
    const target = await one(reader, db.collection("catalogAuthors").doc(author.mergedInto));
    if (authorFrom(target).status !== "active") {
      failedPrecondition(`Author redirect is not one hop at ${snapshot.ref.path}.`, "catalog-invariant");
    }
    versions.push(versionOf("author", target));
    resolved.push(target.id);
  }
  return {authorIds: [...new Set(resolved)], versions};
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

// The edition a book stands for when an admin links it without naming one,
// minted from the book's own fields with the book's owner as creator. Its
// id is a digest of the work and the book path — the formula the backfill
// (book-edition-backfill.ts) uses too — so a preview, its apply, a repeated
// apply and a later relink all name one document: an edition already
// there is reused, and an ISBN already indexed to the work joins that
// edition instead. An ISBN indexed to another work is a conflict for the
// operator, not a guess.
async function mintedEditionFor(
  reader: PlanReader,
  db: Firestore,
  snapshot: DocumentSnapshot,
  target: AdminBookTarget,
  workId: string,
  workLanguage: string,
  now: Timestamp,
): Promise<{
  editionId: string;
  versions: CatalogVersion[];
  changes: PlannedChange[];
  createdEdition: boolean;
  createdIsbn: boolean;
}> {
  const editionId = `edition_${createHash("sha256")
    .update(`edition\0${workId}\0${target.uid}/${target.bookId}`)
    .digest("hex")
    .slice(0, 24)}`;
  const ref = db.collection("editions").doc(editionId);
  const existing = await one(reader, ref);
  const versions = [versionOf("edition", existing)];
  if (existing.exists) {
    const minted = editionFrom(existing);
    if (minted.workId !== workId) {
      failedPrecondition("The book's minted edition belongs to another work.", "catalog-invariant");
    }
    // A minted edition an operator merged since answers with its survivor.
    if (minted.status === "merged") {
      if (minted.mergedInto === undefined) {
        catalogInvariant(`Broken catalog redirect at ${existing.ref.path}.`);
      }
      const survivor = await activeEdition(reader, db, minted.mergedInto);
      versions.push(versionOf("edition", survivor.snapshot));
      if (survivor.edition.workId !== workId) {
        failedPrecondition("The book's minted edition was merged into another work.", "catalog-invariant");
      }
      return {
        editionId: minted.mergedInto, versions, changes: [], createdEdition: false, createdIsbn: false,
      };
    }
    return {editionId, versions, changes: [], createdEdition: false, createdIsbn: false};
  }
  const text = (field: string): string => {
    const value = snapshot.get(field);
    if (value !== undefined && value !== null && typeof value !== "string") {
      catalogInvariant(`${snapshot.ref.path}.${field} must be a string.`);
    }
    return value ?? "";
  };
  const title = text("title").trim();
  if (title === "") catalogInvariant(`${snapshot.ref.path} has no title.`);
  const isbn13 = normalizeIsbn13(text("isbn"));
  const changes: PlannedChange[] = [];
  let isbnRef: DocumentReference | null = null;
  if (isbn13 !== null) {
    isbnRef = db.collection("isbnIndex").doc(isbn13);
    const isbn = await one(reader, isbnRef);
    versions.push(versionOf("isbn", isbn));
    if (isbn.exists) {
      const indexedEditionId = isbn.get("editionId");
      if (isbn.get("workId") !== workId || typeof indexedEditionId !== "string") {
        failedPrecondition(
          "The book's ISBN belongs to an edition of another work.",
          "identifier-conflict",
        );
      }
      return {
        editionId: indexedEditionId, versions, changes, createdEdition: false, createdIsbn: false,
      };
    }
  }
  const pageCount = snapshot.get("pageCount");
  const coverUrl = text("coverUrl");
  // The book's language becomes the edition's override only where it
  // differs from the work's default; otherwise the edition inherits.
  const bookLanguage = text("language");
  const data: EditionData = {
    workId,
    isbn13,
    title,
    publisher: text("publisher"),
    publishedDate: text("publishedDate"),
    language: bookLanguage !== workLanguage ? bookLanguage : "",
    translatorNames: [],
    format: "unknown",
    suggestedPageCount: typeof pageCount === "number" && Number.isSafeInteger(pageCount) &&
      pageCount > 0 ? pageCount : null,
    coverUrl: /^https:\/\/[^\s]+$/.test(coverUrl) ? coverUrl : "",
    externalIds: {},
    createdBy: target.uid,
    createdAt: now,
    updatedAt: now,
  };
  changes.push(change(
    "edition", ref, "create", null, wireEdition(data), {type: "create", data: {...data}},
  ));
  if (isbnRef !== null) {
    const row = {workId, editionId};
    changes.push(change("isbn", isbnRef, "create", null, row, {type: "create", data: row}));
  }
  return {editionId, versions, changes, createdEdition: true, createdIsbn: isbn13 !== null};
}

// The personal books a query names, with their owners checked: a book whose
// owner reference does not match its path is forged, and a book under a
// missing or tombstoned account is left alone (SEC-006: a deleted account
// keeps its documents, untouched). Bounded like every book rewrite.
async function liveLinkedBooks(
  reader: PlanReader,
  db: Firestore,
  query: Query,
): Promise<Array<{snapshot: DocumentSnapshot; uid: string; bookId: string}>> {
  const linked = await many(reader, query.limit(MAX_LINKED_EDITION_BOOKS + 1));
  if (linked.size > MAX_LINKED_EDITION_BOOKS) operationTooLarge();
  const owners = new Map<string, DocumentSnapshot>();
  const live: Array<{snapshot: DocumentSnapshot; uid: string; bookId: string}> = [];
  for (const snapshot of linked.docs) {
    const path = snapshot.ref.path.split("/");
    const owner = snapshot.get("owner") as {path?: unknown} | undefined;
    if (path.length !== 4 || path[0] !== "users" || path[2] !== "books" ||
        owner?.path !== `users/${path[1]}`) {
      failedPrecondition("Personal book owner is missing or forged.", "catalog-invariant");
    }
    const uid = path[1];
    if (!owners.has(uid)) owners.set(uid, await one(reader, db.collection("users").doc(uid)));
    const account = owners.get(uid)!;
    if (!account.exists || account.get("deletedAt") !== undefined) continue;
    live.push({snapshot, uid, bookId: path[3]});
  }
  return live;
}

// A book carries the effective language of the edition it stands on as a
// copy (users/{uid}/books.language, beside cover and publisher). When that
// effective language changes, a book still carrying the old value follows
// it; a book that never had any takes the edition's whether or not it
// changed; a book whose reader set something else keeps it. Empty records
// when nothing changes.
function carriedLanguage(
  snapshot: DocumentSnapshot,
  before: string,
  after: string,
): {before: Record<string, unknown>; after: Record<string, unknown>} {
  const current = snapshot.get("language");
  if (current !== undefined && current !== null && typeof current !== "string") {
    catalogInvariant(`${snapshot.ref.path}.language must be a string.`);
  }
  const carried = current ?? "";
  if (carried === after || (carried !== "" && carried !== before)) return {before: {}, after: {}};
  return {before: {language: carried}, after: {language: after}};
}

// The carried-language changes for the books a query names, where
// `languages` maps a book's edition override to the effective language
// before and after the operation. The editions read to learn the override
// are versioned, so an override that changes underneath the preview makes
// it stale.
async function carriedLanguageChanges(
  reader: PlanReader,
  db: Firestore,
  query: Query,
  languages: (_override: string) => [before: string, after: string],
): Promise<{
  changes: PlannedChange[];
  versions: AdminCatalogExpected["books"];
  catalog: CatalogVersion[];
}> {
  const linked = await liveLinkedBooks(reader, db, query);
  const overrides = new Map<string, string>();
  const catalog: CatalogVersion[] = [];
  const changes: PlannedChange[] = [];
  const versions: AdminCatalogExpected["books"] = [];
  for (const {snapshot, uid, bookId} of linked) {
    const editionId = snapshot.get("editionId");
    let override = "";
    if (typeof editionId === "string") {
      if (!overrides.has(editionId)) {
        const edition = await one(reader, db.collection("editions").doc(editionId));
        catalog.push(versionOf("edition", edition));
        overrides.set(editionId, editionFrom(edition).language);
      }
      override = overrides.get(editionId)!;
    }
    const [before, after] = languages(override);
    const carried = carriedLanguage(snapshot, before, after);
    if (Object.keys(carried.after).length === 0) continue;
    versions.push(bookVersion(snapshot, {uid, bookId}));
    changes.push(change(
      "book", snapshot.ref, "update", carried.before, carried.after,
      {type: "set", data: carried.after},
    ));
  }
  return {changes, versions, catalog};
}

async function linkChanges(
  reader: PlanReader,
  db: Firestore,
  targets: AdminBookTarget[],
  target: {workId: string; editionId: string | null} | null,
  now: Timestamp,
  // The work this same plan creates, when the target is not in the catalog
  // yet (createWork). Otherwise the target work is read and must be
  // unmerged, and a named edition must belong to it.
  pendingWork?: WorkData,
): Promise<{
  changes: PlannedChange[];
  versions: AdminCatalogExpected["books"];
  catalog: CatalogVersion[];
}> {
  let workLanguage = "";
  if (target !== null) {
    if (pendingWork !== undefined) {
      workLanguage = pendingWork.language;
    } else {
      const resolved = await unmergedWork(reader, db, target.workId);
      workLanguage = resolved.work.language;
      if (target.editionId !== null) {
        const {edition} = await activeEdition(reader, db, target.editionId);
        if (edition.workId !== resolved.snapshot.id) {
          failedPrecondition("Edition belongs to another work.", "catalog-invariant");
        }
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
  const catalog: CatalogVersion[] = [];
  const changes: PlannedChange[] = [];
  let mintedEditions = 0;
  let mintedIsbns = 0;
  for (const [index, snapshot] of snapshots.entries()) {
    const before = linkFrom(snapshot);
    let editionId = target?.editionId ?? null;
    if (target !== null && editionId === null) {
      // Every linked book stands on an edition of its work (owner decision
      // 2026-09-01): a link that names none mints one per book.
      const minted = await mintedEditionFor(
        reader, db, snapshot, targets[index], target.workId, workLanguage, now,
      );
      catalog.push(...minted.versions);
      changes.push(...minted.changes);
      mintedEditions += minted.createdEdition ? 1 : 0;
      mintedIsbns += minted.createdIsbn ? 1 : 0;
      editionId = minted.editionId;
    }
    const after: LinkState = target === null ? {
      workId: null,
      editionId: null,
      matchMethod: null,
      linkedAt: null,
    } : {
      workId: target.workId,
      editionId,
      matchMethod: "admin",
      linkedAt: now.toMillis(),
    };
    const data = {
      workId: after.workId,
      editionId: after.editionId,
      matchMethod: after.matchMethod,
      linkedAt: target === null ? null : now,
    };
    changes.push(change("book", snapshot.ref, "update", before, after, {type: "set", data}));
  }
  await ensureCollectionCapacity(
    reader, db.collection("editions"), MAX_EDITIONS, mintedEditions, "editions",
  );
  await ensureCollectionCapacity(
    reader, db.collection("isbnIndex"), MAX_ISBN_INDEXES, mintedIsbns, "ISBN indexes",
  );
  return {changes, versions, catalog};
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
  // The operator; a record the operation creates from nothing is theirs.
  creator: string,
): Promise<Plan> {
  const catalog: CatalogVersion[] = [];
  let books: AdminCatalogExpected["books"] = [];
  const changes: PlannedChange[] = [];

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
    const next = {
      ...authorInputData(operation.author, now, current),
      ...(current === undefined ? {createdBy: creator} : {}),
    };
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
    const affectedWorks = new Map<string, DocumentSnapshot>();
    for (const authorId of absorbed) {
      const rows = await many(reader, db.collection("works")
        .where("authorIds", "array-contains", authorId)
        .limit(MAX_WORKS + 1));
      if (rows.size > MAX_WORKS) operationTooLarge();
      for (const snapshot of rows.docs) affectedWorks.set(snapshot.id, snapshot);
    }
    for (const snapshot of affectedWorks.values()) {
      const old = workFrom(snapshot);
      catalog.push(versionOf("work", snapshot));
      const next = {
        ...old,
        authorIds: [...new Set(old.authorIds.map((authorId) =>
          absorbed.includes(authorId) ? target.snapshot.id : authorId,
        ))],
        updatedAt: now,
      };
      changes.push(change(
        "work", snapshot.ref, "update", wireWork(old), wireWork(next),
        {type: "set", data: next},
      ));
    }
    // Personal books that reference an absorbed author are deliberately
    // left alone: the alias stays behind as a one-hop merged record, and
    // the client, the admin scan, and db-audit all resolve that redirect
    // (merging flattens chains, so one hop always suffices). Rewriting
    // them would make a merge scale with an author's readership — and
    // fail for a popular author — and would mutate books inside
    // tombstoned accounts, which every other path leaves frozen.
  } else if (operation.type === "createWork") {
    const ref = db.collection("works").doc(operation.workId);
    const snapshot = await one(reader, ref);
    catalog.push(versionOf("work", snapshot));
    if (snapshot.exists) failedPrecondition("Work ID already exists.", "catalog-invariant");
    await ensureCollectionCapacity(
      reader, db.collection("works"), MAX_WORKS, 1, "works",
    );
    const authors = await resolveWorkAuthors(reader, db, operation.work.authorIds);
    catalog.push(...authors.versions);
    // Catalog data is public whoever contributed it: any personal book may
    // seed a work, so no consent check sits here.
    const work = {
      ...workInputData({...operation.work, authorIds: authors.authorIds}, operation.status, now),
      createdBy: creator,
    };
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
      work,
    );
    changes.push(...linked.changes);
    books = linked.versions;
    catalog.push(...linked.catalog);
  } else if (operation.type === "linkBooks") {
    const linked = await linkChanges(reader, db, operation.books, operation.target, now);
    changes.push(...linked.changes);
    books = linked.versions;
    catalog.push(...linked.catalog);
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
    const authors = await resolveWorkAuthors(reader, db, operation.work.authorIds);
    catalog.push(...authors.versions);
    const next = workInputData(
      {...operation.work, authorIds: authors.authorIds}, operation.status, now, current.work,
    );
    changes.push(change(
      "work", current.snapshot.ref, "update", wireWork(current.work), wireWork(next),
      {type: "set", data: {...next}},
    ));
    const indexes = await titleIndexChanges(reader, db, operation.workId, next);
    changes.push(...indexes.changes);
    catalog.push(...indexes.versions);
    if (current.work.language !== next.language) {
      // Books on the work, or on an alias merged into it, follow the new
      // default unless their edition overrides it.
      const carried = await carriedLanguageChanges(
        reader,
        db,
        db.collectionGroup("books")
          .where("workId", "in", [operation.workId, ...current.work.mergedFrom]),
        (override) => [
          effectiveLanguage(override, current.work.language),
          effectiveLanguage(override, next.language),
        ],
      );
      changes.push(...carried.changes);
      catalog.push(...carried.catalog);
      books = carried.versions;
    }
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
    // The survivor keeps its own values and takes what it lacks from the
    // sources, in the order given: a blank cover, an unknown fiction flag
    // or an unknown language, and every subject it did not already list
    // (owner decision 2026-09-02: a merge is the union, survivor first).
    const sourceWorks = sources.map(({work}) => work);
    const subjects = [...new Set([...target.work.subjects, ...sourceWorks.flatMap((work) => work.subjects)])];
    if (subjects.length > 25) {
      failedPrecondition("Merged subjects exceed the catalog limit.", "catalog-invariant");
    }
    const nextTarget = workInputData({
      canonicalTitle: target.work.canonicalTitle,
      alternateTitles,
      authorIds: target.work.authorIds,
      coverUrl: target.work.coverUrl !== "" ? target.work.coverUrl :
        sourceWorks.find((work) => work.coverUrl !== "")?.coverUrl ?? "",
      subjects,
      fiction: target.work.fiction ??
        sourceWorks.find((work) => work.fiction !== null)?.fiction ?? null,
      language: target.work.language !== "" ? target.work.language :
        sourceWorks.find((work) => work.language !== "")?.language ?? "",
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
  } else if (operation.type === "mergeEditions") {
    // Editions merge like works: the sources become aliases and the
    // survivor lists them. The survivor keeps its own values and takes what
    // it lacks from the aliases (owner decision 2026-09-02: a merge is the
    // union, survivor first); an identifier it takes moves with its index
    // row, so an alias keeps only the identifiers the survivor already had.
    // Unlike a work merge this rewrites personal books — the owner's reading
    // (2026-09-02) is that two records of one edition should read as one for
    // every reader — but only the books on the merged edition, at most a page
    // of them, in live accounts; a book in a frozen account stays on its
    // alias and resolves one hop at read time. A book keeps its link time
    // and title and inherits only the metadata its reader left blank.
    const work = await unmergedWork(reader, db, operation.workId);
    catalog.push(versionOf("work", work.snapshot));
    const target = await activeEdition(reader, db, operation.targetEditionId);
    catalog.push(versionOf("edition", target.snapshot));
    if (target.edition.workId !== work.snapshot.id) {
      failedPrecondition("Target edition belongs to another work.", "catalog-invariant");
    }
    const sources = await Promise.all(operation.sourceEditionIds.map((id) =>
      activeEdition(reader, db, id),
    ));
    for (const source of sources) {
      catalog.push(versionOf("edition", source.snapshot));
      if (source.edition.workId !== work.snapshot.id) {
        failedPrecondition("Source edition belongs to another work.", "catalog-invariant");
      }
    }
    const absorbed = [...new Set(sources.flatMap(({snapshot, edition}) =>
      [snapshot.id, ...(edition.mergedFrom ?? [])],
    ))];
    const mergedFrom = [...new Set([...(target.edition.mergedFrom ?? []), ...absorbed])];
    if (mergedFrom.length > 29 || mergedFrom.includes(target.snapshot.id)) {
      failedPrecondition("A canonical edition may have at most 29 aliases.", "catalog-invariant");
    }
    const aliases = await Promise.all(absorbed.map((id) =>
      one(reader, db.collection("editions").doc(id)),
    ));
    catalog.push(...aliases.map((snapshot) => versionOf("edition", snapshot)));
    const donors = aliases.map((snapshot) => ({id: snapshot.id, snapshot, edition: editionFrom(snapshot)}));

    const merged: EditionData = {...target.edition, mergedFrom, updatedAt: now};
    const firstText = (field: "publisher" | "publishedDate" | "language" | "coverUrl"): string =>
      donors.find(({edition}) => edition[field] !== "")?.edition[field] ?? "";
    if (merged.publisher === "") merged.publisher = firstText("publisher");
    if (merged.publishedDate === "") merged.publishedDate = firstText("publishedDate");
    if (merged.language === "") merged.language = firstText("language");
    if (merged.coverUrl === "") merged.coverUrl = firstText("coverUrl");
    if (merged.translatorNames.length === 0) {
      merged.translatorNames =
        donors.find(({edition}) => edition.translatorNames.length > 0)?.edition.translatorNames ?? [];
    }
    if (merged.format === "unknown") {
      merged.format = donors.find(({edition}) => edition.format !== "unknown")?.edition.format ?? "unknown";
    }
    if (merged.suggestedPageCount === null) {
      merged.suggestedPageCount =
        donors.find(({edition}) => edition.suggestedPageCount !== null)?.edition.suggestedPageCount ?? null;
    }
    // Identifiers move rather than copy: an index row names one edition and
    // its key must be that edition's own identifier.
    const gave = new Map<string, {isbn13: boolean; providers: Set<string>}>();
    const giving = (id: string): {isbn13: boolean; providers: Set<string>} => {
      const entry = gave.get(id) ?? {isbn13: false, providers: new Set<string>()};
      gave.set(id, entry);
      return entry;
    };
    if (merged.isbn13 === null) {
      const donor = donors.flatMap(({id, edition}) =>
        edition.isbn13 === null ? [] : [{id, isbn13: edition.isbn13}])[0];
      if (donor !== undefined) {
        const isbnRef = db.collection("isbnIndex").doc(donor.isbn13);
        const isbn = await one(reader, isbnRef);
        catalog.push(versionOf("isbn", isbn));
        if (!isbn.exists || isbn.get("editionId") !== donor.id) {
          failedPrecondition("Edition ISBN index is missing or owned elsewhere.", "catalog-invariant");
        }
        const row = {workId: work.snapshot.id, editionId: target.snapshot.id};
        changes.push(change("isbn", isbnRef, "update", isbn.data() ?? null, row, {type: "set", data: row}));
        merged.isbn13 = donor.isbn13;
        giving(donor.id).isbn13 = true;
      }
    }
    const externalIds = {...merged.externalIds};
    for (const donor of donors) {
      for (const [provider, id] of Object.entries(donor.edition.externalIds)) {
        if (provider in externalIds) continue;
        const ref = db.collection("externalIdIndex").doc(externalIndexId({provider, id}));
        const index = await one(reader, ref);
        catalog.push(versionOf("external-id", index));
        if (!index.exists || index.get("editionId") !== donor.id) {
          failedPrecondition("External identifier index is missing or owned elsewhere.", "catalog-invariant");
        }
        const row = {workId: work.snapshot.id, editionId: target.snapshot.id, provider, externalId: id};
        changes.push(change("external-id", ref, "update", index.data() ?? null, row, {type: "set", data: row}));
        externalIds[provider] = id;
        giving(donor.id).providers.add(provider);
      }
    }
    if (Object.keys(externalIds).length > 10) {
      failedPrecondition("Edition has too many external identifiers.", "catalog-invariant");
    }
    merged.externalIds = externalIds;

    for (const {id, snapshot: alias, edition: old} of donors) {
      const given = gave.get(id);
      const next: EditionData = {
        ...old,
        ...(given?.isbn13 ? {isbn13: null} : {}),
        ...(given !== undefined && given.providers.size > 0 ? {
          externalIds: Object.fromEntries(
            Object.entries(old.externalIds).filter(([provider]) => !given.providers.has(provider)),
          ),
        } : {}),
        status: "merged", mergedInto: target.snapshot.id, mergedFrom: [], updatedAt: now,
      };
      changes.push(change(
        "edition", alias.ref, "update", wireEdition(old), wireEdition(next),
        {type: "set", data: {...next}},
      ));
    }
    changes.push(change(
      "edition", target.snapshot.ref, "update",
      wireEdition(target.edition), wireEdition(merged),
      {type: "set", data: {...merged}},
    ));

    // Every reader's book on the merged edition, on the survivor already or
    // on an alias, inherits what it left blank from the merged survivor and
    // follows its effective language unless the reader chose otherwise; the
    // books on aliases move.
    const overrideBefore = new Map<string, string>([
      [target.snapshot.id, target.edition.language],
      ...donors.map(({id, edition}): [string, string] => [id, edition.language]),
    ]);
    const languageAfter = effectiveLanguage(merged.language, work.work.language);
    const linked = await liveLinkedBooks(
      reader, db,
      db.collectionGroup("books").where("editionId", "in", [target.snapshot.id, ...absorbed]),
    );
    const touched: AdminCatalogExpected["books"] = [];
    for (const {snapshot, uid, bookId} of linked) {
      const before = linkFrom(snapshot);
      const inherited = inheritedBookMetadata(snapshot, merged, work.work);
      const carried = carriedLanguage(
        snapshot,
        effectiveLanguage(overrideBefore.get(before.editionId ?? "") ?? "", work.work.language),
        languageAfter,
      );
      const moves = before.editionId !== target.snapshot.id;
      const after: LinkState = moves ? {
        ...before,
        workId: work.snapshot.id,
        editionId: target.snapshot.id,
        matchMethod: "admin",
      } : before;
      const data: Record<string, unknown> = {
        ...(moves ? {workId: after.workId, editionId: after.editionId, matchMethod: after.matchMethod} : {}),
        ...inherited.after,
        ...carried.after,
      };
      if (Object.keys(data).length === 0) continue;
      touched.push(bookVersion(snapshot, {uid, bookId}));
      changes.push(change(
        "book", snapshot.ref, "update",
        {...before, ...inherited.before, ...carried.before},
        {...after, ...inherited.after, ...carried.after},
        {type: "set", data},
      ));
    }
    books = touched;
  } else if (operation.type === "upsertEdition") {
    const work = await unmergedWork(reader, db, operation.workId);
    catalog.push(versionOf("work", work.snapshot));
    const ref = db.collection("editions").doc(operation.editionId);
    const snapshot = await one(reader, ref);
    catalog.push(versionOf("edition", snapshot));
    const old = snapshot.exists ? editionFrom(snapshot) : undefined;
    if (old?.status === "merged") {
      failedPrecondition("Merged editions cannot be edited.", "catalog-invariant");
    }
    if (old === undefined) {
      await ensureCollectionCapacity(
        reader, db.collection("editions"), MAX_EDITIONS, 1, "editions",
      );
    }
    // An edit may give the edition an ISBN, change it or drop it; the index
    // row follows. An ISBN another edition holds is refused here: taking it
    // over is repointIsbn's job, which also clears the other edition.
    const previousIsbn = old?.isbn13 ?? null;
    if (previousIsbn !== operation.edition.isbn13) {
      if (previousIsbn !== null) {
        const priorRef = db.collection("isbnIndex").doc(previousIsbn);
        const prior = await one(reader, priorRef);
        catalog.push(versionOf("isbn", prior));
        if (!prior.exists || prior.get("editionId") !== operation.editionId) {
          failedPrecondition("Edition ISBN index is missing or owned elsewhere.", "catalog-invariant");
        }
        changes.push(change("isbn", priorRef, "delete", prior.data() ?? null, null, {type: "delete"}));
      }
      if (operation.edition.isbn13 !== null) {
        const isbn = await one(reader, db.collection("isbnIndex").doc(operation.edition.isbn13));
        catalog.push(versionOf("isbn", isbn));
        if (isbn.exists) {
          failedPrecondition("ISBN is already assigned to another edition; repoint it instead.", "identifier-conflict");
        }
        await ensureCollectionCapacity(
          reader, db.collection("isbnIndex"), MAX_ISBN_INDEXES, 1, "ISBN indexes",
        );
        const row = {workId: operation.workId, editionId: operation.editionId};
        changes.push(change("isbn", isbn.ref, "create", null, row, {type: "create", data: row}));
      }
    }
    const next = {
      ...editionInputData(operation.workId, operation.edition, now, old),
      ...(old === undefined ? {createdBy: creator} : {}),
    };
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
    if (old !== undefined && old.workId === operation.workId) {
      // The books on the edition inherit from the edited record what their
      // readers left blank (an ISBN or cover the edit added, say), and a
      // changed override carries into them; a reader's own values stay.
      const languageBefore = effectiveLanguage(old.language, work.work.language);
      const languageAfter = effectiveLanguage(next.language, work.work.language);
      const linked = await liveLinkedBooks(
        reader, db, db.collectionGroup("books").where("editionId", "==", operation.editionId),
      );
      const touched: AdminCatalogExpected["books"] = [];
      for (const {snapshot: book, uid, bookId} of linked) {
        const inherited = inheritedBookMetadata(book, next, work.work);
        const carried = carriedLanguage(book, languageBefore, languageAfter);
        const data = {...inherited.after, ...carried.after};
        if (Object.keys(data).length === 0) continue;
        touched.push(bookVersion(book, {uid, bookId}));
        changes.push(change(
          "book", book.ref, "update",
          {...inherited.before, ...carried.before}, data, {type: "set", data},
        ));
      }
      books = touched;
    }
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
      // The books move between works, so their effective language may
      // change through the work's default even if the override does not.
      const previousWorkSnapshot = await one(reader, db.collection("works").doc(old.workId));
      catalog.push(versionOf("work", previousWorkSnapshot));
      const languageBefore = effectiveLanguage(old.language, workFrom(previousWorkSnapshot).language);
      const languageAfter = effectiveLanguage(next.language, work.work.language);
      for (const book of linked.docs) {
        const before = linkFrom(book);
        const after = {
          workId: operation.workId,
          editionId: operation.editionId,
          matchMethod: "admin" as const,
          linkedAt: now.toMillis(),
        };
        const carried = carriedLanguage(book, languageBefore, languageAfter);
        changes.push(change(
          "book", book.ref, "update", {...before, ...carried.before}, {...after, ...carried.after},
          {type: "set", data: {...after, linkedAt: now, ...carried.after}},
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
    if (target.status === "merged") {
      failedPrecondition("Operation target must not be a merged edition.", "catalog-invariant");
    }
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
  };
}

function wireChanges(changes: PlannedChange[]) {
  return changes.map(({kind, id, action, before, after}) => ({
    kind, id, action, before, after,
  }));
}

// admin.review: stamp or clear reviewedAt on whole records, in one
// transaction, so a mark is all-or-nothing and a malformed record refuses
// the way apply would. updatedAt stays: a review mark is not an edit.
export async function reviewCatalogRecords(
  db: Firestore,
  request: AdminReviewRequest,
): Promise<{updated: number}> {
  const collection = request.kind === "work" ? "works" : "catalogAuthors";
  const now = Timestamp.now();
  return db.runTransaction(async (transaction) => {
    // Every record is read and validated before the first write, so a
    // missing or malformed id refuses the call with nothing written.
    const records: Array<{ref: DocumentReference; data: WorkData | AuthorData}> = [];
    for (const id of request.ids) {
      const snapshot = await transaction.get(db.collection(collection).doc(id));
      if (!snapshot.exists) {
        throw new functions.https.HttpsError(
          "not-found",
          `${collection}/${id} does not exist.`,
          {reason: "missing-record"},
        );
      }
      records.push({
        ref: snapshot.ref,
        data: request.kind === "work" ? workFrom(snapshot) : authorFrom(snapshot),
      });
    }
    for (const {ref, data} of records) {
      const next = {...data};
      delete next.reviewedAt;
      transaction.set(ref, request.reviewed ? {...next, reviewedAt: now} : next);
    }
    return {updated: records.length};
  });
}

export async function previewAdminCatalogOperation(
  db: Firestore,
  adminUid: string,
  operation: AdminCatalogOperation,
) {
  const reader: PlanReader = {get: async (value) => value.get()};
  const plan = await planOperation(reader, db, operation, Timestamp.now(), adminUid);
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

export async function applyAdminCatalogOperation(
  db: Firestore,
  adminUid: string,
  request: AdminCatalogApplyRequest,
) {
  const hash = operationHash(request.operation);
  const auditRef = db.collection("adminAudit").doc(request.operationId);
  return db.runTransaction(async (transaction) => {
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
    const plan = await planOperation(reader, db, request.operation, now, adminUid);
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
    const result = {
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
      touchedDocuments: result.touchedDocuments,
      beforeAfter: wireChanges(plan.changes),
      result,
    };
    if (Buffer.byteLength(JSON.stringify(audit), "utf8") > MAX_AUDIT_BYTES) {
      operationTooLarge();
    }
    transaction.create(auditRef, audit);
    return result;
  });
}
