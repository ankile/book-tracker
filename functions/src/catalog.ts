import * as functions from "firebase-functions/v1";
import {logger} from "firebase-functions";
import {
  DocumentReference,
  DocumentSnapshot,
  FieldPath,
  getFirestore,
  QuerySnapshot,
  Timestamp,
} from "firebase-admin/firestore";
import {createHash} from "node:crypto";
import {Buffer} from "node:buffer";
import {
  CatalogAuthorCreateInput,
  CatalogExternalId,
  CatalogSearchRequest,
  decodeCatalogSearchRequest,
  decodeEnsureCatalogAuthorsRequest,
  decodeWorkReadersRequest,
  normalizeCatalogIdentity,
} from "./decoders";
import {consumeQuota} from "./quota";
import {sharedWorkOwnerId} from "./catalogProjection";
import {profileConsents, sharingSetting, validTimeZone} from "./sharingConsent";
import {CALLABLE_MAX_INSTANCES, FUNCTIONS_RUNTIME_SERVICE_ACCOUNT} from "./runtime";
import {logAppCheckPresence} from "./appCheck";

const db = getFirestore();

const SEARCH_LIMIT = 10;
const TITLE_CANDIDATE_LIMIT = 25;
const BOOKS_PER_UID_LIMIT = 5;
const SHARED_ATTEMPT_LIMIT = 50;
const SHARED_OWNER_LIMIT = 10;
const EDITION_LIMIT = 100;
const UPDATES_PER_BOOK_LIMIT = 200;
const SEARCHES_PER_WINDOW = 60;
const READER_CALLS_PER_WINDOW = 5;
// Emergency spend breaker, not abuse isolation: the per-account quota is
// the primary caller bound, while this high ceiling limits a sybil burst.
const GLOBAL_READER_CALLS_PER_WINDOW = 100;
const GLOBAL_SEARCHES_PER_WINDOW = 100;
const MAX_CATALOG_AUTHORS = 500;
const QUOTA_WINDOW_MS = 60 * 60 * 1000;
const SPEED_MIN_SESSION_MINUTES = 5;
const SPEED_MAX_PAGES_PER_HOUR = 150;
const BOOK_SPEED_MIN_MINUTES = 60;

type WorkVisibility = "internal" | "searchable";
type WorkStatus = "active" | "merged";

interface StoredWork {
  canonicalTitle: string;
  alternateTitles: string[];
  titleKeys: string[];
  authorIds: string[];
  coverUrl: string;
  subjects: string[];
  fiction: boolean | null;
  visibility: WorkVisibility;
  status: WorkStatus;
  mergedInto?: string;
  mergedFrom: string[];
}

interface StoredCatalogAuthor {
  canonicalName: string;
  alternateNames: string[];
  nameKeys: string[];
  sortName: string;
  kind: "person" | "entity" | "placeholder";
  status: "active" | "merged";
  mergedInto?: string;
  mergedFrom: string[];
}

interface StoredEdition {
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

interface WorkReaderAttemptSummary extends ReadingAttemptMetrics {
  username: string;
  displayName: string;
  editionIsbn13: string | null;
}

class CatalogDataError extends Error {}

const invalidArgument = (message: string): never => {
  throw new functions.https.HttpsError("invalid-argument", message);
};

function signedInUid(context: functions.https.CallableContext): string {
  if (context.auth === undefined) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Sign in to use the shared book catalog.",
    );
  }
  if (context.auth.token.email_verified !== true) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Verify your email before using the shared book catalog.",
    );
  }
  return context.auth.uid;
}

function catalogAuthorId(nameKey: string): string {
  return `author_${createHash("sha256")
    .update(`author\0${nameKey}`)
    .digest("hex")
    .slice(0, 24)}`;
}

async function requireLiveUser(uid: string): Promise<void> {
  const user = await db.collection("users").doc(uid).get();
  if (!user.exists || user.get("deletedAt") !== undefined) {
    throw new functions.https.HttpsError("failed-precondition", "This account is not active.");
  }
}

async function requireQuota(
  uid: string,
  name: string,
  limit: number,
  amount = 1,
): Promise<void> {
  const decision = await consumeQuota(
    db,
    `users/${uid}/functionQuotas/${name}`,
    limit,
    QUOTA_WINDOW_MS,
    amount,
  );
  if (!decision.granted) {
    throw new functions.https.HttpsError(
      "resource-exhausted",
      "Catalog request limit reached. Try again later.",
    );
  }
}

