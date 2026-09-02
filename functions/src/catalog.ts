import * as functions from "firebase-functions/v1";
import {logger} from "firebase-functions";
import {
  DocumentReference,
  DocumentSnapshot,
  FieldPath,
  getFirestore,
  Query,
  QueryDocumentSnapshot,
  QuerySnapshot,
  Timestamp,
} from "firebase-admin/firestore";
import {createHash, randomUUID} from "node:crypto";
import {Buffer} from "node:buffer";
import {
  CatalogAddEditionRequest,
  CatalogAuthorCreateInput,
  CatalogCreateRequest,
  CatalogExternalId,
  CatalogSearchRequest,
  decodeCatalogAddEditionRequest,
  decodeCatalogCreateRequest,
  decodeCatalogSearchRequest,
  decodeEnsureCatalogAuthorsRequest,
  decodeWorkReadersRequest,
  normalizeCatalogIdentity,
} from "./decoders";
import {consumeQuota} from "./quota";
import {requireLiveUser, requireVerifiedUid} from "./callerGuards";
import {sharedWorkOwnerId} from "./catalogProjection";
import {readerIdentity, sharingConsent, validTimeZone} from "./sharingConsent";
import {CATALOG_LIMITS} from "./shared/catalogLimits";
import {externalIndexDigestInput, normalizeCatalogTitle} from "./shared/catalogIdentity";

export {normalizeCatalogTitle};
import {CALLABLE_MAX_INSTANCES, FUNCTIONS_RUNTIME_SERVICE_ACCOUNT} from "./runtime";
import {logAppCheckPresence} from "./appCheck";

const db = getFirestore();

const SEARCH_LIMIT = 10;
const TITLE_CANDIDATE_LIMIT = 25;
// Total index rows one search may examine across pages. Identical
// normalized titles ("Collected Works") can outnumber a single page, and
// the author filter only runs on hydrated candidates — a lone capped query
// would exhaust before the requested author's work ever surfaced. Six
// pages cost ~150 index reads plus their hydrations, well under a cent.
const TITLE_SCAN_LIMIT = 150;
const BOOKS_PER_UID_LIMIT = 5;
const SHARED_OWNER_LIMIT = 10;
const EDITION_LIMIT = 100;
const UPDATES_PER_BOOK_LIMIT = 200;
// Cost basis: one reader page reads at most ten owners × five books × 200
// update rows, ~10k reads ≈ $0.006. At 60 calls an hour a single hostile
// verified account can spend ≈ $0.36/h ≈ $9/day, under the billing alert.
// Search has no quota: it costs on the order of 100 reads ≈ $0.00006.
const READER_CALLS_PER_WINDOW = 60;
const MAX_CATALOG_AUTHORS = CATALOG_LIMITS.catalogAuthors;
const QUOTA_WINDOW_MS = 60 * 60 * 1000;
const SPEED_MIN_SESSION_MINUTES = 5;
const SPEED_MAX_PAGES_PER_HOUR = 150;
const BOOK_SPEED_MIN_MINUTES = 60;

type WorkStatus = "active" | "merged" | "hidden";

export interface StoredWork {
  canonicalTitle: string;
  alternateTitles: string[];
  titleKeys: string[];
  authorIds: string[];
  coverUrl: string;
  subjects: string[];
  fiction: boolean | null;
  // The work's default language (ISO 639 code, '' unknown): what its
  // editions are in unless one overrides it (shared/language.ts).
  language: string;
  status: WorkStatus;
  mergedInto?: string;
  mergedFrom: string[];
}

export interface StoredCatalogAuthor {
  canonicalName: string;
  alternateNames: string[];
  nameKeys: string[];
  sortName: string;
  kind: "person" | "entity" | "placeholder";
  status: "active" | "merged";
  mergedInto?: string;
  mergedFrom: string[];
  // The uid whose add-book flow minted the author; absent for authors the
  // migration or an administrator created.
  createdBy?: string;
}

export interface StoredEdition {
  workId: string;
  isbn13: string | null;
  title: string;
  publisher: string;
  publishedDate: string;
  language: string;
  translatorNames: string[];
  format: "full" | "abridged" | "revised" | "unknown";
  suggestedPageCount: number | null;
  coverUrl: string;
  externalIds: Record<string, string>;
  // The uid whose book the edition was minted for (the add-book flow, an
  // admin link or the backfill); absent for migration- or admin-created
  // editions.
  createdBy?: string;
  // An edition merged into another is an alias: status "merged" and
  // mergedInto name the survivor, which lists the absorbed ids in
  // mergedFrom. Absent status is active. The alias keeps its identifiers
  // and index rows; lookups that land on it answer with the survivor.
  status?: "active" | "merged";
  mergedInto?: string;
  mergedFrom?: string[];
}

interface ResolvedWork {
  id: string;
  work: StoredWork;
}

interface WorkSummary {
  workId: string;
  canonicalTitle: string;
  alternateTitles: string[];
  authors: AuthorSummary[];
  coverUrl: string;
  subjects: string[];
  fiction: boolean | null;
  language: string;
  mergedFrom: string[];
}

interface AuthorSummary {
  authorId: string;
  canonicalName: string;
  sortName: string;
  kind: StoredCatalogAuthor["kind"];
}

// Search matches a requested author against every stored alias, not only
// the canonical spelling; the keys never leave the process (the wire
// shape is AuthorSummary, pinned by the client's exactKeys decoder).
interface ResolvedAuthor extends AuthorSummary {
  nameKeys: string[];
}

interface EditionSummary {
  editionId: string;
  workId: string;
  isbn13: string | null;
  title: string;
  publisher: string;
  publishedDate: string;
  language: string;
  translatorNames: string[];
  format: StoredEdition["format"];
  suggestedPageCount: number | null;
  coverUrl: string;
}

interface CatalogSearchResult {
  workId: string;
  editionId: string | null;
  confidence: "exact-edition" | "strong-work" | "possible-work";
  reason: string;
  work: WorkSummary;
  edition: EditionSummary | null;
}

interface ReadingEvent {
  type: "reading" | "update";
  createdAt: Timestamp;
  pagesRead: number;
  timeRead: number;
}

interface ReadingAttemptMetrics {
  status: "reading" | "finished";
  pageCount: number;
  firstProgressAt: string | null;
  firstReadAt: string | null;
  finishedAt: string | null;
  calendarDays: number | null;
  activeDays: number;
  trackedMinutes: number;
  sessionCount: number;
  qualifiedPagesPerHour: number | null;
  percentPerHour: number | null;
  trackingCoverage: number | null;
}

// readerKey groups one reader's attempts (rereads) on the page: the
// username when the reader has a public profile, otherwise an opaque key
// derived from the projection row id, so an anonymous reader is still one
// card and nothing identifying leaves the server.
interface WorkReaderAttemptSummary extends ReadingAttemptMetrics {
  readerKey: string;
  username: string | null;
  displayName: string | null;
}

class CatalogDataError extends Error {}

// The stored-document decoders below are shared with the admin scan, which
// reports a violation as a failed-precondition the console can render
// instead of a CatalogDataError. Only the reporter differs, so it is the
// parameter.
export type CatalogDataFail = (_message: string) => never;

const catalogDataError: CatalogDataFail = (message) => {
  throw new CatalogDataError(message);
};

const invalidArgument = (message: string): never => {
  throw new functions.https.HttpsError("invalid-argument", message);
};

export function catalogAuthorId(nameKey: string): string {
  return `author_${createHash("sha256")
    .update(`author\0${nameKey}`)
    .digest("hex")
    .slice(0, 24)}`;
}

