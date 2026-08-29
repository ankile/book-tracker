import * as functions from "firebase-functions/v1";
import {logger} from "firebase-functions";
import {
  DocumentReference,
  DocumentSnapshot,
  FieldPath,
  getFirestore,
  QuerySnapshot,
  Timestamp,
  Transaction,
} from "firebase-admin/firestore";
import {createHash, randomUUID} from "node:crypto";
import {Buffer} from "node:buffer";
import {
  CatalogCreateRequest,
  CatalogEditionInput,
  CatalogExternalId,
  CatalogSearchRequest,
  CatalogWorkInput,
  decodeCatalogSearchRequest,
  decodeWorkReadersRequest,
} from "./decoders";
import {consumeQuota} from "./quota";
import {sharedWorkOwnerId} from "./catalogProjection";
import {CALLABLE_MAX_INSTANCES, FUNCTIONS_RUNTIME_SERVICE_ACCOUNT} from "./runtime";

const db = getFirestore();

const SEARCH_LIMIT = 10;
const TITLE_CANDIDATE_LIMIT = 25;
const BOOKS_PER_UID_LIMIT = 5;
const SHARED_ATTEMPT_LIMIT = 50;
const SHARED_OWNER_LIMIT = 10;
const EDITION_LIMIT = 100;
const UPDATES_PER_BOOK_LIMIT = 200;
const TOTAL_UPDATES_LIMIT = 10050;
const SEARCHES_PER_WINDOW = 60;
const READER_CALLS_PER_WINDOW = 5;
// Emergency spend breaker, not abuse isolation: the per-account quota is
// the primary caller bound, while this high ceiling limits a sybil burst.
const GLOBAL_READER_CALLS_PER_WINDOW = 100;
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
  authorNames: string[];
  authorNamesLower: string[];
  coverUrl: string;
  subjects: string[];
  fiction: boolean | null;
  visibility: WorkVisibility;
  status: WorkStatus;
  mergedInto?: string;
  mergedFrom: string[];
}

interface StoredEdition {
  workId: string;
  isbn13: string | null;
  title: string;
  authorNames: string[];
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
  authorNames: string[];
  coverUrl: string;
  mergedFrom: string[];
}

