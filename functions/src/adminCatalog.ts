import * as functions from "firebase-functions/v1";
import {
  DocumentReference,
  DocumentData,
  DocumentSnapshot,
  FieldPath,
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
} from "./decoders";
import {externalIndexId, normalizeCatalogText, normalizeCatalogTitle} from "./catalog";
import {profileConsents, sharingSetting} from "./sharingConsent";

const MAX_WORKS = 200;
const MAX_CATALOG_AUTHORS = 500;
const MAX_EDITIONS = 500;
const BOOK_PAGE_SIZE = 100;
const MAX_ISBN_INDEXES = 500;
const MAX_EXTERNAL_ID_INDEXES = 500;
const MAX_AUTHORS_PER_WORK = 20;
const MAX_AUTHORS_PER_PERSONAL_BOOK = 6;
const MAX_TOUCHED_DOCUMENTS = 200;
const MAX_LINKED_EDITION_BOOKS = 100;
const AUDIT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_AUDIT_BYTES = 700_000;
const ADMIN_UID = "1Cf0CaNfgnVSvTrF5dYjzRd9Xri2";

type Visibility = "internal" | "searchable";
type WorkStatus = "active" | "merged";
type MatchMethod = "isbn" | "external-id" | "catalog-choice" |
  "migration" | "admin" | null;