async function requireQuota(
  uid: string,
  name: string,
  limit: number,
): Promise<void> {
  const decision = await consumeQuota(
    db,
    `users/${uid}/functionQuotas/${name}`,
    limit,
    QUOTA_WINDOW_MS,
  );
  if (!decision.granted) {
    throw new functions.https.HttpsError(
      "resource-exhausted",
      "Catalog request limit reached. Try again later.",
    );
  }
}

export function storedWork(
  snapshot: DocumentSnapshot,
  fail: CatalogDataFail = catalogDataError,
): StoredWork {
  if (!snapshot.exists) fail(`Missing catalog work ${snapshot.ref.path}.`);
  const data = snapshot.data();
  if (data === undefined) fail(`Missing catalog work data ${snapshot.ref.path}.`);
  if (data.status !== "active" && data.status !== "merged" && data.status !== "hidden") {
    fail(`Invalid work status at ${snapshot.ref.path}.`);
  }
  const arrays = [
    data.alternateTitles,
    data.titleKeys,
    data.authorIds,
    data.subjects,
    data.mergedFrom,
  ];
  if (arrays.some((value) =>
    !Array.isArray(value) || value.some((entry) => typeof entry !== "string"))) {
    fail(`Invalid work arrays at ${snapshot.ref.path}.`);
  }
  if (typeof data.canonicalTitle !== "string" || typeof data.coverUrl !== "string" ||
      (data.fiction !== null && typeof data.fiction !== "boolean")) {
    fail(`Invalid catalog work ${snapshot.ref.path}.`);
  }
  if (data.mergedInto !== undefined && typeof data.mergedInto !== "string") {
    fail(`Invalid work redirect at ${snapshot.ref.path}.`);
  }
  // Absent on works that predate the language field; migrate-work-languages.ts
  // stamps every work, and until then an absent language is unknown.
  const language = data.language ?? "";
  if (typeof language !== "string") fail(`Invalid work language at ${snapshot.ref.path}.`);
  return {
    canonicalTitle: data.canonicalTitle,
    alternateTitles: data.alternateTitles,
    titleKeys: data.titleKeys,
    authorIds: data.authorIds,
    coverUrl: data.coverUrl,
    subjects: data.subjects,
    fiction: data.fiction,
    language,
    status: data.status,
    ...(data.mergedInto === undefined ? {} : {mergedInto: data.mergedInto}),
    mergedFrom: data.mergedFrom,
  };
}

export function storedEdition(
  snapshot: DocumentSnapshot,
  fail: CatalogDataFail = catalogDataError,
): StoredEdition {
  if (!snapshot.exists) fail(`Missing catalog edition ${snapshot.ref.path}.`);
  const data = snapshot.data();
  if (data === undefined) fail(`Missing edition data ${snapshot.ref.path}.`);
  if (typeof data.workId !== "string" ||
      (data.isbn13 !== null && typeof data.isbn13 !== "string") ||
      typeof data.title !== "string" ||
      typeof data.publisher !== "string" || typeof data.publishedDate !== "string" ||
      typeof data.language !== "string" || !Array.isArray(data.translatorNames) ||
      data.translatorNames.some((name: unknown) => typeof name !== "string") ||
      !["full", "abridged", "revised", "unknown"].includes(data.format) ||
      (data.suggestedPageCount !== null && typeof data.suggestedPageCount !== "number") ||
      typeof data.coverUrl !== "string" || typeof data.externalIds !== "object" ||
      data.externalIds === null || Array.isArray(data.externalIds) ||
      Object.entries(data.externalIds).some(([provider, id]) =>
        !/^[a-z0-9-]{1,40}$/.test(provider) || typeof id !== "string") ||
      (data.createdBy !== undefined && typeof data.createdBy !== "string") ||
      (data.status !== undefined && data.status !== "active" && data.status !== "merged") ||
      (data.mergedInto !== undefined && typeof data.mergedInto !== "string") ||
      (data.mergedFrom !== undefined && (!Array.isArray(data.mergedFrom) ||
        data.mergedFrom.some((id: unknown) => typeof id !== "string")))) {
    fail(`Invalid catalog edition ${snapshot.ref.path}.`);
  }
  return {
    workId: data.workId,
    isbn13: data.isbn13,
    title: data.title,
    publisher: data.publisher,
    publishedDate: data.publishedDate,
    language: data.language,
    translatorNames: data.translatorNames,
    format: data.format,
    suggestedPageCount: data.suggestedPageCount,
    coverUrl: data.coverUrl,
    externalIds: data.externalIds,
    ...(data.createdBy === undefined ? {} : {createdBy: data.createdBy}),
    ...(data.status === undefined ? {} : {status: data.status}),
    ...(data.mergedInto === undefined ? {} : {mergedInto: data.mergedInto}),
    ...(data.mergedFrom === undefined ? {} : {mergedFrom: data.mergedFrom}),
  };
}

export function storedCatalogAuthor(
  snapshot: DocumentSnapshot,
  fail: CatalogDataFail = catalogDataError,
): StoredCatalogAuthor {
  if (!snapshot.exists) fail(`Missing catalog author ${snapshot.ref.path}.`);
  const data = snapshot.data();
  if (data === undefined || typeof data.canonicalName !== "string" ||
      typeof data.sortName !== "string" ||
      !["person", "entity", "placeholder"].includes(data.kind) ||
      (data.status !== "active" && data.status !== "merged")) {
    fail(`Invalid catalog author ${snapshot.ref.path}.`);
  }
  const arrays = [data.alternateNames, data.nameKeys, data.mergedFrom];
  if (arrays.some((value) => !Array.isArray(value) ||
      value.some((entry) => typeof entry !== "string"))) {
    fail(`Invalid catalog author arrays at ${snapshot.ref.path}.`);
  }
  if (data.mergedInto !== undefined && typeof data.mergedInto !== "string") {
    fail(`Invalid catalog author redirect at ${snapshot.ref.path}.`);
  }
  if (data.createdBy !== undefined && typeof data.createdBy !== "string") {
    fail(`Invalid catalog author creator at ${snapshot.ref.path}.`);
  }
  return {
    canonicalName: data.canonicalName,
    alternateNames: data.alternateNames,
    nameKeys: data.nameKeys,
    sortName: data.sortName,
    kind: data.kind,
    status: data.status,
    ...(data.mergedInto === undefined ? {} : {mergedInto: data.mergedInto}),
    mergedFrom: data.mergedFrom,
    ...(data.createdBy === undefined ? {} : {createdBy: data.createdBy}),
  };
}

function authorSummary(author: ResolvedAuthor): AuthorSummary {
  return {
    authorId: author.authorId,
    canonicalName: author.canonicalName,
    sortName: author.sortName,
    kind: author.kind,
  };
}

// Merged authors redirect one hop, like works (resolveWork below): the
// alias document stays behind forever, so a work, a personal book or a
// stale client may name it and every reader follows the redirect.
async function resolveCatalogAuthor(
  read: SnapshotReader,
  snapshot: DocumentSnapshot,
): Promise<ResolvedAuthor> {
  const author = storedCatalogAuthor(snapshot);
  if (author.status === "active") {
    return {
      authorId: snapshot.id,
      canonicalName: author.canonicalName,
      sortName: author.sortName,
      kind: author.kind,
      nameKeys: author.nameKeys,
    };
  }
  if (author.mergedInto === undefined || author.mergedInto === snapshot.id) {
    throw new CatalogDataError(`Broken catalog author redirect at ${snapshot.ref.path}.`);
  }
  const targetSnapshot = await read(db.collection("catalogAuthors").doc(author.mergedInto));
  const target = storedCatalogAuthor(targetSnapshot);
  if (target.status !== "active") {
    throw new CatalogDataError(`Catalog author redirect is not one hop at ${snapshot.ref.path}.`);
  }
  return {
    authorId: targetSnapshot.id,
    canonicalName: target.canonicalName,
    sortName: target.sortName,
    kind: target.kind,
    nameKeys: target.nameKeys,
  };
}