interface EditionSummary {
  editionId: string;
  workId: string;
  isbn13: string | null;
  title: string;
  authorNames: string[];
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

const SUPPORTED_LEADING_TITLE_ARTICLES = ["a", "an", "the"] as const;
const APOSTROPHES = /['\u2018\u2019\u02bc`\u00b4]/gu;
const COMBINING_MARKS = /\p{Mark}+/gu;
const NON_WORD_CHARACTERS = /[^\p{Letter}\p{Number}]+/gu;
const CHARACTER_FOLDS: Readonly<Record<string, string>> = {
  "æ": "ae",
  "ð": "d",
  "đ": "d",
  "ł": "l",
  "ø": "o",
  "œ": "oe",
  "ß": "ss",
  "þ": "th",
};

function foldCharacters(value: string): string {
  return [...value].map((character) =>
    CHARACTER_FOLDS[character] ?? character,
  ).join("");
}

export function normalizeCatalogText(value: string): string {
  return foldCharacters(value.normalize("NFKD").toLowerCase())
    .replace(COMBINING_MARKS, "")
    .replace(APOSTROPHES, "")
    .replace(/&/gu, " and ")
    .replace(NON_WORD_CHARACTERS, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

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

function titleKeys(work: CatalogWorkInput): string[] {
  return [...new Set(
    [work.canonicalTitle, ...work.alternateTitles]
      .map(normalizeCatalogTitle)
      .filter((value) => value !== ""),
  )];
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
    data.authorNames,
    data.authorNamesLower,
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
    authorNames: data.authorNames,
    authorNamesLower: data.authorNamesLower,
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
      typeof data.title !== "string" || !Array.isArray(data.authorNames) ||
      data.authorNames.some((name: unknown) => typeof name !== "string") ||
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
    authorNames: data.authorNames,
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

async function resolveTransactionWork(
  transaction: Transaction,
  snapshot: DocumentSnapshot,
): Promise<ResolvedWork> {
  const work = storedWork(snapshot);
  if (work.status === "active") return {id: snapshot.id, work};
  if (work.mergedInto === undefined || work.mergedInto === snapshot.id) {
    throw new CatalogDataError(`Broken catalog redirect at ${snapshot.ref.path}.`);
  }
  const targetSnapshot = await transaction.get(db.collection("works").doc(work.mergedInto));
  const target = storedWork(targetSnapshot);
  if (target.status !== "active") {
    throw new CatalogDataError(
      `Catalog redirect is not one hop at ${snapshot.ref.path}.`,
    );
  }
  return {id: targetSnapshot.id, work: target};
}

function workSummary(resolved: ResolvedWork): WorkSummary {
  return {
    workId: resolved.id,
    canonicalTitle: resolved.work.canonicalTitle,
    alternateTitles: resolved.work.alternateTitles,
    authorNames: resolved.work.authorNames,
    coverUrl: resolved.work.coverUrl,
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
    authorNames: edition.authorNames,
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
  const [workSnapshot, editionSnapshot, editionWorkSnapshot] = await Promise.all([
    db.collection("works").doc(workId).get(),
    db.collection("editions").doc(editionId).get(),
    db.collection("works").doc(workId).get(),
  ]);
  const resolved = await resolveWorkSnapshot(workSnapshot);
  const edition = storedEdition(editionSnapshot);
  const editionWork = edition.workId === workId ?
    await resolveWorkSnapshot(editionWorkSnapshot) :
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
    work: workSummary(resolved),
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
  const [workSnapshot, editionSnapshot, editionWorkSnapshot] = await Promise.all([
    db.collection("works").doc(workId).get(),
    db.collection("editions").doc(editionId).get(),
    db.collection("works").doc(workId).get(),
  ]);
  const resolved = await resolveWorkSnapshot(workSnapshot);
  const edition = storedEdition(editionSnapshot);
  const editionWork = edition.workId === workId ?
    await resolveWorkSnapshot(editionWorkSnapshot) :
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
    work: workSummary(resolved),
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

function authorAgreement(requested: readonly string[], work: StoredWork): number {
  if (requested.length === 0) return 0;
  const candidates = new Set(work.authorNames.map(normalizeCatalogText));
  const normalized = [...new Set(requested.map(normalizeCatalogText))];
  return normalized.filter((name) => candidates.has(name)).length / normalized.length;
}

async function firstEdition(workId: string): Promise<EditionSummary | null> {
  const snapshot = await db.collection("editions")
    .where("workId", "==", workId)
    .limit(1)
    .get();
  const first = snapshot.docs[0];
  if (first === undefined) return null;
  return editionSummary(first.id, storedEdition(first), workId);
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
  const scored = [...byId.values()].map((candidate) => {
    const bestTitle = Math.max(...candidate.work.titleKeys.map((candidateKey) =>
      tokenSimilarity(key, candidateKey),
    ));
    const authorsMatch = authorAgreement(authors, candidate.work);
    const exactTitle = candidate.work.titleKeys.includes(key);
    return {
      candidate,
      exactTitle,
      authorsMatch,
      score: bestTitle * 0.75 + authorsMatch * 0.25,
    };
  }).filter(({score, exactTitle, authorsMatch}) =>
    authorsMatch > 0 && (exactTitle || score >= 0.55),
  )
    .sort((left, right) => right.score - left.score)
    .slice(0, SEARCH_LIMIT);

  return Promise.all(scored.map(async ({candidate, exactTitle, authorsMatch}) => {
    const strong = exactTitle && authors.length > 0 && authorsMatch === 1;
    const edition = await firstEdition(candidate.id);
    return {
      workId: candidate.id,
      editionId: edition?.editionId ?? null,
      confidence: strong ? "strong-work" as const : "possible-work" as const,
      reason: strong ? "Exact title and author match" :
        exactTitle ? "Exact title match; confirm the author" : "Similar title and author",
      work: workSummary(candidate),
      edition,
    };
  }));
}

function workDocument(work: CatalogWorkInput, now: Timestamp): StoredWork & {
  createdAt: Timestamp;
  updatedAt: Timestamp;
} {
  return {
    canonicalTitle: work.canonicalTitle,
    alternateTitles: work.alternateTitles,
    titleKeys: titleKeys(work),
    authorNames: work.authorNames,
    authorNamesLower: work.authorNames.map(normalizeCatalogText),
    coverUrl: work.coverUrl,
    subjects: work.subjects,
    fiction: work.fiction,
    visibility: "searchable",
    status: "active",
    mergedFrom: [],
    createdAt: now,
    updatedAt: now,
  };
}

function editionDocument(
  workId: string,
  edition: CatalogEditionInput,
  now: Timestamp,
): StoredEdition & {createdAt: Timestamp; updatedAt: Timestamp} {
  return {workId, ...edition, createdAt: now, updatedAt: now};
}

function titleIndexId(workId: string, titleKey: string): string {
  return createHash("sha256").update(`${workId}\0${titleKey}`).digest("hex");
}

type CatalogCreateResult =
  | {
      status: "confirmation-required";
      reason: "identifier-unavailable";
    }
  | {
      status: "ready";
      workId: string;
      editionId: string;
      created: boolean;
      promoted: boolean;
    };

export async function createCatalogEntry(
  request: CatalogCreateRequest,
): Promise<CatalogCreateResult> {
  const workId = `work-${randomUUID()}`;
  const editionId = `edition-${randomUUID()}`;
  const now = Timestamp.now();

  return db.runTransaction(async (transaction): Promise<CatalogCreateResult> => {
    const isbnRef = request.edition.isbn13 === null ? null :
      db.collection("isbnIndex").doc(request.edition.isbn13);
    const externalRefs = Object.entries(request.edition.externalIds).map(
      ([provider, id]) => ({
        provider,
        id,
        ref: db.collection("externalIdIndex").doc(
          externalIndexId({provider, id}),
        ),
      }),
    );
    const [isbnSnapshot, externalSnapshots] = await Promise.all([
      isbnRef === null ? Promise.resolve(null) : transaction.get(isbnRef),
      Promise.all(externalRefs.map(({ref}) => transaction.get(ref))),
    ]);
    const existingIndexes = [
      ...(isbnSnapshot?.exists ? [{kind: "isbn" as const, snapshot: isbnSnapshot}] : []),
      ...externalSnapshots.flatMap((snapshot, index) => snapshot.exists ? [{
        kind: "external" as const,
        snapshot,
        external: externalRefs[index],
      }] : []),
    ];
    const firstIndex = existingIndexes[0];
    if (firstIndex !== undefined) {
      const indexedWorkId = firstIndex.snapshot.get("workId");
      const indexedEditionId = firstIndex.snapshot.get("editionId");
      if (typeof indexedWorkId !== "string" || typeof indexedEditionId !== "string") {
        throw new Error(`Invalid catalog index ${firstIndex.snapshot.ref.path}.`);
      }
      for (const existing of existingIndexes) {
        if (existing.snapshot.get("workId") !== indexedWorkId ||
            existing.snapshot.get("editionId") !== indexedEditionId) {
          throw new functions.https.HttpsError(
            "failed-precondition",
            "The supplied identifiers disagree with the shared catalog.",
          );
        }
      }
      const [workSnapshot, editionSnapshot] = await Promise.all([
        transaction.get(db.collection("works").doc(indexedWorkId)),
        transaction.get(db.collection("editions").doc(indexedEditionId)),
      ]);
      const resolved = await resolveTransactionWork(transaction, workSnapshot);
      const indexedEdition = storedEdition(editionSnapshot);
      if (isbnSnapshot?.exists &&
          indexedEdition.isbn13 !== request.edition.isbn13) {
        throw new Error(`ISBN index ${isbnSnapshot.ref.path} disagrees with its edition.`);
      }
      for (const existing of existingIndexes) {
        if (existing.kind === "external" &&
            indexedEdition.externalIds[existing.external.provider] !==
              existing.external.id) {
          throw new Error(
            `External ID index ${existing.snapshot.ref.path} disagrees with its edition.`,
          );
        }
      }
      const editionWork = await resolveTransactionWork(
        transaction,
        await transaction.get(db.collection("works").doc(indexedEdition.workId)),
      );
      if (editionWork.id !== resolved.id) {
        throw new Error(
          `Catalog index ${firstIndex.snapshot.ref.path} crosses catalog works.`,
        );
      }
      if (isbnRef !== null && !isbnSnapshot?.exists) {
        if (indexedEdition.isbn13 !== request.edition.isbn13) {
          throw new functions.https.HttpsError(
            "failed-precondition",
            "The supplied identifiers disagree with the shared catalog.",
          );
        }
        transaction.create(isbnRef, {workId: resolved.id, editionId: indexedEditionId});
      }
      externalSnapshots.forEach((snapshot, index) => {
        if (snapshot.exists) return;
        const external = externalRefs[index];
        if (indexedEdition.externalIds[external.provider] !== external.id) {
          throw new functions.https.HttpsError(
            "failed-precondition",
            "The supplied identifiers disagree with the shared catalog.",
          );
        }
        transaction.create(external.ref, {
          workId: resolved.id,
          editionId: indexedEditionId,
          provider: external.provider,
          externalId: external.id,
        });
      });
      if (resolved.work.visibility === "internal") {
        return {
          status: "confirmation-required",
          reason: "identifier-unavailable",
        };
      }
      return {
        status: "ready",
        workId: resolved.id,
        editionId: indexedEditionId,
        created: false,
        promoted: false,
      };
    }

    const workRef = db.collection("works").doc(workId);
    const editionRef = db.collection("editions").doc(editionId);
    const work = workDocument(request.work, now);
    const edition = editionDocument(workId, request.edition, now);
    transaction.create(workRef, work);
    transaction.create(editionRef, edition);
    if (isbnRef !== null) {
      transaction.create(isbnRef, {workId, editionId});
    }
    for (const external of externalRefs) {
      transaction.create(external.ref, {
        workId,
        editionId,
        provider: external.provider,
        externalId: external.id,
      });
    }
    for (const [index, key] of work.titleKeys.entries()) {
      const title = index === 0 ? request.work.canonicalTitle :
        request.work.alternateTitles.find((candidate) =>
          normalizeCatalogTitle(candidate) === key,
        ) ?? request.work.canonicalTitle;
      transaction.create(
        db.collection("workTitleIndex").doc(titleIndexId(workId, key)),
        {workId, title, titleKey: key, visibility: "searchable"},
      );
    }
    return {
      status: "ready",
      workId,
      editionId,
      created: true,
      promoted: false,
    };
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
      throw new Error(`Invalid reading event ${event.ref.path}.`);
    }
    const timeRead = type === "reading" ? event.get("timeRead") : 0;
    if (typeof timeRead !== "number" || !Number.isFinite(timeRead) || timeRead < 0) {
      throw new Error(`Invalid reading duration ${event.ref.path}.`);
    }
    return {type, createdAt, pagesRead, timeRead};
  });
}

const VALID_TIME_ZONES = new Set(["UTC", ...Intl.supportedValuesOf("timeZone")]);

export function summarizeReadingAttempt(
  book: {finished: boolean; pageCount: number; editionId: string | null},
  events: readonly ReadingEvent[],
  timeZone: string,
): ReadingAttemptMetrics {
  if (!VALID_TIME_ZONES.has(timeZone)) throw new Error(`Unsupported time zone ${timeZone}.`);
  const ordered = [...events].sort((left, right) =>
    left.createdAt.toMillis() - right.createdAt.toMillis(),
  );
  const reading = ordered.filter((event) => event.type === "reading");
  const firstProgress = ordered[0]?.createdAt ?? null;
  const firstRead = reading[0]?.createdAt ?? null;
  const finishedAt = book.finished ? ordered.at(-1)?.createdAt ?? null : null;
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
  pageCount: number;
  editionId: string | null;
} {
  const segments = snapshot.ref.path.split("/");
  if (segments.length !== 4 || segments[0] !== "users" || segments[2] !== "books") {
    throw new Error(`Unexpected personal book path ${snapshot.ref.path}.`);
  }
  const owner = snapshot.get("owner");
  if (!(owner instanceof DocumentReference) || owner.path !== `users/${segments[1]}`) {
    throw new Error(`Invalid personal book owner ${snapshot.ref.path}.`);
  }
  const finished = snapshot.get("finished");
  const pageCount = snapshot.get("pageCount");
  const editionId = snapshot.get("editionId");
  if (typeof finished !== "boolean" || !Number.isSafeInteger(pageCount) || pageCount <= 0 ||
      (editionId !== null && editionId !== undefined && typeof editionId !== "string")) {
    throw new Error(`Invalid personal book summary fields ${snapshot.ref.path}.`);
  }
  return {uid: segments[1], finished, pageCount, editionId: editionId ?? null};
}

function safePersonalBookIdentity(
  snapshot: DocumentSnapshot,
  workId: string,
): ReturnType<typeof personalBookIdentity> | null {
  try {
    return personalBookIdentity(snapshot);
  } catch {
    logger.warn("catalog.work_readers.attempt_skipped", {
      workId,
      reason: "invalid-book",
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
  let updateRowsRead = 0;
  let attemptedQueries = 0;
  for (let index = 0; index < books.length; index += 1) {
    if (attemptedQueries >= SHARED_ATTEMPT_LIMIT ||
        updateRowsRead >= TOTAL_UPDATES_LIMIT) {
      omittedAttempts += books.length - index;
      incomplete = true;
      break;
    }
    const {snapshot, identity, shared} = books[index];
    const remainingUpdateBudget = TOTAL_UPDATES_LIMIT - updateRowsRead;
    const queryLimit = Math.min(
      UPDATES_PER_BOOK_LIMIT + 1,
      remainingUpdateBudget + 1,
    );
    const updates = await snapshot.ref.collection("updates")
      .limit(queryLimit)
      .get();
    attemptedQueries += 1;
    updateRowsRead += updates.size;
    if (updates.size > UPDATES_PER_BOOK_LIMIT ||
        updates.size > remainingUpdateBudget) {
      logger.warn("catalog.work_readers.attempt_skipped", {
        workId,
        reason: updates.size > UPDATES_PER_BOOK_LIMIT ?
          "update-limit" : "total-update-limit",
      });
      omittedAttempts += updates.size > UPDATES_PER_BOOK_LIMIT
        ? 1
        : books.length - index;
      incomplete = true;
      if (updates.size > UPDATES_PER_BOOK_LIMIT) continue;
      break;
    }
    try {
      rows.push({
        username: shared.username,
        displayName: shared.displayName,
        editionIsbn13: null,
        ...summarizeReadingAttempt(
          identity,
          readingEvents(updates, identity.uid, snapshot.ref.path),
          shared.timeZone,
        ),
      });
    } catch {
      logger.warn("catalog.work_readers.attempt_skipped", {
        workId,
        reason: "invalid-updates",
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
      if (!user.exists || user.get("deletedAt") !== undefined) return null;
      if (!setting.exists) return null;
      const profileUsername = setting.get("profileUsername");
      const timeZone = setting.get("timeZone");
      if (typeof profileUsername !== "string" ||
          !/^[a-z0-9-]{3,30}$/.test(profileUsername) ||
          typeof timeZone !== "string" ||
          !VALID_TIME_ZONES.has(timeZone)) return null;
      const profile = await db.collection("profiles").doc(profileUsername).get();
      if (!profile.exists || profile.get("deletedAt") !== undefined ||
          profile.get("uid") !== uid || profile.get("public") !== true ||
          typeof profile.get("givenName") !== "string" ||
          typeof profile.get("familyName") !== "string") return null;
      const displayName = `${profile.get("givenName")} ${profile.get("familyName")}`.trim();
      if (displayName === "") return null;
      return {uid, username: profileUsername, displayName, timeZone};
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
      work: workSummary(resolved),
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

const callable = functions
  .region("europe-west1")
  .runWith({
    serviceAccount: FUNCTIONS_RUNTIME_SERVICE_ACCOUNT,
    maxInstances: CALLABLE_MAX_INSTANCES,
  });

exports.search = callable.https.onCall(async (
  data: unknown,
  context,
): Promise<{results: CatalogSearchResult[]}> => {
  const uid = signedInUid(context);
  const request: CatalogSearchRequest = decodeCatalogSearchRequest(data, invalidArgument);
  await requireQuota(uid, "catalogSearch", SEARCHES_PER_WINDOW);
  if (request.isbn13 !== undefined) {
    const exact = await exactIsbnResult(request.isbn13);
    if (exact !== null) return {results: [exact]};
  }
  if (request.externalId !== undefined) {
    const exact = await exactExternalIdResult(request.externalId);
    if (exact !== null) return {results: [exact]};
  }
  return {
    results: request.title === undefined ? [] :
      await titleResults(request.title, request.authorNames ?? []),
  };
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
  const startedAt = Date.now();
  const uid = signedInUid(context);
  const request = decodeWorkReadersRequest(data, invalidArgument);
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