interface WorkData extends CatalogWorkInput {
  titleKeys: string[];
  visibility: Visibility;
  status: WorkStatus;
  mergedInto?: string;
  mergedFrom: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface AuthorData extends CatalogAuthorInput {
  nameKeys: string[];
  status: "active" | "merged";
  mergedInto?: string;
  mergedFrom: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface EditionData extends CatalogEditionInput {
  workId: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface LinkState {
  workId: string | null;
  editionId: string | null;
  matchMethod: MatchMethod;
  linkedAt: number | null;
}

interface CatalogVersion {
  kind: "author" | "work" | "edition" | "isbn" | "external-id" | "title-index";
  id: string;
  exists: boolean;
  updatedAt: number | null;
}

interface PlannedChange {
  kind: "author" | "work" | "edition" | "isbn" | "external-id" | "book" | "title-index";
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

function assertTimestamp(value: unknown, label: string): Timestamp {
  if (!(value instanceof Timestamp)) throw new Error(`${label} must be a timestamp.`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be a string array.`);
  }
  return value;
}

function optionalText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function assertStoredKeys(
  data: DocumentData,
  allowed: readonly string[],
  path: string,
): void {
  const allowedKeys = new Set(allowed);
  const extra = Object.keys(data).find((key) => !allowedKeys.has(key));
  if (extra !== undefined) {
    failedPrecondition(
      `Catalog document ${path} contains unsupported field ${extra}.`,
      "catalog-invariant",
    );
  }
}

function workFrom(snapshot: DocumentSnapshot): WorkData {
  if (!snapshot.exists) failedPrecondition("Catalog work does not exist.", "catalog-invariant");
  const data = snapshot.data();
  if (data === undefined || typeof data.canonicalTitle !== "string" ||
      typeof data.coverUrl !== "string" ||
      (data.fiction !== null && typeof data.fiction !== "boolean") ||
      (data.visibility !== "internal" && data.visibility !== "searchable") ||
      (data.status !== "active" && data.status !== "merged")) {
    throw new Error(`Invalid work ${snapshot.ref.path}.`);
  }
  assertStoredKeys(data, [
    "canonicalTitle", "alternateTitles", "titleKeys", "authorIds",
    "coverUrl", "subjects", "fiction", "visibility",
    "status", "mergedInto", "mergedFrom", "createdAt", "updatedAt",
  ], snapshot.ref.path);
  const mergedInto = data.mergedInto;
  if (mergedInto !== undefined && typeof mergedInto !== "string") {
    throw new Error(`Invalid redirect ${snapshot.ref.path}.`);
  }
  return {
    canonicalTitle: data.canonicalTitle,
    alternateTitles: strings(data.alternateTitles, `${snapshot.ref.path}.alternateTitles`),
    titleKeys: strings(data.titleKeys, `${snapshot.ref.path}.titleKeys`),
    authorIds: strings(data.authorIds, `${snapshot.ref.path}.authorIds`),
    coverUrl: data.coverUrl,
    subjects: strings(data.subjects, `${snapshot.ref.path}.subjects`),
    fiction: data.fiction,
    visibility: data.visibility,
    status: data.status,
    ...(mergedInto === undefined ? {} : {mergedInto}),
    mergedFrom: strings(data.mergedFrom ?? [], `${snapshot.ref.path}.mergedFrom`),
    createdAt: assertTimestamp(data.createdAt, `${snapshot.ref.path}.createdAt`),
    updatedAt: assertTimestamp(data.updatedAt, `${snapshot.ref.path}.updatedAt`),
  };
}

function authorFrom(snapshot: DocumentSnapshot): AuthorData {
  if (!snapshot.exists) failedPrecondition("Catalog author does not exist.", "catalog-invariant");
  const data = snapshot.data();
  if (data === undefined || typeof data.canonicalName !== "string" ||
      typeof data.sortName !== "string" ||
      !["person", "entity", "placeholder"].includes(data.kind) ||
      (data.status !== "active" && data.status !== "merged")) {
    throw new Error(`Invalid catalog author ${snapshot.ref.path}.`);
  }
  assertStoredKeys(data, [
    "canonicalName", "alternateNames", "nameKeys", "sortName", "kind",
    "status", "mergedInto", "mergedFrom", "createdAt", "updatedAt",
  ], snapshot.ref.path);
  const mergedInto = data.mergedInto;
  if (mergedInto !== undefined && typeof mergedInto !== "string") {
    throw new Error(`Invalid catalog author redirect ${snapshot.ref.path}.`);
  }
  return {
    canonicalName: data.canonicalName,
    alternateNames: strings(data.alternateNames, `${snapshot.ref.path}.alternateNames`),
    nameKeys: strings(data.nameKeys, `${snapshot.ref.path}.nameKeys`),
    sortName: data.sortName,
    kind: data.kind,
    status: data.status,
    ...(mergedInto === undefined ? {} : {mergedInto}),
    mergedFrom: strings(data.mergedFrom ?? [], `${snapshot.ref.path}.mergedFrom`),
    createdAt: assertTimestamp(data.createdAt, `${snapshot.ref.path}.createdAt`),
    updatedAt: assertTimestamp(data.updatedAt, `${snapshot.ref.path}.updatedAt`),
  };
}

function editionFrom(snapshot: DocumentSnapshot): EditionData {
  if (!snapshot.exists) failedPrecondition("Catalog edition does not exist.", "catalog-invariant");
  const data = snapshot.data();
  if (data === undefined || typeof data.workId !== "string" ||
      (data.isbn13 !== null && typeof data.isbn13 !== "string") ||
      typeof data.title !== "string" || typeof data.publisher !== "string" ||
      typeof data.publishedDate !== "string" || typeof data.language !== "string" ||
      !["full", "abridged", "revised", "unknown"].includes(data.format) ||
      (data.suggestedPageCount !== null && typeof data.suggestedPageCount !== "number") ||
      typeof data.coverUrl !== "string" || typeof data.externalIds !== "object" ||
      data.externalIds === null || Array.isArray(data.externalIds)) {
    throw new Error(`Invalid edition ${snapshot.ref.path}.`);
  }
  assertStoredKeys(data, [
    "workId", "isbn13", "title", "publisher",
    "publishedDate", "language", "translatorNames", "format",
    "suggestedPageCount", "coverUrl", "externalIds", "createdAt", "updatedAt",
  ], snapshot.ref.path);
  return {
    workId: data.workId,
    isbn13: data.isbn13,
    title: data.title,
    publisher: data.publisher,
    publishedDate: data.publishedDate,
    language: data.language,
    translatorNames: strings(data.translatorNames, `${snapshot.ref.path}.translatorNames`),
    format: data.format,
    suggestedPageCount: data.suggestedPageCount,
    coverUrl: data.coverUrl,
    externalIds: data.externalIds,
    createdAt: assertTimestamp(data.createdAt, `${snapshot.ref.path}.createdAt`),
    updatedAt: assertTimestamp(data.updatedAt, `${snapshot.ref.path}.updatedAt`),
  };
}

function workInputData(
  work: CatalogWorkInput,
  visibility: Visibility,
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
    visibility,
    status: "active",
    mergedFrom: existing?.mergedFrom ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function authorInputData(
  author: CatalogAuthorInput,
  now: Timestamp,
  existing?: AuthorData,
): AuthorData {
  const canonicalKey = normalizeCatalogText(author.canonicalName);
  const alternateByKey = new Map<string, string>();
  const candidates = existing !== undefined &&
    normalizeCatalogText(existing.canonicalName) !== canonicalKey ?
    [...author.alternateNames, existing.canonicalName] : author.alternateNames;
  for (const name of candidates) {
    const key = normalizeCatalogText(name);
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
      [author.canonicalName, ...alternateNames].map(normalizeCatalogText),
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

function titleIndexId(workId: string, titleKey: string): string {
  return createHash("sha256").update(`${workId}\0${titleKey}`).digest("hex");
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
    visibility: work.visibility,
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

function linkFrom(snapshot: DocumentSnapshot): LinkState {
  const workId = snapshot.get("workId");
  const editionId = snapshot.get("editionId");
  const matchMethod = snapshot.get("matchMethod");
  const linkedAt = snapshot.get("linkedAt");
  const methods = ["isbn", "external-id", "catalog-choice", "migration", "admin"];
  if (workId !== undefined && workId !== null && typeof workId !== "string" ||
      editionId !== undefined && editionId !== null && typeof editionId !== "string" ||
      matchMethod !== undefined && matchMethod !== null &&
        (typeof matchMethod !== "string" || !methods.includes(matchMethod)) ||
      linkedAt !== undefined && linkedAt !== null && !(linkedAt instanceof Timestamp)) {
    throw new Error(`Invalid catalog link at ${snapshot.ref.path}.`);
  }
  return {
    workId: workId ?? null,
    editionId: editionId ?? null,
    matchMethod: matchMethod ?? null,
    linkedAt: linkedAt instanceof Timestamp ? linkedAt.toMillis() : null,
  };
}

function normalizedBookIsbn(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const isbn = value.replace(/[-\s]/g, "").toUpperCase();
  if (/^\d{9}[\dX]$/.test(isbn)) {
    let isbn10Sum = 0;
    for (let index = 0; index < 10; index += 1) {
      isbn10Sum += (10 - index) * (isbn[index] === "X" ? 10 : Number(isbn[index]));
    }
    if (isbn10Sum % 11 !== 0) return null;
    const core = `978${isbn.slice(0, 9)}`;
    let isbn13Sum = 0;
    for (let index = 0; index < 12; index += 1) {
      isbn13Sum += Number(core[index]) * (index % 2 === 0 ? 1 : 3);
    }
    return `${core}${(10 - isbn13Sum % 10) % 10}`;
  }
  if (!/^\d{13}$/.test(isbn)) return null;
  let sum = 0;
  for (let index = 0; index < 12; index += 1) {
    sum += Number(isbn[index]) * (index % 2 === 0 ? 1 : 3);
  }
  return isbn[12] === String((10 - sum % 10) % 10) ? isbn : null;
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
      normalizedBookIsbn(snapshot.get("isbn")),
    );
  });
  const changes = affected.map((snapshot) => {
    const before = linkFrom(snapshot);
    if (before.workId === null) {
      failedPrecondition("ISBN-derived book has no work.", "catalog-invariant");
    }
    const keepsIsbnProvenance = normalizedBookIsbn(snapshot.get("isbn")) === nextIsbn13;
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
      {...before},
      {...after},
      {type: "set", data: {...after, linkedAt: now}},
    );
  });
  return {changes, versions};
}

function bookVersion(
  snapshot: DocumentSnapshot,
  target: AdminBookTarget,
  decisionIsbn13: string | null = null,
  decisionAuthorIds: string[] | null = null,
) {
  if (!snapshot.exists) failedPrecondition("Personal book no longer exists.", "catalog-invariant");
  return {
    uid: target.uid,
    bookId: target.bookId,
    ...linkFrom(snapshot),
    decisionIsbn13,
    decisionAuthorIds,
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
  return {
    kind,
    id: snapshot.id,
    exists: snapshot.exists,
    updatedAt: snapshot.exists ? snapshot.updateTime?.toMillis() ?? null : null,
  };
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

async function activeWork(
  reader: PlanReader,
  db: Firestore,
  workId: string,
): Promise<{snapshot: DocumentSnapshot; work: WorkData}> {
  const snapshot = await one(reader, db.collection("works").doc(workId));
  const work = workFrom(snapshot);
  if (work.status !== "active") {
    failedPrecondition("Operation target must be an active work.", "catalog-invariant");
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
  const desired = new Map(work.titleKeys.map((titleKey, index) => [
    titleIndexId(workId, titleKey),
    {
      workId,
      title: index === 0 ? work.canonicalTitle :
        work.alternateTitles.find((candidate) =>
          normalizeCatalogTitle(candidate) === titleKey,
        ) ?? work.canonicalTitle,
      titleKey,
      visibility: work.visibility,
    },
  ]));
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
        "external-id", snapshot.ref, "update", snapshot.data(), {
          ...next,
        }, {type: "set", data: next},
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
      snapshot.data() ?? null, {...row},
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
    const resolved = await activeWork(reader, db, target.workId);
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
    return change(
      "book",
      snapshot.ref,
      "update",
      {...before},
      {...after},
      {type: "set", data},
    );
  });
  return {changes, versions};
}

async function promotionEligible(
  reader: PlanReader,
  db: Firestore,
  snapshots: DocumentSnapshot[],
): Promise<boolean> {
  for (const snapshot of snapshots) {
    const path = snapshot.ref.path.split("/");
    if (path[1] === ADMIN_UID) return true;
  }
  const uids = [...new Set(snapshots.map((snapshot) => snapshot.ref.path.split("/")[1]))];
  for (const uid of uids) {
    const [user, setting] = await Promise.all([
      one(reader, db.collection("users").doc(uid)),
      one(reader, db.doc(`users/${uid}/settings/bookSharing`)),
    ]);
    const consented = sharingSetting(user, setting);
    if (consented === null) continue;
    const profile = await one(reader, db.collection("profiles").doc(consented.username));
    if (profileConsents(profile, uid)) return true;
  }
  return false;
}

function sortExpected(expected: AdminCatalogExpected): AdminCatalogExpected {
  const catalog = new Map(expected.catalog.map((version) =>
    [`${version.kind}/${version.id}`, version],
  ));
  const books = new Map(expected.books.map((version) =>
    [`${version.uid}/${version.bookId}`, version],
  ));
  return {
    catalog: [...catalog.values()].sort((left, right) =>
      `${left.kind}/${left.id}`.localeCompare(`${right.kind}/${right.id}`),
    ),
    books: [...books.values()].sort((left, right) =>
      `${left.uid}/${left.bookId}`.localeCompare(`${right.uid}/${right.bookId}`),
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
    const canonicalKey = normalizeCatalogText(target.author.canonicalName);
    const aliasesByKey = new Map<string, string>();
    for (const name of aliasCandidates) {
      const key = normalizeCatalogText(name);
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
    const affectedBooks = await many(reader, db.collectionGroup("books")
      .where("authorIds", "array-contains-any", absorbed)
      .limit(MAX_TOUCHED_DOCUMENTS + 1));
    if (affectedBooks.size > MAX_TOUCHED_DOCUMENTS) operationTooLarge();
    books = affectedBooks.docs.map((snapshot) => {
      const path = snapshot.ref.path.split("/");
      if (path.length !== 4 || path[0] !== "users" || path[2] !== "books") {
        failedPrecondition("Catalog author is referenced outside a personal book.", "catalog-invariant");
      }
      const ids = strings(snapshot.get("authorIds"), `${snapshot.ref.path}.authorIds`);
      const nextIds = [...new Set(ids.map((authorId) =>
        absorbed.includes(authorId) ? target.snapshot.id : authorId,
      ))];
      changes.push(change(
        "book", snapshot.ref, "update", {authorIds: ids}, {authorIds: nextIds},
        {type: "set", data: {authorIds: nextIds}},
      ));
      return bookVersion(snapshot, {uid: path[1], bookId: path[3]}, null, ids);
    });
  } else if (operation.type === "createWork") {
    const ref = db.collection("works").doc(operation.workId);
    const snapshot = await one(reader, ref);
    catalog.push(versionOf("work", snapshot));
    if (snapshot.exists) failedPrecondition("Work ID already exists.", "catalog-invariant");
    await ensureCollectionCapacity(
      reader, db.collection("works"), MAX_WORKS, 1, "works",
    );
    catalog.push(...await validateWorkAuthors(reader, db, operation.work.authorIds));
    if (operation.visibility === "searchable" && operation.books.length > 0) {
      const selected = await Promise.all(operation.books.map(({uid, bookId}) =>
        one(reader, db.doc(`users/${uid}/books/${bookId}`)),
      ));
      if (selected.some((book) => !book.exists) ||
          !await promotionEligible(reader, db, selected)) {
        failedPrecondition(
          "Selected private books do not permit searchable catalog disclosure.",
          "catalog-invariant",
        );
      }
    }
    // A zero-book searchable create is treated as external curation by the
    // administrator: no reader or private library record is disclosed.
    const work = workInputData(operation.work, operation.visibility, now);
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
    const current = await activeWork(reader, db, operation.workId);
    catalog.push(versionOf("work", current.snapshot));
    catalog.push(...await validateWorkAuthors(reader, db, operation.work.authorIds));
    if (current.work.visibility === "internal" && operation.visibility === "searchable") {
      const ids = [current.snapshot.id, ...current.work.mergedFrom];
      const linked = await many(reader, db.collectionGroup("books")
        .where("workId", "in", ids)
        .limit(101));
      const candidates = linked.docs.slice(0, 100);
      if (candidates.length === 0 || !await promotionEligible(reader, db, candidates)) {
        failedPrecondition(
          "This work has no consent-eligible linked book for promotion.",
          "catalog-invariant",
        );
      }
    }
    const next = workInputData(operation.work, operation.visibility, now, current.work);
    changes.push(change(
      "work", current.snapshot.ref, "update", wireWork(current.work), wireWork(next),
      {type: "set", data: {...next}},
    ));
    const indexes = await titleIndexChanges(reader, db, operation.workId, next);
    changes.push(...indexes.changes);
    catalog.push(...indexes.versions);
  } else if (operation.type === "mergeWorks") {
    const target = await activeWork(reader, db, operation.targetWorkId);
    catalog.push(versionOf("work", target.snapshot));
    const sources = await Promise.all(operation.sourceWorkIds.map((id) =>
      activeWork(reader, db, id),
    ));
    catalog.push(...sources.map(({snapshot}) => versionOf("work", snapshot)));
    const absorbed = [...new Set(sources.flatMap(({snapshot, work}) =>
      [snapshot.id, ...work.mergedFrom],
    ))];
    if (target.work.visibility === "searchable") {
      for (const source of sources.filter(({work}) => work.visibility === "internal")) {
        const ids = [source.snapshot.id, ...source.work.mergedFrom];
        const candidates = await many(reader, db.collectionGroup("books")
          .where("workId", "in", ids).limit(101));
        if (candidates.empty ||
            !await promotionEligible(reader, db, candidates.docs.slice(0, 100))) {
          failedPrecondition(
            `Internal source ${source.snapshot.id} needs consent-eligible provenance before a searchable merge.`,
            "catalog-invariant",
          );
        }
      }
    }
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
    }, target.work.visibility, now, {...target.work, mergedFrom});
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
        "isbn", snapshot.ref, "update", snapshot.data(), {
          ...next,
        }, {type: "set", data: next},
      ));
    }
    const externalRows = await many(reader, db.collection("externalIdIndex")
      .where("workId", "in", absorbed).limit(MAX_EXTERNAL_ID_INDEXES + 1));
    if (externalRows.size > MAX_EXTERNAL_ID_INDEXES) operationTooLarge();
    for (const snapshot of externalRows.docs) {
      catalog.push(versionOf("external-id", snapshot));
      const next = {...snapshot.data(), workId: target.snapshot.id};
      changes.push(change(
        "external-id", snapshot.ref, "update", snapshot.data(), {
          ...next,
        }, {type: "set", data: next},
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
    const work = await activeWork(reader, db, operation.workId);
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
      changes.push(change(
        "isbn", isbn.ref, "create", null, {...row},
        {type: "create", data: row},
      ));
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
      // Moving an edition under a searchable work makes it readable
      // (editions/{id} get rule follows the work's visibility), so an
      // edition seeded under an internal work needs the same consent
      // provenance as editWork and mergeWorks promotion. Anything but a
      // searchable source counts as internal, fail-closed.
      const oldWork = await one(reader, db.collection("works").doc(old.workId));
      catalog.push(versionOf("work", oldWork));
      if (oldWork.get("visibility") !== "searchable" &&
          work.work.visibility === "searchable" &&
          (linked.empty || !await promotionEligible(reader, db, linked.docs))) {
        failedPrecondition(
          "This edition has no consent-eligible linked book for searchable disclosure.",
          "catalog-invariant",
        );
      }
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
          "book", book.ref, "update", {...before}, {...after},
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
          "isbn", isbn.ref, "update", isbn.data() ?? null,
          {...row}, {type: "set", data: row},
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
      {...isbnRow},
      {type: isbn.exists ? "set" : "create", data: isbnRow},
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
    const plan = await planOperation(reader, db, request.operation, now);
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

function tokenAgreement(left: string, right: string): number {
  const leftTokens = new Set(normalizeCatalogText(left).split(" ").filter(Boolean));
  const rightTokens = new Set(normalizeCatalogText(right).split(" ").filter(Boolean));
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

export async function scanAdminCatalog(db: Firestore, bookCursor: string | null) {
  let bookQuery = db.collectionGroup("books").orderBy(FieldPath.documentId());
  if (bookCursor !== null) bookQuery = bookQuery.startAfter(db.doc(bookCursor));
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
      db.collection("externalIdIndex").limit(MAX_EXTERNAL_ID_INDEXES + 1).get(),
    ]);
  ensureBound(catalogAuthorRows, MAX_CATALOG_AUTHORS, "catalog authors");
  ensureBound(workRows, MAX_WORKS, "works");
  ensureBound(editionRows, MAX_EDITIONS, "editions");
  ensureBound(isbnRows, MAX_ISBN_INDEXES, "ISBN indexes");
  ensureBound(externalRows, MAX_EXTERNAL_ID_INDEXES, "external ID indexes");
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
    if (work.status === "active") return workId;
    if (work.mergedInto === undefined) return null;
    return workById.get(work.mergedInto)?.status === "active" ? work.mergedInto : null;
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
        [new Set([normalizeCatalogText(author.canonicalName), ...author.nameKeys])];
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
  const authorNames = (snapshot: DocumentSnapshot): string[] => {
    const ids = snapshot.get("authorIds");
    if (Array.isArray(ids)) return [...new Set(ids.flatMap((id) => {
      if (typeof id !== "string") return [];
      const resolvedId = resolvedCatalogAuthorId(id);
      const resolved = resolvedId === null ? undefined : catalogAuthorById.get(resolvedId);
      if (resolved === undefined) authorProblems.add(snapshot.ref.path);
      return resolved === undefined || resolved.kind === "placeholder" ? [] : [resolved.canonicalName];
    }))];
    const legacy = snapshot.get("authors");
    if (Array.isArray(legacy)) return legacy.flatMap((entry) =>
      typeof entry?.name === "string" ? [entry.name] : [],
    );
    return typeof snapshot.get("author") === "string" ? [snapshot.get("author")] : [];
  };

  const findings: Array<{
    code: string;
    severity: "error" | "warning";
    message: string;
    workIds: string[];
    editionIds: string[];
    books: AdminBookTarget[];
  }> = [];
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
    let link: LinkState;
    let malformedLink = false;
    try {
      link = linkFrom(snapshot);
    } catch {
      link = {workId: null, editionId: null, matchMethod: null, linkedAt: null};
      malformedLink = true;
    }
    if (link.workId !== null) {
      const resolved = resolvedWorkId(link.workId) ?? link.workId;
      linkedCounts.set(resolved, (linkedCounts.get(resolved) ?? 0) + 1);
    }
    const rawTitle = snapshot.get("title");
    const rawPageCount = snapshot.get("pageCount");
    const rawCreatedAt = snapshot.get("createdAt");
    const rawUpdatedAt = snapshot.get("updatedAt");
    const malformedBibliography = typeof rawTitle !== "string" ||
      typeof rawPageCount !== "number" || !Number.isFinite(rawPageCount) ||
      !(rawCreatedAt instanceof Timestamp) || !(rawUpdatedAt instanceof Timestamp);
    const title = typeof rawTitle === "string" ? rawTitle : "(malformed title)";
    const pageCount = typeof rawPageCount === "number" && Number.isFinite(rawPageCount) ?
      rawPageCount : 0;
    const names = authorNames(snapshot);
    let anomaly: string | null = !liveUsers.has(uid) ? "orphaned data" :
      malformedLink ? "malformed catalog link" :
        malformedBibliography ? "malformed bibliography" :
          authorProblems.has(snapshot.ref.path) ? "missing or malformed author" : null;
    const resolvedBookWork = link.workId === null ? null : resolvedWorkId(link.workId);
    if (link.workId !== null && resolvedBookWork === null) anomaly = "missing or broken work";
    const linkedEdition = link.editionId === null ? null : editionById.get(link.editionId);
    if (link.editionId !== null && linkedEdition === undefined) anomaly = "missing edition";
    if (linkedEdition !== null && linkedEdition !== undefined && resolvedBookWork !== null &&
        resolvedWorkId(linkedEdition.workId) !== resolvedBookWork) {
      anomaly = "edition belongs to another work";
    }
    if (anomaly !== null) findings.push({
      code: "book-link-anomaly",
      severity: "error",
      message: anomaly,
      workIds: link.workId === null ? [] : [link.workId],
      editionIds: link.editionId === null ? [] : [link.editionId],
      books: [{uid, bookId: snapshot.id}],
    });
    const rawIsbn = optionalText(snapshot.get("isbn"));
    return [{
      uid,
      bookId: snapshot.id,
      title,
      authorNames: names,
      // The same normalizer the link/apply path uses, so an ISBN-10 that
      // apply would happily link is also reported as a candidate here.
      isbn13: normalizedBookIsbn(rawIsbn),
      rawIsbn: normalizedBookIsbn(rawIsbn) === null && rawIsbn !== "" ? rawIsbn : null,
      pageCount,
      publisher: optionalText(snapshot.get("publisher")),
      publishedDate: optionalText(snapshot.get("publishedDate")),
      coverUrl: optionalText(snapshot.get("coverUrl")),
      ...link,
      createdAt: rawCreatedAt instanceof Timestamp ? rawCreatedAt.toMillis() : 0,
      updatedAt: rawUpdatedAt instanceof Timestamp ? rawUpdatedAt.toMillis() : 0,
      anomaly,
    }];
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
    const normalizedAuthors = new Set(book.authorNames.map(normalizeCatalogText));
    // "Exact" is the migration contract: the complete normalized author
    // identity agrees, aliases included. A book by [A, B] against a work by
    // [A, C] is partial overlap and stays in the similarity path below —
    // the admin UI offers this label as a one-click link.
    const candidates = [...workById].filter(([, work]) =>
      work.status === "active" && work.titleKeys.includes(key) &&
      exactAuthorSet(work, normalizedAuthors),
    );
    if (candidates.length > 0) findings.push({
      code: "unmatched-title-author-candidate",
      severity: "warning",
      message: "Unmatched book has an exact normalized title and author candidate.",
      workIds: candidates.map(([id]) => id),
      editionIds: [],
      books: [{uid: book.uid, bookId: book.bookId}],
    });
    if (candidates.length > 0) continue;
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
    if (!workById.has(edition.workId)) findings.push({
      code: "edition-missing-work",
      severity: "error",
      message: "Edition targets a missing work.",
      workIds: [edition.workId],
      editionIds: [editionId],
      books: [],
    });
  }
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
  for (const snapshot of externalRows.docs) {
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
        (work.mergedInto === undefined || workById.get(work.mergedInto)?.status !== "active")) {
      warnings.push("broken redirect");
    }
    if (work.status === "active" && work.mergedFrom.length > 29) {
      warnings.push("too many aliases");
    }
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
    for (const warning of warnings) findings.push({
      code: "work-invariant",
      severity: "error",
      message: warning,
      workIds: [id],
      editionIds: [],
      books: [],
    });
  }
  const catalogAuthorWarnings = new Map<string, string[]>();
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
      [author.canonicalName, ...author.alternateNames].map(normalizeCatalogText),
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
  return {
    authors: [...catalogAuthorById].map(([authorId, author]) => ({
      authorId,
      ...wireAuthor(author),
      workCount: catalogAuthorWorkCounts.get(authorId) ?? 0,
      warnings: catalogAuthorWarnings.get(authorId) ?? [],
    })),
    works: [...workById].map(([workId, work]) => ({
      workId,
      ...wireWork(work),
      editionCount: editionCounts.get(workId) ?? 0,
      linkedBookCount: linkedCounts.get(workId) ?? 0,
      warnings: workWarnings.get(workId) ?? [],
    })),
    editions: [...editionById].map(([editionId, edition]) => ({
      editionId,
      ...wireEdition(edition),
    })),
    books,
    nextBookCursor,
    bookCountsComplete: bookCursor === null && nextBookCursor === null,
    findings: bookCursor === null ? findings : findings.filter(
      (finding) => finding.books.length > 0,
    ),
    limits: {
      catalogAuthors: MAX_CATALOG_AUTHORS,
      works: MAX_WORKS,
      editions: MAX_EDITIONS,
      books: BOOK_PAGE_SIZE,
      isbnIndexes: MAX_ISBN_INDEXES,
      externalIdIndexes: MAX_EXTERNAL_ID_INDEXES,
      authorsPerWork: MAX_AUTHORS_PER_WORK,
    },
  };
}