async function workAuthors(
  work: StoredWork,
  cache: Map<string, Promise<ResolvedAuthor>> = new Map(),
): Promise<ResolvedAuthor[]> {
  const resolved = await Promise.all(work.authorIds.map((authorId) => {
    const cached = cache.get(authorId);
    if (cached !== undefined) return cached;
    const pending = readSnapshot(db.collection("catalogAuthors").doc(authorId))
      .then((snapshot) => resolveCatalogAuthor(readSnapshot, snapshot));
    cache.set(authorId, pending);
    return pending;
  }));
  const byId = new Map(resolved.map((author) => [author.authorId, author]));
  return [...byId.values()];
}

export function externalIndexId(externalId: CatalogExternalId): string {
  return createHash("sha256")
    .update(externalIndexDigestInput(externalId.provider, externalId.id))
    .digest("hex");
}

// A merge redirect is followed with the caller's own reader: a plain get
// outside a transaction, tx.get inside one, so the transaction that acts on
// the target has read it and cannot commit against a stale redirect.
type SnapshotReader = (_ref: DocumentReference) => Promise<DocumentSnapshot>;

const readSnapshot: SnapshotReader = (ref) => ref.get();

async function resolveWork(
  read: SnapshotReader,
  snapshot: DocumentSnapshot,
): Promise<ResolvedWork> {
  const work = storedWork(snapshot);
  if (work.status !== "merged") return {id: snapshot.id, work};
  if (work.mergedInto === undefined || work.mergedInto === snapshot.id) {
    throw new CatalogDataError(`Broken catalog redirect at ${snapshot.ref.path}.`);
  }
  const target = storedWork(await read(db.collection("works").doc(work.mergedInto)));
  if (target.status === "merged") {
    throw new CatalogDataError(
      `Catalog redirect is not one hop at ${snapshot.ref.path}.`,
    );
  }
  return {id: work.mergedInto, work: target};
}

interface ResolvedEdition {
  id: string;
  edition: StoredEdition;
}

// One hop, like works: a merged edition names its survivor, and a survivor
// that is itself merged is corruption.
async function resolveEdition(
  read: SnapshotReader,
  snapshot: DocumentSnapshot,
): Promise<ResolvedEdition> {
  const edition = storedEdition(snapshot);
  if (edition.status !== "merged") return {id: snapshot.id, edition};
  if (edition.mergedInto === undefined || edition.mergedInto === snapshot.id) {
    throw new CatalogDataError(`Broken catalog redirect at ${snapshot.ref.path}.`);
  }
  const target = storedEdition(await read(db.collection("editions").doc(edition.mergedInto)));
  if (target.status === "merged") {
    throw new CatalogDataError(
      `Catalog redirect is not one hop at ${snapshot.ref.path}.`,
    );
  }
  return {id: edition.mergedInto, edition: target};
}

async function workSummary(
  resolved: ResolvedWork,
  authors?: ResolvedAuthor[],
): Promise<WorkSummary> {
  return {
    workId: resolved.id,
    canonicalTitle: resolved.work.canonicalTitle,
    alternateTitles: resolved.work.alternateTitles,
    authors: (authors ?? await workAuthors(resolved.work)).map(authorSummary),
    coverUrl: resolved.work.coverUrl,
    subjects: resolved.work.subjects,
    fiction: resolved.work.fiction,
    language: resolved.work.language,
    mergedFrom: resolved.work.mergedFrom,
  };
}

function editionSummary(
  id: string,
  edition: StoredEdition,
  resolvedWorkId: string,
): EditionSummary {
  return {
    editionId: id,
    workId: resolvedWorkId,
    isbn13: edition.isbn13,
    title: edition.title,
    publisher: edition.publisher,
    publishedDate: edition.publishedDate,
    language: edition.language,
    translatorNames: edition.translatorNames,
    format: edition.format,
    suggestedPageCount: edition.suggestedPageCount,
    coverUrl: edition.coverUrl,
  };
}

// One exact-identifier lookup for both indexes: the index row names a work
// and an edition, and the edition must still carry the identifier that led
// here. A miss returns null after the single index read.
async function exactIndexResult(
  indexRef: DocumentReference,
  reason: string,
  agrees: (_index: DocumentSnapshot, _edition: StoredEdition) => boolean,
): Promise<CatalogSearchResult | null> {
  const index = await indexRef.get();
  if (!index.exists) return null;
  const workId = index.get("workId");
  const editionId = index.get("editionId");
  if (typeof workId !== "string" || typeof editionId !== "string") {
    throw new CatalogDataError(`Invalid catalog index ${index.ref.path}.`);
  }
  const [workSnapshot, editionSnapshot] = await Promise.all([
    db.collection("works").doc(workId).get(),
    db.collection("editions").doc(editionId).get(),
  ]);
  const resolved = await resolveWork(readSnapshot, workSnapshot);
  const edition = storedEdition(editionSnapshot);
  const editionWork = edition.workId === workId ? resolved :
    await resolveWork(readSnapshot, await db.collection("works").doc(edition.workId).get());
  if (editionWork.id !== resolved.id || !agrees(index, edition)) {
    throw new CatalogDataError(`Catalog index ${index.ref.path} disagrees with its edition.`);
  }
  if (resolved.work.status !== "active") return null;
  // The index row keeps naming the edition that carries the identifier; a
  // merged one answers with its survivor.
  const surviving = await resolveEdition(readSnapshot, editionSnapshot);
  return {
    workId: resolved.id,
    editionId: surviving.id,
    confidence: "exact-edition",
    reason,
    work: await workSummary(resolved),
    edition: editionSummary(surviving.id, surviving.edition, resolved.id),
  };
}

async function exactIsbnResult(isbn13: string): Promise<CatalogSearchResult | null> {
  return exactIndexResult(
    db.collection("isbnIndex").doc(isbn13),
    "Exact ISBN match",
    (_index, edition) => edition.isbn13 === isbn13,
  );
}

async function exactExternalIdResult(
  externalId: CatalogExternalId,
): Promise<CatalogSearchResult | null> {
  return exactIndexResult(
    db.collection("externalIdIndex").doc(externalIndexId(externalId)),
    "Exact external ID match",
    (index, edition) => index.get("provider") === externalId.provider &&
      index.get("externalId") === externalId.id &&
      edition.externalIds[externalId.provider] === externalId.id,
  );
}

function tokenSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  return (2 * overlap) / (leftTokens.size + rightTokens.size);
}

// The decoder refuses a title search with no author name, so `requested` is
// never empty here.
function authorAgreement(requested: readonly string[], authors: readonly ResolvedAuthor[]): number {
  const candidates = new Set(authors.flatMap((author) =>
    [normalizeCatalogIdentity(author.canonicalName), ...author.nameKeys],
  ));
  const normalized = [...new Set(requested.map(normalizeCatalogIdentity))];
  return normalized.filter((name) => candidates.has(name)).length / normalized.length;
}