async function requireGlobalReaderQuota(): Promise<void> {
  const decision = await consumeQuota(
    db,
    "functionGlobalQuotas/catalogWorkReaders",
    GLOBAL_READER_CALLS_PER_WINDOW,
    QUOTA_WINDOW_MS,
  );
  if (!decision.granted) {
    throw new functions.https.HttpsError(
      "resource-exhausted",
      "Reader summaries are temporarily busy. Try again later.",
    );
  }
}

async function requireGlobalSearchQuota(): Promise<void> {
  const decision = await consumeQuota(
    db,
    "functionGlobalQuotas/catalogSearch",
    GLOBAL_SEARCHES_PER_WINDOW,
    QUOTA_WINDOW_MS,
  );
  if (!decision.granted) {
    throw new functions.https.HttpsError(
      "resource-exhausted",
      "Catalog search is temporarily busy. Try again later.",
    );
  }
}

const SUPPORTED_LEADING_TITLE_ARTICLES = ["a", "an", "the"] as const;

// One normalizer for every catalog identity: the decoders' copy writes
// nameKeys on ensureauthors and the admin scan recomputes them, so a fold
// added to one table but not another would report every stored author as
// corrupt and make lookups miss existing authors.
export const normalizeCatalogText = normalizeCatalogIdentity;

function moveTrailingEnglishArticle(title: string): string {
  const match = /^(.*\S)\s*,\s*(a|an|the)\s*$/iu.exec(title);
  return match === null ? title : `${match[2]} ${match[1]}`;
}

export function normalizeCatalogTitle(value: string): string {
  const normalized = normalizeCatalogText(moveTrailingEnglishArticle(value));
  const words = normalized.split(" ");
  const first = words[0] as typeof SUPPORTED_LEADING_TITLE_ARTICLES[number];
  if (words.length > 1 && SUPPORTED_LEADING_TITLE_ARTICLES.includes(first)) {
    return words.slice(1).join(" ");
  }
  return normalized;
}

function storedWork(snapshot: DocumentSnapshot): StoredWork {
  if (!snapshot.exists) {
    throw new CatalogDataError(`Missing catalog work ${snapshot.ref.path}.`);
  }
  const data = snapshot.data();
  if (data === undefined) {
    throw new CatalogDataError(`Missing catalog work data ${snapshot.ref.path}.`);
  }
  if (data.status !== "active" && data.status !== "merged") {
    throw new CatalogDataError(`Invalid work status at ${snapshot.ref.path}.`);
  }
  if (data.visibility !== "internal" && data.visibility !== "searchable") {
    throw new CatalogDataError(`Invalid work visibility at ${snapshot.ref.path}.`);
  }
  const arrays = [
    data.alternateTitles,
    data.titleKeys,
    data.authorIds,
    data.subjects,
    data.mergedFrom ?? [],
  ];
  if (arrays.some((value) =>
    !Array.isArray(value) || value.some((entry) => typeof entry !== "string"))) {
    throw new CatalogDataError(`Invalid work arrays at ${snapshot.ref.path}.`);
  }
  if (typeof data.canonicalTitle !== "string" || typeof data.coverUrl !== "string" ||
      (data.fiction !== null && typeof data.fiction !== "boolean")) {
    throw new CatalogDataError(`Invalid catalog work ${snapshot.ref.path}.`);
  }
  if (data.mergedInto !== undefined && typeof data.mergedInto !== "string") {
    throw new CatalogDataError(`Invalid work redirect at ${snapshot.ref.path}.`);
  }
  return {
    canonicalTitle: data.canonicalTitle,
    alternateTitles: data.alternateTitles,
    titleKeys: data.titleKeys,
    authorIds: data.authorIds,
    coverUrl: data.coverUrl,
    subjects: data.subjects,
    fiction: data.fiction,
    visibility: data.visibility,
    status: data.status,
    ...(data.mergedInto === undefined ? {} : {mergedInto: data.mergedInto}),
    mergedFrom: data.mergedFrom ?? [],
  };
}

function storedEdition(snapshot: DocumentSnapshot): StoredEdition {
  if (!snapshot.exists) throw new Error(`Missing catalog edition ${snapshot.ref.path}.`);
  const data = snapshot.data();
  if (data === undefined) throw new Error(`Missing edition data ${snapshot.ref.path}.`);
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
        !/^[a-z0-9-]{1,40}$/.test(provider) || typeof id !== "string")) {
    throw new Error(`Invalid catalog edition ${snapshot.ref.path}.`);
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
  };
}