async function titleResults(
  title: string,
  authors: readonly string[],
): Promise<CatalogSearchResult[]> {
  const key = normalizeCatalogTitle(title);
  if (key === "") return [];
  const baseQuery = db.collection("workTitleIndex")
    .where("status", "==", "active")
    .where("titleKey", ">=", key)
    .where("titleKey", "<", `${key}\uf8ff`)
    .orderBy("titleKey");
  // Pages are scanned until a strong candidate (exact title, full author
  // agreement) turns up, the rows run out, or TITLE_SCAN_LIMIT rows have
  // been examined \u2014 the usual search still costs one page.
  const seenRowWorkIds = new Set<string>();
  const scoredWorkIds = new Set<string>();
  const authorCache = new Map<string, Promise<ResolvedAuthor>>();
  const scored: Array<{
    candidate: ResolvedWork;
    candidateAuthors: ResolvedAuthor[];
    exactTitle: boolean;
    authorsMatch: number;
    score: number;
  }> = [];
  let scanned = 0;
  let cursor: QueryDocumentSnapshot | null = null;
  while (scanned < TITLE_SCAN_LIMIT) {
    const pageLimit = Math.min(TITLE_CANDIDATE_LIMIT, TITLE_SCAN_LIMIT - scanned);
    const pageQuery: Query = cursor === null ? baseQuery : baseQuery.startAfter(cursor);
    const indexRows: QuerySnapshot = await pageQuery.limit(pageLimit).get();
    scanned += indexRows.docs.length;
    const candidateIds = [...new Set(indexRows.docs.map((row) => row.get("workId")))]
      .filter((id): id is string => typeof id === "string" && !seenRowWorkIds.has(id));
    for (const id of candidateIds) seenRowWorkIds.add(id);
    const resolved = await Promise.all(candidateIds.map(async (id) =>
      resolveWork(readSnapshot, await db.collection("works").doc(id).get()),
    ));
    // Two rows (or a merge redirect met on a later page) can resolve to the
    // same work; a work is scored once.
    const byId = new Map<string, ResolvedWork>();
    for (const candidate of resolved) {
      if (candidate.work.status === "active" && !scoredWorkIds.has(candidate.id)) {
        byId.set(candidate.id, candidate);
      }
    }
    for (const id of byId.keys()) scoredWorkIds.add(id);
    const hydrated = await Promise.all([...byId.values()].map(async (candidate) => ({
      candidate,
      authors: await workAuthors(candidate.work, authorCache),
    })));
    for (const {candidate, authors: candidateAuthors} of hydrated) {
      const bestTitle = Math.max(...candidate.work.titleKeys.map((candidateKey) =>
        tokenSimilarity(key, candidateKey),
      ));
      const authorsMatch = authorAgreement(authors, candidateAuthors);
      const exactTitle = candidate.work.titleKeys.includes(key);
      scored.push({
        candidate,
        candidateAuthors,
        exactTitle,
        authorsMatch,
        score: bestTitle * 0.75 + authorsMatch * 0.25,
      });
    }
    if (scored.some(({exactTitle, authorsMatch}) => exactTitle && authorsMatch === 1)) break;
    if (indexRows.docs.length < pageLimit) break;
    cursor = indexRows.docs[indexRows.docs.length - 1];
  }
  const results = scored.filter(({score, exactTitle, authorsMatch}) =>
    authorsMatch > 0 && (exactTitle || score >= 0.55),
  )
    .sort((left, right) => right.score - left.score)
    .slice(0, SEARCH_LIMIT);

  return Promise.all(results.map(async ({candidate, candidateAuthors, exactTitle, authorsMatch}) => {
    const strong = exactTitle && authors.length > 0 && authorsMatch === 1;
    return {
      workId: candidate.id,
      editionId: null,
      confidence: strong ? "strong-work" as const : "possible-work" as const,
      reason: strong ? "Exact title and author match" :
        exactTitle ? "Exact title match; confirm the author" : "Similar title and author",
      work: await workSummary(candidate, candidateAuthors),
      edition: null,
    };
  }));
}

// The workTitleIndex row, shared with the admin scan: a stale copy in one
// writer would make the same key resolve to two different rows.
export function titleIndexId(workId: string, titleKey: string): string {
  return createHash("sha256").update(`${workId}\0${titleKey}`).digest("hex");
}

export function titleIndexRow(
  workId: string,
  title: string,
  titleKey: string,
  status: WorkStatus,
): {workId: string; title: string; titleKey: string; status: WorkStatus} {
  return {workId, title, titleKey, status};
}

interface CatalogCreateResult {
  workId: string;
  editionId: string;
  created: boolean;
}

// Any verified user may add the work and edition the catalog lacks for a
// book they are adding: catalog data is public whoever contributed it
// (owner decision 2026-08-31). An identifier already in the catalog
// resolves to its existing entry instead, so a retry or a race never
// duplicates one. The work records who created it for the admin review
// list; the admin curates (edit, merge, hide) from there.
export async function createCatalogEntry(
  request: CatalogCreateRequest,
  createdBy: string,
): Promise<CatalogCreateResult> {
  const workId = `work-${randomUUID()}`;
  const editionId = `edition-${randomUUID()}`;
  const now = Timestamp.now();
  return db.runTransaction(async (tx): Promise<CatalogCreateResult> => {
    const isbnRef = request.edition.isbn13 === null ? null :
      db.collection("isbnIndex").doc(request.edition.isbn13);
    const externalRefs = Object.entries(request.edition.externalIds).map(([provider, id]) => ({
      provider,
      id,
      ref: db.collection("externalIdIndex").doc(externalIndexId({provider, id})),
    }));
    const [
      isbnSnapshot,
      externalSnapshots,
      authorSnapshots,
      workCount,
      editionCount,
      isbnCount,
      externalCount,
    ] =
      await Promise.all([
        isbnRef === null ? Promise.resolve(null) : tx.get(isbnRef),
        Promise.all(externalRefs.map(({ref}) => tx.get(ref))),
        Promise.all(request.work.authorIds.map((authorId) =>
          tx.get(db.collection("catalogAuthors").doc(authorId)),
        )),
        tx.get(db.collection("works").count()),
        tx.get(db.collection("editions").count()),
        isbnRef === null ? Promise.resolve(null) :
          tx.get(db.collection("isbnIndex").count()),
        externalRefs.length === 0 ? Promise.resolve(null) :
          tx.get(db.collection("externalIdIndex").count()),
      ]);
    // A client that loaded its author list before an admin merge still
    // names the absorbed author; the id resolves one hop so the work is
    // written with the survivor (works carry canonical ids, books need not).
    const read: SnapshotReader = (ref) => tx.get(ref);
    const authorIds = [...new Set((await Promise.all(authorSnapshots.map((snapshot) =>
      resolveCatalogAuthor(read, snapshot),
    ))).map((author) => author.authorId))];
    const indexed = [isbnSnapshot, ...externalSnapshots].find((snapshot) => snapshot?.exists);
    if (indexed !== undefined && indexed !== null) {
      const indexedWorkId = indexed.get("workId");
      const indexedEditionId = indexed.get("editionId");
      if (typeof indexedWorkId !== "string" || typeof indexedEditionId !== "string") {
        throw new CatalogDataError(`Invalid catalog index ${indexed.ref.path}.`);
      }
      const resolved = await resolveWork(
        read,
        await read(db.collection("works").doc(indexedWorkId)),
      );
      const surviving = await resolveEdition(
        read,
        await read(db.collection("editions").doc(indexedEditionId)),
      );
      return {workId: resolved.id, editionId: surviving.id, created: false};
    }
    // Every collection this transaction appends to is checked against its
    // bound: the admin scan reads them whole and hard-fails past the caps,
    // so a creation path that skipped one (a request carries up to two
    // external IDs, so that index outpaces works) could disable catalog
    // administration.
    if (workCount.data().count >= CATALOG_LIMITS.works ||
        editionCount.data().count >= CATALOG_LIMITS.editions ||
        (isbnCount !== null && isbnCount.data().count >= CATALOG_LIMITS.isbnIndexes) ||
        (externalCount !== null && externalCount.data().count + externalRefs.length >
          CATALOG_LIMITS.externalIdIndexes)) {
      throw new functions.https.HttpsError(
        "resource-exhausted",
        "The shared catalog has reached its size bound. Ask an administrator to raise it.",
      );
    }
    // Each index row keeps the spelling its key came from, so the pairing is
    // built once instead of looked up again per key.
    const titleRows = new Map<string, string>();
    for (const title of [request.work.canonicalTitle, ...request.work.alternateTitles]) {
      const key = normalizeCatalogTitle(title);
      if (key !== "" && !titleRows.has(key)) titleRows.set(key, title);
    }
    const titleKeys = [...titleRows.keys()];
    tx.create(db.collection("works").doc(workId), {
      canonicalTitle: request.work.canonicalTitle,
      alternateTitles: request.work.alternateTitles,
      titleKeys,
      authorIds,
      coverUrl: request.work.coverUrl,
      subjects: request.work.subjects,
      fiction: request.work.fiction,
      language: request.work.language,
      status: "active",
      mergedFrom: [],
      createdBy,
      createdAt: now,
      updatedAt: now,
    });
    tx.create(db.collection("editions").doc(editionId), {
      workId,
      ...request.edition,
      createdBy,
      createdAt: now,
      updatedAt: now,
    });
    if (isbnRef !== null) tx.create(isbnRef, {workId, editionId});
    for (const external of externalRefs) {
      tx.create(external.ref, {
        workId,
        editionId,
        provider: external.provider,
        externalId: external.id,
      });
    }
    for (const [key, title] of titleRows) {
      tx.create(
        db.collection("workTitleIndex").doc(titleIndexId(workId, key)),
        titleIndexRow(workId, title, key, "active"),
      );
    }
    return {workId, editionId, created: true};
  });
}

// A verified user adds an edition to a work the catalog already has. The
// add-book flow calls this when the chosen search result is a work without
// a matching edition, so every linked personal book stands on an edition
// of its work (owner decision 2026-09-01); two readers' editions that prove
// to be one are for an operator to merge later. An identifier already in
// the catalog resolves to its existing entry instead, as catalog.create
// does, and a hidden or missing work is not found.
export async function addCatalogEdition(
  request: CatalogAddEditionRequest,
  createdBy: string,
): Promise<CatalogCreateResult> {
  const editionId = `edition-${randomUUID()}`;
  const now = Timestamp.now();
  return db.runTransaction(async (tx): Promise<CatalogCreateResult> => {
    const isbnRef = request.edition.isbn13 === null ? null :
      db.collection("isbnIndex").doc(request.edition.isbn13);
    const externalRefs = Object.entries(request.edition.externalIds).map(([provider, id]) => ({
      provider,
      id,
      ref: db.collection("externalIdIndex").doc(externalIndexId({provider, id})),
    }));
    const [
      workSnapshot,
      isbnSnapshot,
      externalSnapshots,
      editionCount,
      isbnCount,
      externalCount,
    ] = await Promise.all([
      tx.get(db.collection("works").doc(request.workId)),
      isbnRef === null ? Promise.resolve(null) : tx.get(isbnRef),
      Promise.all(externalRefs.map(({ref}) => tx.get(ref))),
      tx.get(db.collection("editions").count()),
      isbnRef === null ? Promise.resolve(null) :
        tx.get(db.collection("isbnIndex").count()),
      externalRefs.length === 0 ? Promise.resolve(null) :
        tx.get(db.collection("externalIdIndex").count()),
    ]);
    const read: SnapshotReader = (ref) => tx.get(ref);
    const indexed = [isbnSnapshot, ...externalSnapshots].find((snapshot) => snapshot?.exists);
    if (indexed !== undefined && indexed !== null) {
      const indexedWorkId = indexed.get("workId");
      const indexedEditionId = indexed.get("editionId");
      if (typeof indexedWorkId !== "string" || typeof indexedEditionId !== "string") {
        throw new CatalogDataError(`Invalid catalog index ${indexed.ref.path}.`);
      }
      const indexedWork = await resolveWork(
        read,
        await read(db.collection("works").doc(indexedWorkId)),
      );
      const surviving = await resolveEdition(
        read,
        await read(db.collection("editions").doc(indexedEditionId)),
      );
      return {workId: indexedWork.id, editionId: surviving.id, created: false};
    }
    if (!workSnapshot.exists) {
      throw new functions.https.HttpsError("not-found", "Book not found.");
    }
    const resolved = await resolveWork(read, workSnapshot);
    if (resolved.work.status !== "active") {
      throw new functions.https.HttpsError("not-found", "Book not found.");
    }
    if (editionCount.data().count >= CATALOG_LIMITS.editions ||
        (isbnCount !== null && isbnCount.data().count >= CATALOG_LIMITS.isbnIndexes) ||
        (externalCount !== null && externalCount.data().count + externalRefs.length >
          CATALOG_LIMITS.externalIdIndexes)) {
      throw new functions.https.HttpsError(
        "resource-exhausted",
        "The shared catalog has reached its size bound. Ask an administrator to raise it.",
      );
    }
    tx.create(db.collection("editions").doc(editionId), {
      workId: resolved.id,
      ...request.edition,
      createdBy,
      createdAt: now,
      updatedAt: now,
    });
    if (isbnRef !== null) tx.create(isbnRef, {workId: resolved.id, editionId});
    for (const external of externalRefs) {
      tx.create(external.ref, {
        workId: resolved.id,
        editionId,
        provider: external.provider,
        externalId: external.id,
      });
    }
    return {workId: resolved.id, editionId, created: true};
  });
}

function dayParts(at: Timestamp, timeZone: string): {key: string; epochDay: number} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at.toDate());
  const value = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type)?.value;
    if (part === undefined) throw new Error(`Missing ${type} for ${timeZone}.`);
    return Number(part);
  };
  let year = value("year");
  let month = value("month");
  let day = value("day");
  const utcDate = (dateYear: number, dateMonth: number, dateDay: number): Date => {
    const result = new Date(0);
    result.setUTCHours(0, 0, 0, 0);
    result.setUTCFullYear(dateYear, dateMonth, dateDay);
    return result;
  };
  if (value("hour") < 3) {
    const previous = utcDate(year, month - 1, day - 1);
    year = previous.getUTCFullYear();
    month = previous.getUTCMonth() + 1;
    day = previous.getUTCDate();
  }
  return {
    key: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    epochDay: Math.floor(utcDate(year, month - 1, day).getTime() /
      (24 * 60 * 60 * 1000)),
  };
}

function readingEvents(snapshot: QuerySnapshot, uid: string, bookPath: string): ReadingEvent[] {
  return snapshot.docs.map((event) => {
    const type = event.get("type");
    const createdAt = event.get("createdAt");
    const pagesRead = event.get("pagesRead");
    const owner = event.get("owner");
    const book = event.get("book");
    if ((type !== "reading" && type !== "update") ||
        !(createdAt instanceof Timestamp) || typeof pagesRead !== "number" ||
        !Number.isFinite(pagesRead) || owner?.path !== `users/${uid}` ||
        book?.path !== bookPath) {
      throw new CatalogDataError(`Invalid reading event ${event.ref.path}.`);
    }
    const timeRead = type === "reading" ? event.get("timeRead") : 0;
    if (typeof timeRead !== "number" || !Number.isFinite(timeRead) || timeRead < 0) {
      throw new CatalogDataError(`Invalid reading duration ${event.ref.path}.`);
    }
    return {type, createdAt, pagesRead, timeRead};
  });
}