function storedCatalogAuthor(snapshot: DocumentSnapshot): StoredCatalogAuthor {
  if (!snapshot.exists) {
    throw new CatalogDataError(`Missing catalog author ${snapshot.ref.path}.`);
  }
  const data = snapshot.data();
  if (data === undefined || typeof data.canonicalName !== "string" ||
      typeof data.sortName !== "string" ||
      !["person", "entity", "placeholder"].includes(data.kind) ||
      (data.status !== "active" && data.status !== "merged")) {
    throw new CatalogDataError(`Invalid catalog author ${snapshot.ref.path}.`);
  }
  const arrays = [data.alternateNames, data.nameKeys, data.mergedFrom ?? []];
  if (arrays.some((value) => !Array.isArray(value) ||
      value.some((entry) => typeof entry !== "string"))) {
    throw new CatalogDataError(`Invalid catalog author arrays at ${snapshot.ref.path}.`);
  }
  if (data.mergedInto !== undefined && typeof data.mergedInto !== "string") {
    throw new CatalogDataError(`Invalid catalog author redirect at ${snapshot.ref.path}.`);
  }
  return {
    canonicalName: data.canonicalName,
    alternateNames: data.alternateNames,
    nameKeys: data.nameKeys,
    sortName: data.sortName,
    kind: data.kind,
    status: data.status,
    ...(data.mergedInto === undefined ? {} : {mergedInto: data.mergedInto}),
    mergedFrom: data.mergedFrom ?? [],
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

async function resolveCatalogAuthor(authorId: string): Promise<ResolvedAuthor> {
  const snapshot = await db.collection("catalogAuthors").doc(authorId).get();
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
  const targetSnapshot = await db.collection("catalogAuthors").doc(author.mergedInto).get();
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
    const pending = resolveCatalogAuthor(authorId);
    cache.set(authorId, pending);
    return pending;
  }));
  const byId = new Map(resolved.map((author) => [author.authorId, author]));
  return [...byId.values()];
}

export function externalIndexId(externalId: CatalogExternalId): string {
  return createHash("sha256")
    .update(`${externalId.provider}\0${externalId.id}`)
    .digest("hex");
}