export function summarizeReadingAttempt(
  book: {
    finished: boolean;
    finishedAt: Timestamp | null;
    pageCount: number;
  },
  events: readonly ReadingEvent[],
  timeZone: string,
): ReadingAttemptMetrics {
  if (!validTimeZone(timeZone)) {
    throw new CatalogDataError(`Unsupported time zone ${timeZone}.`);
  }
  const ordered = [...events].sort((left, right) =>
    left.createdAt.toMillis() - right.createdAt.toMillis(),
  );
  const reading = ordered.filter((event) => event.type === "reading");
  // Progress means forward progress: a page-count correction is an update
  // event with zero or negative pagesRead, and a book added already
  // finished may carry only such corrections. Taking the raw first row as
  // "first progress" would put a later correction after finishedAt and make
  // calendarDays negative, which the client decoder rejects.
  const progressed = ordered.filter((event) => event.pagesRead > 0);
  const firstProgress = progressed[0]?.createdAt ?? null;
  const firstRead = reading[0]?.createdAt ?? null;
  // The book's own finishedAt stamp is the finish date: the client writes
  // it in the batch that flips finished and migrate-finished-at.ts
  // backfilled every older book, so a finished book without one is
  // malformed (db-audit book.finished-without-finishedAt), never inferred
  // from its history.
  if (book.finished && book.finishedAt === null) {
    throw new CatalogDataError("A finished book carries no finishedAt.");
  }
  const finishedAt = book.finished ? book.finishedAt : null;
  const activeDayKeys = new Set(reading.map((event) => dayParts(event.createdAt, timeZone).key));
  let trackedMinutes = 0;
  let qualifiedMinutes = 0;
  let qualifiedPages = 0;
  for (const event of reading) {
    trackedMinutes += event.timeRead;
    const sessionPagesPerHour = event.pagesRead / (event.timeRead / 60);
    if (event.timeRead >= SPEED_MIN_SESSION_MINUTES && event.pagesRead >= 0 &&
        sessionPagesPerHour <= SPEED_MAX_PAGES_PER_HOUR) {
      qualifiedMinutes += event.timeRead;
      qualifiedPages += event.pagesRead;
    }
  }
  const speedAvailable = qualifiedMinutes >= BOOK_SPEED_MIN_MINUTES;
  const pagesPerHour = speedAvailable ?
    qualifiedPages / (qualifiedMinutes / 60) : null;
  const validPageCount = Number.isSafeInteger(book.pageCount) && book.pageCount > 0;
  let calendarDays: number | null = null;
  if (firstProgress !== null && finishedAt !== null) {
    calendarDays = dayParts(finishedAt, timeZone).epochDay -
      dayParts(firstProgress, timeZone).epochDay + 1;
  }
  return {
    status: book.finished ? "finished" : "reading",
    pageCount: book.pageCount,
    firstProgressAt: firstProgress === null ? null : dayParts(firstProgress, timeZone).key,
    firstReadAt: firstRead === null ? null : dayParts(firstRead, timeZone).key,
    finishedAt: finishedAt === null ? null : dayParts(finishedAt, timeZone).key,
    calendarDays,
    activeDays: activeDayKeys.size,
    trackedMinutes,
    sessionCount: reading.length,
    qualifiedPagesPerHour: pagesPerHour,
    percentPerHour: speedAvailable && validPageCount ?
      (qualifiedPages / book.pageCount) / (qualifiedMinutes / 60) * 100 : null,
    trackingCoverage: validPageCount ? qualifiedPages / book.pageCount : null,
  };
}

function personalBookIdentity(snapshot: DocumentSnapshot): {
  uid: string;
  finished: boolean;
  finishedAt: Timestamp | null;
  pageCount: number;
} {
  const segments = snapshot.ref.path.split("/");
  if (segments.length !== 4 || segments[0] !== "users" || segments[2] !== "books") {
    throw new CatalogDataError(`Unexpected personal book path ${snapshot.ref.path}.`);
  }
  const owner = snapshot.get("owner");
  if (!(owner instanceof DocumentReference) || owner.path !== `users/${segments[1]}`) {
    throw new CatalogDataError(`Invalid personal book owner ${snapshot.ref.path}.`);
  }
  const finished = snapshot.get("finished");
  const finishedAt = snapshot.get("finishedAt");
  const pageCount = snapshot.get("pageCount");
  // A finished book without a stamp is refused by summarizeReadingAttempt,
  // which the unit tests pin; this only types the field.
  if (typeof finished !== "boolean" || !Number.isSafeInteger(pageCount) || pageCount <= 0 ||
      (finishedAt !== null && finishedAt !== undefined && !(finishedAt instanceof Timestamp))) {
    throw new CatalogDataError(`Invalid personal book summary fields ${snapshot.ref.path}.`);
  }
  return {
    uid: segments[1],
    finished,
    finishedAt: finishedAt ?? null,
    pageCount,
  };
}

function safePersonalBookIdentity(
  snapshot: DocumentSnapshot,
  workId: string,
): ReturnType<typeof personalBookIdentity> | null {
  try {
    return personalBookIdentity(snapshot);
  } catch (error) {
    // Only a malformed stored document is omitted; a programming error
    // still fails the call rather than hiding as "incomplete".
    if (!(error instanceof CatalogDataError)) throw error;
    logger.warn("catalog.work_readers.attempt_skipped", {
      workId,
      reason: "invalid-book",
      detail: error.message,
    });
    return null;
  }
}

interface ReaderBook {
  snapshot: DocumentSnapshot;
  identity: ReturnType<typeof personalBookIdentity>;
  shared: {
    readerKey: string;
    username: string | null;
    displayName: string | null;
    timeZone: string;
  };
}

export async function summarizeReaderBooks(
  books: ReaderBook[],
  workId: string,
  initialIncomplete = false,
  initialOmittedAttempts = 0,
): Promise<{
  attempts: WorkReaderAttemptSummary[];
  incomplete: boolean;
  omittedAttempts: number;
}> {
  const rows: WorkReaderAttemptSummary[] = [];
  let incomplete = initialIncomplete;
  let omittedAttempts = initialOmittedAttempts;
  // The caller's page is already bounded by SHARED_OWNER_LIMIT owners ×
  // BOOKS_PER_UID_LIMIT books, and each history is capped at
  // UPDATES_PER_BOOK_LIMIT rows, so the read budget is fixed and the
  // queries can run concurrently; a book over its own cap is omitted on its
  // own without crowding out the next owner.
  const histories = await Promise.all(books.map(({snapshot}) =>
    snapshot.ref.collection("updates").limit(UPDATES_PER_BOOK_LIMIT + 1).get(),
  ));
  for (const [index, updates] of histories.entries()) {
    const {snapshot, identity, shared} = books[index];
    if (updates.size > UPDATES_PER_BOOK_LIMIT) {
      logger.warn("catalog.work_readers.attempt_skipped", {
        workId,
        reason: "update-limit",
      });
      omittedAttempts += 1;
      incomplete = true;
      continue;
    }
    try {
      rows.push({
        readerKey: shared.readerKey,
        username: shared.username,
        displayName: shared.displayName,
        ...summarizeReadingAttempt(
          identity,
          readingEvents(updates, identity.uid, snapshot.ref.path),
          shared.timeZone,
        ),
      });
    } catch (error) {
      if (!(error instanceof CatalogDataError)) throw error;
      logger.warn("catalog.work_readers.attempt_skipped", {
        workId,
        reason: "invalid-updates",
        detail: error.message,
      });
      omittedAttempts += 1;
      incomplete = true;
    }
  }
  // Named readers first, alphabetically; anonymous readers after them in
  // their opaque-key order.
  return {
    attempts: rows.sort((left, right) =>
      (left.username === null ? 1 : 0) - (right.username === null ? 1 : 0) ||
      left.readerKey.localeCompare(right.readerKey),
    ),
    incomplete,
    omittedAttempts,
  };
}