async function resolveWorkSnapshot(
  snapshot: DocumentSnapshot,
): Promise<ResolvedWork> {
  const work = storedWork(snapshot);
  if (work.status === "active") return {id: snapshot.id, work};
  if (work.mergedInto === undefined || work.mergedInto === snapshot.id) {
    throw new CatalogDataError(`Broken catalog redirect at ${snapshot.ref.path}.`);
  }
  const targetSnapshot = await db.collection("works").doc(work.mergedInto).get();
  const target = storedWork(targetSnapshot);
  if (target.status !== "active") {
    throw new CatalogDataError(
      `Catalog redirect is not one hop at ${snapshot.ref.path}.`,
    );
  }
  return {id: targetSnapshot.id, work: target};
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

async function exactIsbnResult(isbn13: string): Promise<CatalogSearchResult | null> {
  const index = await db.collection("isbnIndex").doc(isbn13).get();
  if (!index.exists) {
    await Promise.all([
      db.collection("works").doc("__catalog-search-miss__").get(),
      db.collection("editions").doc("__catalog-search-miss__").get(),
      db.collection("works").doc("__catalog-search-miss-padding__").get(),
    ]);
    return null;
  }
  const workId = index.get("workId");
  const editionId = index.get("editionId");
  if (typeof workId !== "string" || typeof editionId !== "string") {
    throw new Error(`Invalid ISBN index ${index.ref.path}.`);
  }
  const [workSnapshot, editionSnapshot] = await Promise.all([
    db.collection("works").doc(workId).get(),
    db.collection("editions").doc(editionId).get(),
  ]);
  const resolved = await resolveWorkSnapshot(workSnapshot);
  const edition = storedEdition(editionSnapshot);
  const editionWork = edition.workId === workId ? resolved :
    await resolveWorkSnapshot(await db.collection("works").doc(edition.workId).get());
  if (editionWork.id !== resolved.id || edition.isbn13 !== isbn13) {
    throw new Error(`ISBN index ${index.ref.path} disagrees with its edition.`);
  }
  if (resolved.work.visibility !== "searchable") return null;
  return {
    workId: resolved.id,
    editionId,
    confidence: "exact-edition",
    reason: "Exact ISBN match",
    work: await workSummary(resolved),
    edition: editionSummary(editionId, edition, resolved.id),
  };
}

async function exactExternalIdResult(
  externalId: CatalogExternalId,
): Promise<CatalogSearchResult | null> {
  const index = await db.collection("externalIdIndex")
    .doc(externalIndexId(externalId))
    .get();
  if (!index.exists) {
    await Promise.all([
      db.collection("works").doc("__catalog-search-miss__").get(),
      db.collection("editions").doc("__catalog-search-miss__").get(),
      db.collection("works").doc("__catalog-search-miss-padding__").get(),
    ]);
    return null;
  }
  const workId = index.get("workId");
  const editionId = index.get("editionId");
  if (typeof workId !== "string" || typeof editionId !== "string" ||
      index.get("provider") !== externalId.provider ||
      index.get("externalId") !== externalId.id) {
    throw new Error(`Invalid external ID index ${index.ref.path}.`);
  }
  const [workSnapshot, editionSnapshot] = await Promise.all([
    db.collection("works").doc(workId).get(),
    db.collection("editions").doc(editionId).get(),
  ]);
  const resolved = await resolveWorkSnapshot(workSnapshot);
  const edition = storedEdition(editionSnapshot);
  const editionWork = edition.workId === workId ? resolved :
    await resolveWorkSnapshot(await db.collection("works").doc(edition.workId).get());
  if (editionWork.id !== resolved.id ||
      edition.externalIds[externalId.provider] !== externalId.id) {
    throw new Error(`External ID index ${index.ref.path} disagrees with its edition.`);
  }
  if (resolved.work.visibility !== "searchable") return null;
  return {
    workId: resolved.id,
    editionId,
    confidence: "exact-edition",
    reason: "Exact external ID match",
    work: await workSummary(resolved),
    edition: editionSummary(editionId, edition, resolved.id),
  };
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

function authorAgreement(requested: readonly string[], authors: readonly ResolvedAuthor[]): number {
  if (requested.length === 0) return 0;
  const candidates = new Set(authors.flatMap((author) =>
    [normalizeCatalogText(author.canonicalName), ...author.nameKeys],
  ));
  const normalized = [...new Set(requested.map(normalizeCatalogText))];
  return normalized.filter((name) => candidates.has(name)).length / normalized.length;
}

async function titleResults(
  title: string,
  authors: readonly string[],
): Promise<CatalogSearchResult[]> {
  const key = normalizeCatalogTitle(title);
  if (key === "") return [];
  const indexRows = await db.collection("workTitleIndex")
    .where("visibility", "==", "searchable")
    .where("titleKey", ">=", key)
    .where("titleKey", "<", `${key}\uf8ff`)
    .orderBy("titleKey")
    .limit(TITLE_CANDIDATE_LIMIT)
    .get();
  const candidateIds = [...new Set(indexRows.docs.map((row) => row.get("workId")))]
    .filter((id): id is string => typeof id === "string");
  const resolved = await Promise.all(candidateIds.map(async (id) =>
    resolveWorkSnapshot(await db.collection("works").doc(id).get()),
  ));
  const byId = new Map<string, ResolvedWork>();
  for (const candidate of resolved) {
    if (candidate.work.visibility === "searchable") byId.set(candidate.id, candidate);
  }
  const authorCache = new Map<string, Promise<ResolvedAuthor>>();
  const hydrated = await Promise.all([...byId.values()].map(async (candidate) => ({
    candidate,
    authors: await workAuthors(candidate.work, authorCache),
  })));
  const scored = hydrated.map(({candidate, authors: candidateAuthors}) => {
    const bestTitle = Math.max(...candidate.work.titleKeys.map((candidateKey) =>
      tokenSimilarity(key, candidateKey),
    ));
    const authorsMatch = authorAgreement(authors, candidateAuthors);
    const exactTitle = candidate.work.titleKeys.includes(key);
    return {
      candidate,
      candidateAuthors,
      exactTitle,
      authorsMatch,
      score: bestTitle * 0.75 + authorsMatch * 0.25,
    };
  }).filter(({score, exactTitle, authorsMatch}) =>
    authorsMatch > 0 && (exactTitle || score >= 0.55),
  )
    .sort((left, right) => right.score - left.score)
    .slice(0, SEARCH_LIMIT);

  return Promise.all(scored.map(async ({candidate, candidateAuthors, exactTitle, authorsMatch}) => {
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
    editionId: string | null;
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
  const firstProgress = ordered[0]?.createdAt ?? null;
  const firstRead = reading[0]?.createdAt ?? null;
  // The book's own finishedAt stamp (written when finished flipped,
  // backfilled by migrate-finished-at.ts) is the finish date. The fallback
  // covers a finished book a pre-stamp client wrote: its last forward
  // progress, not its last row — a page-count correction months later is
  // an update event with zero or negative pagesRead.
  const progressed = ordered.filter((event) => event.pagesRead > 0);
  const finishedAt = !book.finished ? null :
    book.finishedAt ?? (progressed.at(-1) ?? ordered.at(-1))?.createdAt ?? null;
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
  editionId: string | null;
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
  const editionId = snapshot.get("editionId");
  if (typeof finished !== "boolean" || !Number.isSafeInteger(pageCount) || pageCount <= 0 ||
      (finishedAt !== null && finishedAt !== undefined && !(finishedAt instanceof Timestamp)) ||
      (editionId !== null && editionId !== undefined && typeof editionId !== "string")) {
    throw new CatalogDataError(`Invalid personal book summary fields ${snapshot.ref.path}.`);
  }
  return {
    uid: segments[1],
    finished,
    finishedAt: finishedAt ?? null,
    pageCount,
    editionId: editionId ?? null,
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
    username: string;
    displayName: string;
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
  // At most SHARED_ATTEMPT_LIMIT histories per call, each capped at
  // UPDATES_PER_BOOK_LIMIT rows, so the read budget is fixed by the two
  // constants and the queries can run concurrently; a book over its cap is
  // omitted on its own without crowding out the next owner.
  const attempted = books.slice(0, SHARED_ATTEMPT_LIMIT);
  if (books.length > attempted.length) {
    omittedAttempts += books.length - attempted.length;
    incomplete = true;
  }
  const histories = await Promise.all(attempted.map(({snapshot}) =>
    snapshot.ref.collection("updates").limit(UPDATES_PER_BOOK_LIMIT + 1).get(),
  ));
  for (const [index, updates] of histories.entries()) {
    const {snapshot, identity, shared} = attempted[index];
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
        username: shared.username,
        displayName: shared.displayName,
        // The shared-catalog privacy decision is work-level disclosure only.
        // Keep the response shape forward-compatible without revealing which
        // edition or ISBN this reader chose.
        editionIsbn13: null,
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
  return {
    attempts: rows.sort((left, right) =>
      left.username.localeCompare(right.username),
    ),
    incomplete,
    omittedAttempts,
  };
}

async function publicWorkOrNotFound(workId: string): Promise<ResolvedWork> {
  let resolved: ResolvedWork;
  try {
    resolved = await resolveWorkSnapshot(
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
  if (resolved.work.visibility !== "searchable") {
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
    throw new Error(`Invalid merged aliases on works/${resolved.id}.`);
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
  const consentPairs = await Promise.all(
    [...owners].map(async (uid) => {
      const [user, setting] = await Promise.all([
        db.collection("users").doc(uid).get(),
        db.doc(`users/${uid}/settings/bookSharing`).get(),
      ]);
      const consented = sharingSetting(user, setting);
      if (consented === null) return null;
      const profile = await db.collection("profiles").doc(consented.username).get();
      if (!profileConsents(profile, uid) ||
          typeof profile.get("givenName") !== "string" ||
          typeof profile.get("familyName") !== "string") return null;
      const displayName = `${profile.get("givenName")} ${profile.get("familyName")}`.trim();
      if (displayName === "") return null;
      return {uid, username: consented.username, displayName, timeZone: consented.timeZone};
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
  const editions = editionSnapshot.docs.map((snapshot) =>
    editionSummary(snapshot.id, storedEdition(snapshot), resolved.id),
  );
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
  const uid = signedInUid(context);
  const request: CatalogSearchRequest = decodeCatalogSearchRequest(data, invalidArgument);
  await requireLiveUser(uid);
  await requireQuota(uid, "catalogSearch", SEARCHES_PER_WINDOW);
  if (request.isbn13 !== undefined) {
    const exact = await exactIsbnResult(request.isbn13);
    if (exact !== null) return {results: [exact]};
  }
  if (request.externalId !== undefined) {
    const exact = await exactExternalIdResult(request.externalId);
    if (exact !== null) return {results: [exact]};
  }
  if (request.title !== undefined) await requireGlobalSearchQuota();
  return {
    results: request.title === undefined ? [] :
      await titleResults(request.title, request.authorNames ?? []),
  };
});

exports.ensureauthors = callable.https.onCall(async (
  data: unknown,
  context,
): Promise<{authorIds: string[]}> => {
  logAppCheckPresence("catalog.ensureauthors", context);
  const uid = signedInUid(context);
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
  const uid = signedInUid(context);
  const request = decodeWorkReadersRequest(data, invalidArgument);
  await requireLiveUser(uid);
  await requireQuota(uid, "workReaders", READER_CALLS_PER_WINDOW);
  const resolved = await publicWorkOrNotFound(request.workId);
  await requireGlobalReaderQuota();
  const result = await workReaders(resolved, request.cursor);
  const readerCount = new Set(
    result.response.attempts.map((attempt) => attempt.username),
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