async function publicWorkOrNotFound(workId: string): Promise<ResolvedWork> {
  let resolved: ResolvedWork;
  try {
    resolved = await resolveWork(
      readSnapshot,
      await db.collection("works").doc(workId).get(),
    );
  } catch (error) {
    if (!(error instanceof CatalogDataError)) throw error;
    logger.warn("catalog.work_readers.invalid_work", {
      workId,
      reason: error.message,
    });
    throw new functions.https.HttpsError("not-found", "Book not found.");
  }
  if (resolved.work.status !== "active") {
    throw new functions.https.HttpsError("not-found", "Book not found.");
  }
  return resolved;
}

async function workReaders(resolved: ResolvedWork, cursor: string | null): Promise<{
  response: {
    work: WorkSummary;
    editions: EditionSummary[];
    attempts: WorkReaderAttemptSummary[];
    incomplete: boolean;
    omittedAttempts: number;
    nextCursor: string | null;
  };
  personalBooks: number;
  aliasesQueried: boolean;
}> {
  const aliases = [...new Set(resolved.work.mergedFrom)];
  if (aliases.length > 29 || aliases.includes(resolved.id)) {
    throw new CatalogDataError(`Invalid merged aliases on works/${resolved.id}.`);
  }
  const linkedIds = [resolved.id, ...aliases];
  let ownersQuery = db.collection("sharedWorkOwners")
    .where("workId", "in", linkedIds)
    .orderBy(FieldPath.documentId());
  if (cursor !== null) ownersQuery = ownersQuery.startAfter(cursor);
  const [ownersSnapshot, editionSnapshot] = await Promise.all([
    ownersQuery.limit(SHARED_OWNER_LIMIT + 1).get(),
    db.collection("editions").where("workId", "==", resolved.id).limit(EDITION_LIMIT + 1).get(),
  ]);
  if (editionSnapshot.size > EDITION_LIMIT) {
    throw new functions.https.HttpsError(
      "resource-exhausted",
      "This work is too large to summarize safely.",
    );
  }
  const ownerPage = ownersSnapshot.docs.slice(0, SHARED_OWNER_LIMIT);
  const nextCursor = ownersSnapshot.size > SHARED_OWNER_LIMIT
    ? ownerPage.at(-1)?.id ?? null
    : null;
  let incomplete = false;
  let omittedAttempts = 0;
  const owners = new Set<string>();
  for (const owner of ownerPage) {
    const uid = owner.get("uid");
    const projectedWorkId = owner.get("workId");
    if (typeof uid !== "string" || typeof projectedWorkId !== "string" ||
        uid === "" || projectedWorkId === "" ||
        uid.includes("/") || projectedWorkId.includes("/") ||
        Buffer.byteLength(uid, "utf8") > 1500 ||
        Buffer.byteLength(projectedWorkId, "utf8") > 1500 ||
        !linkedIds.includes(projectedWorkId) ||
        owner.id !== sharedWorkOwnerId(projectedWorkId, uid)) {
      logger.warn("catalog.work_readers.invalid_projection", {workId: resolved.id});
      incomplete = true;
      continue;
    }
    owners.add(uid);
  }
  // Consent is re-checked live (the projection is a candidate index, never
  // the authority); identity is the public profile the account owns, if
  // any, and otherwise anonymous.
  const consentPairs = await Promise.all(
    [...owners].map(async (uid) => {
      const [user, setting, owner] = await Promise.all([
        db.collection("users").doc(uid).get(),
        db.doc(`users/${uid}/settings/bookSharing`).get(),
        db.collection("profileOwners").doc(uid).get(),
      ]);
      const consented = sharingConsent(user, setting);
      if (consented === null) return null;
      const username = owner.get("username");
      const identity = typeof username === "string" ?
        readerIdentity(await db.collection("profiles").doc(username).get(), uid, username) :
        null;
      return {
        uid,
        readerKey: identity?.username ?? `reader-${sharedWorkOwnerId(resolved.id, uid).slice(0, 16)}`,
        username: identity?.username ?? null,
        displayName: identity?.displayName ?? null,
        timeZone: consented.timeZone,
      };
    }),
  );
  const consent = consentPairs.filter((entry) => entry !== null);
  const bookGroups = await Promise.all(consent.map(async (shared) => {
    const snapshot = await db.collection(`users/${shared.uid}/books`)
      .where("workId", "in", linkedIds)
      .orderBy(FieldPath.documentId())
      .limit(BOOKS_PER_UID_LIMIT + 1)
      .get();
    if (snapshot.size > BOOKS_PER_UID_LIMIT) {
      logger.warn("catalog.work_readers.rereads_truncated", {
        workId: resolved.id,
        limit: BOOKS_PER_UID_LIMIT,
      });
      omittedAttempts += snapshot.size - BOOKS_PER_UID_LIMIT;
      incomplete = true;
    }
    return snapshot.docs.slice(0, BOOKS_PER_UID_LIMIT).flatMap((book) => {
      const identity = safePersonalBookIdentity(book, resolved.id);
      if (identity === null) {
        omittedAttempts += 1;
        incomplete = true;
        return [];
      }
      return [{snapshot: book, identity, shared}];
    });
  }));
  const books = bookGroups.flat();
  const summarized = await summarizeReaderBooks(
    books,
    resolved.id,
    incomplete,
    omittedAttempts,
  );
  // Merged aliases are not editions a reader can stand on.
  const editions = editionSnapshot.docs
    .map((snapshot) => ({id: snapshot.id, edition: storedEdition(snapshot)}))
    .filter(({edition}) => edition.status !== "merged")
    .map(({id, edition}) => editionSummary(id, edition, resolved.id));
  return {
    response: {
      work: await workSummary(resolved),
      editions,
      attempts: summarized.attempts,
      incomplete: summarized.incomplete,
      omittedAttempts: summarized.omittedAttempts,
      nextCursor,
    },
    personalBooks: books.length,
    aliasesQueried: aliases.length > 0,
  };
}

// SEC-068: unattested calls are refused by the SDK before any handler bills
// a read; tests/appcheck-client.test.ts pins the option on every chain.
const callable = functions
  .region("europe-west1")
  .runWith({
    serviceAccount: FUNCTIONS_RUNTIME_SERVICE_ACCOUNT,
    maxInstances: CALLABLE_MAX_INSTANCES,
    enforceAppCheck: true,
  });

exports.search = callable.https.onCall(async (
  data: unknown,
  context,
): Promise<{results: CatalogSearchResult[]}> => {
  logAppCheckPresence("catalog.search", context);
  const uid = requireVerifiedUid(context);
  const request: CatalogSearchRequest = decodeCatalogSearchRequest(data, invalidArgument);
  await requireLiveUser(uid);
  if (request.isbn13 !== undefined) {
    const exact = await exactIsbnResult(request.isbn13);
    if (exact !== null) return {results: [exact]};
  }
  if (request.externalId !== undefined) {
    const exact = await exactExternalIdResult(request.externalId);
    if (exact !== null) return {results: [exact]};
  }
  if (request.title === undefined) return {results: []};
  if (request.authorNames === undefined) {
    throw new Error("A decoded title search must carry its author names.");
  }
  return {results: await titleResults(request.title, request.authorNames)};
});

exports.create = callable.https.onCall(async (
  data: unknown,
  context,
): Promise<CatalogCreateResult> => {
  logAppCheckPresence("catalog.create", context);
  const uid = requireVerifiedUid(context);
  const request = decodeCatalogCreateRequest(data, invalidArgument);
  await requireLiveUser(uid);
  return createCatalogEntry(request, uid);
});

exports.addedition = callable.https.onCall(async (
  data: unknown,
  context,
): Promise<CatalogCreateResult> => {
  logAppCheckPresence("catalog.addedition", context);
  const uid = requireVerifiedUid(context);
  const request = decodeCatalogAddEditionRequest(data, invalidArgument);
  await requireLiveUser(uid);
  return addCatalogEdition(request, uid);
});

exports.ensureauthors = callable.https.onCall(async (
  data: unknown,
  context,
): Promise<{authorIds: string[]}> => {
  logAppCheckPresence("catalog.ensureauthors", context);
  const uid = requireVerifiedUid(context);
  const request = decodeEnsureCatalogAuthorsRequest(data, invalidArgument);
  await requireLiveUser(uid);

  const byKey = new Map<string, CatalogAuthorCreateInput>();
  const requestedKeys = request.authors.map((author) => {
    const key = normalizeCatalogIdentity(author.canonicalName);
    const prior = byKey.get(key);
    if (prior !== undefined && prior.kind !== author.kind) {
      invalidArgument(`Conflicting author kinds were supplied for ${author.canonicalName}.`);
    }
    if (prior === undefined) byKey.set(key, author);
    return key;
  });
  // No per-call or global quota here (owner decision 2026-08-31): a call is
  // bounded by its own request, and the catalog cap below bounds the total.
  const keys = [...byKey.keys()];
  const authorIds = await db.runTransaction(async (tx) => {
    const matching = await tx.get(
      db.collection("catalogAuthors").where("nameKeys", "array-contains-any", keys),
    );
    const candidates = new Map<string, Array<{id: string; author: StoredCatalogAuthor}>>();
    for (const snapshot of matching.docs) {
      const author = storedCatalogAuthor(snapshot);
      for (const key of author.nameKeys) {
        if (!byKey.has(key)) continue;
        const rows = candidates.get(key) ?? [];
        rows.push({id: snapshot.id, author});
        candidates.set(key, rows);
      }
    }

    const mergedTargetIds = new Set<string>();
    for (const rows of candidates.values()) {
      for (const row of rows) {
        if (row.author.status === "merged" && row.author.mergedInto !== undefined) {
          mergedTargetIds.add(row.author.mergedInto);
        }
      }
    }
    const targetRefs = [...mergedTargetIds].map((id) => db.collection("catalogAuthors").doc(id));
    const targetSnapshots = targetRefs.length === 0 ? [] : await tx.getAll(...targetRefs);
    const targets = new Map(targetSnapshots.map((snapshot) => [
      snapshot.id,
      storedCatalogAuthor(snapshot),
    ]));

    const resolved = new Map<string, string>();
    for (const [key, rows] of candidates) {
      const activeIds = new Set<string>();
      const activeAuthors = new Map<string, StoredCatalogAuthor>();
      for (const row of rows) {
        if (row.author.status === "active") {
          activeIds.add(row.id);
          activeAuthors.set(row.id, row.author);
          continue;
        }
        if (row.author.mergedInto === undefined) {
          throw new CatalogDataError(`Broken catalog author redirect at catalogAuthors/${row.id}.`);
        }
        const target = targets.get(row.author.mergedInto);
        if (target === undefined || target.status !== "active") {
          throw new CatalogDataError(`Catalog author redirect is not one hop at catalogAuthors/${row.id}.`);
        }
        activeIds.add(row.author.mergedInto);
        activeAuthors.set(row.author.mergedInto, target);
      }
      if (activeIds.size > 1) {
        throw new functions.https.HttpsError(
          "failed-precondition",
          "This author name is ambiguous in the shared catalog. An administrator must merge it first.",
        );
      }
      const activeId = [...activeIds][0];
      if (activeId !== undefined) {
        const requested = byKey.get(key);
        const active = activeAuthors.get(activeId);
        if (requested === undefined || active === undefined) {
          throw new Error(`Author ${key} was not resolved consistently.`);
        }
        if (active.kind !== requested.kind) {
          throw new functions.https.HttpsError(
            "failed-precondition",
            "This author name has a different type in the shared catalog. An administrator must review it first.",
          );
        }
        resolved.set(key, activeId);
      }
    }

    const missing = [...byKey].filter(([key]) => !resolved.has(key));
    const deterministicRefs = missing.map(([key]) =>
      db.collection("catalogAuthors").doc(catalogAuthorId(key)),
    );
    if (missing.length > 0) {
      // A count() aggregation costs one read and does not drag the whole
      // collection into the transaction's read set, where any concurrent
      // author write would force a retry that re-reads it.
      const [catalogCount, deterministicSnapshots] = await Promise.all([
        tx.get(db.collection("catalogAuthors").count()),
        tx.getAll(...deterministicRefs),
      ]);
      if (catalogCount.data().count + missing.length > MAX_CATALOG_AUTHORS) {
        throw new functions.https.HttpsError(
          "resource-exhausted",
          "The shared author catalog is full. Ask an administrator to review its capacity.",
        );
      }
      for (const [index, snapshot] of deterministicSnapshots.entries()) {
        if (snapshot.exists) {
          deterministicRefs[index] = db.collection("catalogAuthors").doc();
        }
      }
    }

    const now = Timestamp.now();
    for (const [index, [key, author]] of missing.entries()) {
      const authorRef = deterministicRefs[index];
      tx.create(authorRef, {
        canonicalName: author.canonicalName,
        alternateNames: [],
        nameKeys: [key],
        sortName: author.sortName,
        kind: author.kind,
        status: "active",
        mergedFrom: [],
        createdBy: uid,
        createdAt: now,
        updatedAt: now,
      });
      resolved.set(key, authorRef.id);
    }
    return requestedKeys.map((key) => {
      const authorId = resolved.get(key);
      if (authorId === undefined) throw new Error(`Author ${key} was not resolved.`);
      return authorId;
    });
  });
  return {authorIds};
});

exports.workreaders = callable.https.onCall(async (
  data: unknown,
  context,
): Promise<{
  work: WorkSummary;
  editions: EditionSummary[];
  attempts: WorkReaderAttemptSummary[];
  incomplete: boolean;
  omittedAttempts: number;
  nextCursor: string | null;
}> => {
  logAppCheckPresence("catalog.workreaders", context);
  const startedAt = Date.now();
  const uid = requireVerifiedUid(context);
  const request = decodeWorkReadersRequest(data, invalidArgument);
  await requireLiveUser(uid);
  await requireQuota(uid, "workReaders", READER_CALLS_PER_WINDOW);
  const resolved = await publicWorkOrNotFound(request.workId);
  const result = await workReaders(resolved, request.cursor);
  const readerCount = new Set(
    result.response.attempts.map((attempt) => attempt.readerKey),
  ).size;
  logger.info("catalog.work_readers", {
    workId: result.response.work.workId,
    personalBooks: result.personalBooks,
    optedInRows: result.response.attempts.length,
    readers: readerCount,
    durationMs: Date.now() - startedAt,
    aliasesQueried: result.aliasesQueried,
  });
  return result.response;
});
