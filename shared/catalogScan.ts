// The catalog scan: every finding the curation console shows, computed from
// the stored documents of the catalog collections and every personal book.
// Pure and synchronous, so the operator's browser runs it over live
// Firestore listeners (src/lib/firebase/adminCatalog.ts) and the root tests
// run it over fixtures; it knows nothing about Firestore, only about the
// document shapes the catalog writes. See shared/catalogIdentity.ts for why
// this directory is shared between the app and Cloud Functions.
//
// A malformed document is reported and skipped, never coerced into a
// plausible-looking row: the console curates identity, so a silently
// invented title or link is worse than a missing row. That goes for catalog
// documents too — the server is their only writer, so a malformed one is a
// bug worth a red finding, not a reason to blank the page.

import {
  identityTokens,
  normalizeCatalogIdentity,
  normalizeCatalogTitle,
  normalizeIsbn13,
  tokenAgreement,
} from './catalogIdentity.ts';
import { MAX_AUTHORS_PER_PERSONAL_BOOK } from './catalogLimits.ts';

export type WorkStatus = 'active' | 'merged' | 'hidden';
export type CatalogAuthorStatus = 'active' | 'merged';
export type CatalogAuthorKind = 'person' | 'entity' | 'placeholder';
export type EditionFormat = 'full' | 'abridged' | 'revised' | 'unknown';
export const CATALOG_MATCH_METHODS = [
  'isbn', 'external-id', 'catalog-choice', 'migration', 'admin',
] as const;
export type CatalogMatchMethod = typeof CATALOG_MATCH_METHODS[number];

// One stored document as the listener hands it over: its id and its data.
export interface CatalogScanDocument {
  id: string;
  data: Record<string, unknown>;
}

// externalIdIndex rows also carry the id the index rules derive from the
// row's own provider and external id (a SHA-256 the caller computes, since
// the browser's digest is asynchronous); a row whose stored id differs from
// it is a mismatch.
export interface CatalogScanIndexDocument extends CatalogScanDocument {
  expectedId: string;
}

export interface CatalogScanBookDocument {
  uid: string;
  bookId: string;
  data: Record<string, unknown>;
}

export interface CatalogScanInput {
  authors: readonly CatalogScanDocument[];
  works: readonly CatalogScanDocument[];
  editions: readonly CatalogScanDocument[];
  isbnIndex: readonly CatalogScanDocument[];
  externalIdIndex: readonly CatalogScanIndexDocument[];
  books: readonly CatalogScanBookDocument[];
  // Accounts whose users document exists and carries no tombstone; a book
  // owned by any other uid is orphaned data.
  liveUserIds: ReadonlySet<string>;
}

// The rows carry what the curation console renders or prefills a form with,
// and nothing else.
export interface AdminCatalogWorkRow {
  workId: string;
  canonicalTitle: string;
  alternateTitles: string[];
  authorIds: string[];
  coverUrl: string;
  subjects: string[];
  fiction: boolean | null;
  status: WorkStatus;
  // The survivor a merged work redirects to; null unless status is merged.
  mergedInto: string | null;
  mergedFrom: string[];
  // uid of the user who created the work through the add-book flow; null
  // for migration- or admin-created works.
  createdBy: string | null;
  createdAt: number;
  // When the operator last marked the work reviewed; null until then.
  reviewedAt: number | null;
  // The latest of the work's creation, its editions' creation and its
  // books' linking: activity after reviewedAt puts the work back in the
  // review queue.
  activityAt: number;
  editionCount: number;
  linkedBookCount: number;
  warnings: string[];
}

export interface AdminCatalogAuthorRow {
  authorId: string;
  canonicalName: string;
  alternateNames: string[];
  sortName: string;
  kind: CatalogAuthorKind;
  status: CatalogAuthorStatus;
  mergedInto: string | null;
  mergedFrom: string[];
  // uid of the account whose add-book flow minted the author; null for
  // migration- or admin-created authors.
  createdBy: string | null;
  createdAt: number;
  // When the operator last marked the author reviewed; null until then.
  reviewedAt: number | null;
  // The latest of the author's creation and the creation of any work
  // naming it, directly or through a merged alias.
  activityAt: number;
  workCount: number;
  warnings: string[];
}

export interface AdminCatalogEditionRow {
  editionId: string;
  workId: string;
  isbn13: string | null;
  title: string;
  publisher: string;
  publishedDate: string;
  language: string;
  translatorNames: string[];
  format: EditionFormat;
  suggestedPageCount: number | null;
  coverUrl: string;
  externalIds: Record<string, string>;
  // uid of the account whose book the edition was minted for (the add-book
  // flow, an admin link, or the backfill); null for migration- or
  // admin-created editions.
  createdBy: string | null;
  createdAt: number;
}

export interface AdminCatalogBookTarget {
  uid: string;
  bookId: string;
}

export interface AdminCatalogBookRow extends AdminCatalogBookTarget {
  title: string;
  authorNames: string[];
  isbn13: string | null;
  rawIsbn: string | null;
  // null when the book has no usable page count; the console renders an em
  // dash rather than dropping the row.
  pageCount: number | null;
  publisher: string;
  coverUrl: string;
  workId: string | null;
  editionId: string | null;
  // When the link was made; null for an unlinked book or a link that
  // recorded no time.
  linkedAt: number | null;
  anomaly: string | null;
}

export type AdminCatalogFindingCode =
  | 'catalog-row-anomaly'
  | 'book-row-anomaly'
  | 'book-link-anomaly'
  | 'linked-without-edition'
  | 'unmatched-isbn-candidate'
  | 'unmatched-title-author-candidate'
  | 'likely-title-author-candidate'
  | 'edition-missing-work'
  | 'edition-invariant'
  | 'isbn-index-mismatch'
  | 'external-id-index-mismatch'
  | 'work-invariant'
  | 'duplicate-author-name'
  | 'suspected-duplicate-works';

export interface AdminCatalogFinding {
  code: AdminCatalogFindingCode;
  severity: 'error' | 'warning';
  message: string;
  workIds: string[];
  editionIds: string[];
  books: AdminCatalogBookTarget[];
}

export interface CatalogScan {
  authors: AdminCatalogAuthorRow[];
  works: AdminCatalogWorkRow[];
  editions: AdminCatalogEditionRow[];
  books: AdminCatalogBookRow[];
  findings: AdminCatalogFinding[];
}

interface ScanWork {
  canonicalTitle: string;
  alternateTitles: string[];
  titleKeys: string[];
  authorIds: string[];
  coverUrl: string;
  subjects: string[];
  fiction: boolean | null;
  status: WorkStatus;
  mergedInto: string | null;
  mergedFrom: string[];
  createdBy: string | null;
  createdAt: number;
  reviewedAt: number | null;
  unsupportedFields: string[];
}

interface ScanAuthor {
  canonicalName: string;
  alternateNames: string[];
  nameKeys: string[];
  sortName: string;
  kind: CatalogAuthorKind;
  status: CatalogAuthorStatus;
  mergedInto: string | null;
  mergedFrom: string[];
  createdBy: string | null;
  createdAt: number;
  reviewedAt: number | null;
  unsupportedFields: string[];
}

interface ScanEdition extends Omit<AdminCatalogEditionRow, 'editionId'> {
  unsupportedFields: string[];
}

class ScanRowError extends Error {}

function rowError(message: string): never {
  throw new ScanRowError(message);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

const WORK_FIELDS = [
  'canonicalTitle', 'alternateTitles', 'titleKeys', 'authorIds', 'coverUrl', 'subjects',
  'fiction', 'status', 'mergedInto', 'mergedFrom', 'createdBy', 'createdAt', 'updatedAt',
  'reviewedAt',
];
const AUTHOR_FIELDS = [
  'canonicalName', 'alternateNames', 'nameKeys', 'sortName', 'kind', 'status', 'mergedInto',
  'mergedFrom', 'createdBy', 'createdAt', 'updatedAt', 'reviewedAt',
];
const EDITION_FIELDS = [
  'workId', 'isbn13', 'title', 'publisher', 'publishedDate', 'language', 'translatorNames',
  'format', 'suggestedPageCount', 'coverUrl', 'externalIds', 'createdBy', 'createdAt', 'updatedAt',
];

// The admin apply path round-trips whole documents and refuses one with a
// field it cannot see; the scan names such fields so the operator learns
// before an operation fails on them.
function unsupportedFields(data: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(data).filter((key) => !allowed.includes(key));
}

// Firestore timestamps from either SDK; the two classes are unrelated, so
// the shape is what is checked.
function millis(value: unknown, label: string): number {
  if (typeof value === 'object' && value !== null && 'toMillis' in value &&
      typeof value.toMillis === 'function') {
    const ms: unknown = value.toMillis();
    if (typeof ms === 'number' && Number.isFinite(ms)) return ms;
  }
  return rowError(`${label} must be a timestamp.`);
}

function optionalRedirect(value: unknown, label: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') rowError(`Invalid redirect at ${label}.`);
  return value;
}

function optionalMillis(value: unknown, label: string): number | null {
  return value === undefined ? null : millis(value, label);
}

function optionalCreator(value: unknown, label: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') rowError(`Invalid creator ${label}.`);
  return value;
}

function readWork({ id, data }: CatalogScanDocument): ScanWork {
  const label = `works/${id}`;
  if (data.status !== 'active' && data.status !== 'merged' && data.status !== 'hidden') {
    rowError(`Invalid work status at ${label}.`);
  }
  const { alternateTitles, titleKeys, authorIds, subjects, mergedFrom } = data;
  if (!isStringArray(alternateTitles) || !isStringArray(titleKeys) || !isStringArray(authorIds) ||
      !isStringArray(subjects) || !isStringArray(mergedFrom)) {
    rowError(`Invalid work arrays at ${label}.`);
  }
  if (typeof data.canonicalTitle !== 'string' || typeof data.coverUrl !== 'string' ||
      (data.fiction !== null && typeof data.fiction !== 'boolean')) {
    rowError(`Invalid catalog work ${label}.`);
  }
  return {
    canonicalTitle: data.canonicalTitle,
    alternateTitles,
    titleKeys,
    authorIds,
    coverUrl: data.coverUrl,
    subjects,
    fiction: data.fiction,
    status: data.status,
    mergedInto: optionalRedirect(data.mergedInto, label),
    mergedFrom,
    createdBy: optionalCreator(data.createdBy, label),
    createdAt: millis(data.createdAt, `${label}.createdAt`),
    reviewedAt: optionalMillis(data.reviewedAt, `${label}.reviewedAt`),
    unsupportedFields: unsupportedFields(data, WORK_FIELDS),
  };
}

function readAuthor({ id, data }: CatalogScanDocument): ScanAuthor {
  const label = `catalogAuthors/${id}`;
  if (typeof data.canonicalName !== 'string' || typeof data.sortName !== 'string' ||
      (data.kind !== 'person' && data.kind !== 'entity' && data.kind !== 'placeholder') ||
      (data.status !== 'active' && data.status !== 'merged')) {
    rowError(`Invalid catalog author ${label}.`);
  }
  const { alternateNames, nameKeys, mergedFrom } = data;
  if (!isStringArray(alternateNames) || !isStringArray(nameKeys) || !isStringArray(mergedFrom)) {
    rowError(`Invalid catalog author arrays at ${label}.`);
  }
  return {
    canonicalName: data.canonicalName,
    alternateNames,
    nameKeys,
    sortName: data.sortName,
    kind: data.kind,
    status: data.status,
    mergedInto: optionalRedirect(data.mergedInto, label),
    mergedFrom,
    createdBy: optionalCreator(data.createdBy, label),
    createdAt: millis(data.createdAt, `${label}.createdAt`),
    reviewedAt: optionalMillis(data.reviewedAt, `${label}.reviewedAt`),
    unsupportedFields: unsupportedFields(data, AUTHOR_FIELDS),
  };
}

function readEdition({ id, data }: CatalogScanDocument): ScanEdition {
  const label = `editions/${id}`;
  const { externalIds, translatorNames } = data;
  if (typeof data.workId !== 'string' ||
      (data.isbn13 !== null && typeof data.isbn13 !== 'string') ||
      typeof data.title !== 'string' || typeof data.publisher !== 'string' ||
      typeof data.publishedDate !== 'string' || typeof data.language !== 'string' ||
      !isStringArray(translatorNames) ||
      (data.format !== 'full' && data.format !== 'abridged' && data.format !== 'revised' &&
       data.format !== 'unknown') ||
      (data.suggestedPageCount !== null && typeof data.suggestedPageCount !== 'number') ||
      typeof data.coverUrl !== 'string' ||
      typeof externalIds !== 'object' || externalIds === null || Array.isArray(externalIds) ||
      Object.entries(externalIds).some(([provider, value]) =>
        !/^[a-z0-9-]{1,40}$/.test(provider) || typeof value !== 'string')) {
    rowError(`Invalid catalog edition ${label}.`);
  }
  return {
    workId: data.workId,
    isbn13: data.isbn13,
    title: data.title,
    publisher: data.publisher,
    publishedDate: data.publishedDate,
    language: data.language,
    translatorNames,
    format: data.format,
    suggestedPageCount: data.suggestedPageCount,
    coverUrl: data.coverUrl,
    externalIds: externalIds as Record<string, string>,
    createdBy: optionalCreator(data.createdBy, label),
    createdAt: millis(data.createdAt, `${label}.createdAt`),
    unsupportedFields: unsupportedFields(data, EDITION_FIELDS),
  };
}

// Absent is legitimate (a book need not carry a publisher or a cover); a
// value of the wrong type is a schema violation.
function scanText(data: Record<string, unknown>, field: string, label: string): string {
  const value = data[field];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') rowError(`${label}.${field} must be a string.`);
  return value;
}

// A display hint, not identity: an absent or nonsensical page count renders
// as an em dash instead of costing the row.
function scanPageCount(data: Record<string, unknown>): number | null {
  const value = data.pageCount;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

interface LinkState {
  workId: string | null;
  editionId: string | null;
  linkedAt: number | null;
}

// The same acceptance the apply path has for a stored link: null or absent
// is unlinked, anything but a string id, a known match method or a
// timestamp is corruption.
function linkFrom(data: Record<string, unknown>, label: string): LinkState {
  const { workId, editionId, matchMethod, linkedAt } = data;
  const isOptionalString = (value: unknown) =>
    value === undefined || value === null || typeof value === 'string';
  if (!isOptionalString(workId) || !isOptionalString(editionId) ||
      (matchMethod !== undefined && matchMethod !== null &&
       !CATALOG_MATCH_METHODS.includes(matchMethod as CatalogMatchMethod)) ||
      (linkedAt !== undefined && linkedAt !== null &&
       !(typeof linkedAt === 'object' && 'toMillis' in linkedAt))) {
    rowError(`Invalid catalog link at ${label}.`);
  }
  return {
    workId: (workId as string | null | undefined) ?? null,
    editionId: (editionId as string | null | undefined) ?? null,
    linkedAt: linkedAt === undefined || linkedAt === null ? null : millis(linkedAt, `${label}.linkedAt`),
  };
}

const utf8 = new TextEncoder();

function validSegment(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !value.includes('/') &&
    utf8.encode(value).length <= 1500;
}

export function scanCatalog(input: CatalogScanInput): CatalogScan {
  const findings: AdminCatalogFinding[] = [];
  const catalogRowAnomaly = (message: string, ids: Partial<Pick<AdminCatalogFinding, 'workIds' | 'editionIds'>>) => {
    findings.push({
      code: 'catalog-row-anomaly',
      severity: 'error',
      message,
      workIds: ids.workIds ?? [],
      editionIds: ids.editionIds ?? [],
      books: [],
    });
  };
  const readAll = <T>(
    documents: readonly CatalogScanDocument[],
    read: (document: CatalogScanDocument) => T,
    ids: (id: string) => Partial<Pick<AdminCatalogFinding, 'workIds' | 'editionIds'>>,
  ): Map<string, T> => {
    const byId = new Map<string, T>();
    for (const document of documents) {
      try {
        byId.set(document.id, read(document));
      } catch (error) {
        if (!(error instanceof ScanRowError)) throw error;
        catalogRowAnomaly(error.message, ids(document.id));
      }
    }
    return byId;
  };
  const catalogAuthorById = readAll(input.authors, readAuthor, () => ({}));
  const workById = readAll(input.works, readWork, (id) => ({ workIds: [id] }));
  const editionById = readAll(input.editions, readEdition, (id) => ({ editionIds: [id] }));

  const isbnMappings = new Map<string, {workId: string; editionId: string}>();
  for (const { id, data } of input.isbnIndex) {
    if (typeof data.workId === 'string' && typeof data.editionId === 'string') {
      isbnMappings.set(id, { workId: data.workId, editionId: data.editionId });
    }
  }

  const resolvedWorkId = (workId: string): string | null => {
    const work = workById.get(workId);
    if (work === undefined) return null;
    if (work.status !== 'merged') return workId;
    if (work.mergedInto === null) return null;
    const target = workById.get(work.mergedInto);
    return target !== undefined && target.status !== 'merged' ? work.mergedInto : null;
  };
  const resolvedCatalogAuthorId = (authorId: string): string | null => {
    const author = catalogAuthorById.get(authorId);
    if (author === undefined) return null;
    if (author.status === 'active') return authorId;
    if (author.mergedInto === null) return null;
    return catalogAuthorById.get(author.mergedInto)?.status === 'active' ?
      author.mergedInto : null;
  };
  const resolvedAuthors = (authorIds: readonly string[]): ScanAuthor[] =>
    authorIds.flatMap((authorId) => {
      const resolvedId = resolvedCatalogAuthorId(authorId);
      const author = resolvedId === null ? undefined : catalogAuthorById.get(resolvedId);
      return author === undefined || author.kind === 'placeholder' ? [] : [author];
    });
  const catalogAuthorKeySets = (work: ScanWork): Array<Set<string>> =>
    resolvedAuthors(work.authorIds).map((author) =>
      new Set([normalizeCatalogIdentity(author.canonicalName), ...author.nameKeys]),
    );
  // "Exact" is the migration contract: the complete normalized author
  // identity agrees, aliases included. A book by [A, B] against a work by
  // [A, C] is partial overlap and stays in the similarity path below.
  const exactAuthorSet = (work: ScanWork, bookKeys: ReadonlySet<string>): boolean => {
    const sets = catalogAuthorKeySets(work);
    return sets.length > 0 && sets.length === bookKeys.size &&
      sets.every((keys) => [...bookKeys].some((bookKey) => keys.has(bookKey))) &&
      [...bookKeys].every((bookKey) => sets.some((keys) => keys.has(bookKey)));
  };
  const catalogAuthorNames = (authorIds: readonly string[]): string[] =>
    [...new Set(resolvedAuthors(authorIds).map((author) => author.canonicalName))];

  const linkedCounts = new Map<string, number>();
  const books: AdminCatalogBookRow[] = [];
  for (const { uid, bookId, data } of input.books) {
    const label = `users/${uid}/books/${bookId}`;
    let row: Omit<AdminCatalogBookRow, 'anomaly'>;
    let authorProblem = false;
    try {
      const rawIsbn = scanText(data, 'isbn', label);
      const isbn13 = normalizeIsbn13(rawIsbn);
      const title = data.title;
      if (typeof title !== 'string' || title === '') {
        rowError(`${label}.title must be a non-empty string.`);
      }
      const link = linkFrom(data, label);
      const ids = data.authorIds;
      if (ids !== undefined) {
        if (!Array.isArray(ids) || ids.length > MAX_AUTHORS_PER_PERSONAL_BOOK ||
            new Set(ids).size !== ids.length || ids.some((id) => !validSegment(id)) ||
            ids.some((id) => resolvedCatalogAuthorId(id) === null)) {
          authorProblem = true;
        }
      }
      row = {
        uid,
        bookId,
        title,
        authorNames: Array.isArray(ids) ?
          catalogAuthorNames(ids.filter((id): id is string => typeof id === 'string')) : [],
        // The same normalizer the link/apply path uses, so an ISBN-10 that
        // apply would happily link is also reported as a candidate here.
        isbn13,
        rawIsbn: isbn13 === null && rawIsbn !== '' ? rawIsbn : null,
        pageCount: scanPageCount(data),
        publisher: scanText(data, 'publisher', label),
        coverUrl: scanText(data, 'coverUrl', label),
        workId: link.workId,
        editionId: link.editionId,
        linkedAt: link.linkedAt,
      };
    } catch (error) {
      if (!(error instanceof ScanRowError)) throw error;
      findings.push({
        code: 'book-row-anomaly',
        severity: 'error',
        message: error.message,
        workIds: [],
        editionIds: [],
        books: [{ uid, bookId }],
      });
      continue;
    }
    books.push(finishBook(row, !input.liveUserIds.has(uid) ? 'orphaned data' :
      authorProblem ? 'missing or malformed author' : null));
  }

  function finishBook(
    row: Omit<AdminCatalogBookRow, 'anomaly'>,
    baseAnomaly: string | null,
  ): AdminCatalogBookRow {
    if (row.workId !== null) {
      const resolved = resolvedWorkId(row.workId) ?? row.workId;
      linkedCounts.set(resolved, (linkedCounts.get(resolved) ?? 0) + 1);
    }
    let anomaly = baseAnomaly;
    const resolvedBookWork = row.workId === null ? null : resolvedWorkId(row.workId);
    if (row.workId !== null && resolvedBookWork === null) anomaly = 'missing or broken work';
    const linkedEdition = row.editionId === null ? null : editionById.get(row.editionId);
    if (row.editionId !== null && linkedEdition === undefined) anomaly = 'missing edition';
    if (linkedEdition !== null && linkedEdition !== undefined && resolvedBookWork !== null &&
        resolvedWorkId(linkedEdition.workId) !== resolvedBookWork) {
      anomaly = 'edition belongs to another work';
    }
    if (anomaly !== null) {
      findings.push({
        code: 'book-link-anomaly',
        severity: 'error',
        message: anomaly,
        workIds: row.workId === null ? [] : [row.workId],
        editionIds: row.editionId === null ? [] : [row.editionId],
        books: [{ uid: row.uid, bookId: row.bookId }],
      });
    } else if (row.workId !== null && row.editionId === null) {
      // Every linked book stands on an edition of its work (owner decision
      // 2026-09-01); a link without one is drift the work page repairs by
      // minting an edition from the book's own fields.
      findings.push({
        code: 'linked-without-edition',
        severity: 'warning',
        message: 'Linked book has no edition; every linked book belongs on an edition of its work.',
        workIds: [row.workId],
        editionIds: [],
        books: [{ uid: row.uid, bookId: row.bookId }],
      });
    }
    return { ...row, anomaly };
  }

  // Similarity candidates compare token sets; the sets for every active work
  // are built once rather than per unmatched book.
  const workTokens = new Map<string, {titles: Set<string>[]; authors: Set<string>[]}>();
  const tokensFor = (workId: string, work: ScanWork) => {
    let tokens = workTokens.get(workId);
    if (tokens === undefined) {
      tokens = {
        titles: work.titleKeys.map(identityTokens),
        authors: catalogAuthorNames(work.authorIds).map(identityTokens),
      };
      workTokens.set(workId, tokens);
    }
    return tokens;
  };
  for (const book of books) {
    if (book.anomaly !== null || book.workId !== null) continue;
    const mapping = book.isbn13 === null ? undefined : isbnMappings.get(book.isbn13);
    if (mapping !== undefined && resolvedWorkId(mapping.workId) !== null) {
      findings.push({
        code: 'unmatched-isbn-candidate',
        severity: 'warning',
        message: 'Unmatched book has an exact catalog ISBN candidate.',
        workIds: [resolvedWorkId(mapping.workId) ?? mapping.workId],
        editionIds: [mapping.editionId],
        books: [{ uid: book.uid, bookId: book.bookId }],
      });
      continue;
    }
    const key = normalizeCatalogTitle(book.title);
    const normalizedAuthors = new Set(book.authorNames.map(normalizeCatalogIdentity));
    const candidates = [...workById].filter(([, work]) =>
      work.status === 'active' && work.titleKeys.includes(key) &&
      exactAuthorSet(work, normalizedAuthors),
    );
    if (candidates.length > 0) {
      findings.push({
        code: 'unmatched-title-author-candidate',
        severity: 'warning',
        message: 'Unmatched book has an exact normalized title and author candidate.',
        workIds: candidates.map(([id]) => id),
        editionIds: [],
        books: [{ uid: book.uid, bookId: book.bookId }],
      });
      continue;
    }
    const titleTokens = identityTokens(key);
    const authorTokens = book.authorNames.map(identityTokens);
    const likely = [...workById].flatMap(([id, work]) => {
      if (work.status !== 'active') return [];
      const tokens = tokensFor(id, work);
      const titleScore = Math.max(0, ...tokens.titles.map((titleKey) =>
        tokenAgreement(titleTokens, titleKey),
      ));
      const authorScore = Math.max(0, ...authorTokens.flatMap((bookAuthor) =>
        tokens.authors.map((workAuthor) => tokenAgreement(bookAuthor, workAuthor)),
      ));
      const score = titleScore * 0.75 + authorScore * 0.25;
      return titleScore >= 0.5 && authorScore >= 0.5 && score >= 0.6 ? [{ id, score }] : [];
    }).sort((left, right) => right.score - left.score).slice(0, 5);
    if (likely.length > 0) {
      findings.push({
        code: 'likely-title-author-candidate',
        severity: 'warning',
        message: 'Unmatched book has a similar normalized title and author candidate; confirm manually.',
        workIds: likely.map(({ id }) => id),
        editionIds: [],
        books: [{ uid: book.uid, bookId: book.bookId }],
      });
    }
  }

  const editionCounts = new Map<string, number>();
  for (const [editionId, edition] of editionById) {
    editionCounts.set(edition.workId, (editionCounts.get(edition.workId) ?? 0) + 1);
    if (!workById.has(edition.workId)) {
      findings.push({
        code: 'edition-missing-work',
        severity: 'error',
        message: 'Edition targets a missing work.',
        workIds: [edition.workId],
        editionIds: [editionId],
        books: [],
      });
    }
    for (const field of edition.unsupportedFields) {
      findings.push({
        code: 'edition-invariant',
        severity: 'error',
        message: `unsupported field ${field}`,
        workIds: [edition.workId],
        editionIds: [editionId],
        books: [],
      });
    }
  }
  for (const { id, data } of input.isbnIndex) {
    const { editionId, workId } = data;
    const edition = typeof editionId === 'string' ? editionById.get(editionId) : undefined;
    if (edition === undefined || edition.isbn13 !== id || edition.workId !== workId) {
      findings.push({
        code: 'isbn-index-mismatch',
        severity: 'error',
        message: 'ISBN index disagrees with its edition.',
        workIds: typeof workId === 'string' ? [workId] : [],
        editionIds: typeof editionId === 'string' ? [editionId] : [],
        books: [],
      });
    }
  }
  for (const { id, data, expectedId } of input.externalIdIndex) {
    const { editionId, workId, provider, externalId } = data;
    const edition = typeof editionId === 'string' ? editionById.get(editionId) : undefined;
    if (edition === undefined || edition.workId !== workId ||
        typeof provider !== 'string' || typeof externalId !== 'string' ||
        edition.externalIds[provider] !== externalId || expectedId !== id) {
      findings.push({
        code: 'external-id-index-mismatch',
        severity: 'error',
        message: 'External ID index disagrees with its edition.',
        workIds: typeof workId === 'string' ? [workId] : [],
        editionIds: typeof editionId === 'string' ? [editionId] : [],
        books: [],
      });
    }
  }

  const workWarnings = new Map<string, string[]>();
  const catalogAuthorWorkCounts = new Map<string, number>();
  for (const [id, work] of workById) {
    const warnings: string[] = [];
    if (work.status === 'merged' &&
        (work.mergedInto === null || (workById.get(work.mergedInto)?.status ?? 'merged') === 'merged')) {
      warnings.push('broken redirect');
    }
    if (work.status !== 'merged' && work.mergedFrom.length > 29) {
      warnings.push('too many aliases');
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
    for (const field of work.unsupportedFields) warnings.push(`unsupported field ${field}`);
    workWarnings.set(id, warnings);
    for (const warning of warnings) {
      findings.push({
        code: 'work-invariant',
        severity: 'error',
        message: warning,
        workIds: [id],
        editionIds: [],
        books: [],
      });
    }
  }

  const catalogAuthorWarnings = new Map<string, string[]>();
  const activeAuthorNameOwners = new Map<string, string[]>();
  for (const [id, author] of catalogAuthorById) {
    const warnings: string[] = [];
    if (author.status === 'merged' &&
        (author.mergedInto === null ||
         catalogAuthorById.get(author.mergedInto)?.status !== 'active')) {
      warnings.push('broken redirect');
    }
    if (author.status === 'active' && author.mergedFrom.length > 29) {
      warnings.push('too many aliases');
    }
    const expectedNameKeys = [...new Set(
      [author.canonicalName, ...author.alternateNames].map(normalizeCatalogIdentity),
    )];
    if (JSON.stringify(author.nameKeys) !== JSON.stringify(expectedNameKeys)) {
      warnings.push('name index mismatch');
    }
    for (const field of author.unsupportedFields) warnings.push(`unsupported field ${field}`);
    if (author.status === 'active') {
      for (const key of author.nameKeys) {
        activeAuthorNameOwners.set(key, [...(activeAuthorNameOwners.get(key) ?? []), id]);
      }
    }
    catalogAuthorWarnings.set(id, warnings);
  }
  for (const [nameKey, authorIds] of activeAuthorNameOwners) {
    if (authorIds.length < 2) continue;
    findings.push({
      code: 'duplicate-author-name',
      severity: 'error',
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
    if (work.status !== 'active') continue;
    const authorsKey = work.authorIds.map((authorId) => resolvedCatalogAuthorId(authorId) ?? authorId)
      .sort().join('\0');
    for (const titleKey of work.titleKeys) {
      const key = `${titleKey}\0${authorsKey}`;
      identities.set(key, [...(identities.get(key) ?? []), id]);
    }
  }
  const duplicateSets = new Set<string>();
  for (const ids of identities.values()) {
    if (ids.length < 2) continue;
    const workIds = [...new Set(ids)].sort();
    const key = workIds.join('\0');
    if (duplicateSets.has(key)) continue;
    duplicateSets.add(key);
    findings.push({
      code: 'suspected-duplicate-works',
      severity: 'warning',
      message: 'Active works share an exact normalized title and author set.',
      workIds,
      editionIds: [],
      books: [],
    });
  }

  // Activity is what can put a reviewed record back in the queue: a work
  // moves when it is created, gains an edition or has a book linked (an
  // alias's edition or book counts for the survivor too); an author moves
  // when it is created or a work names it, directly or through an alias.
  const workActivity = new Map<string, number>();
  const authorActivity = new Map<string, number>();
  const bump = (activity: Map<string, number>, id: string, at: number | null): void => {
    if (at !== null && at > (activity.get(id) ?? Number.NEGATIVE_INFINITY)) activity.set(id, at);
  };
  for (const [id, work] of workById) bump(workActivity, id, work.createdAt);
  for (const edition of editionById.values()) {
    bump(workActivity, edition.workId, edition.createdAt);
    bump(workActivity, resolvedWorkId(edition.workId) ?? edition.workId, edition.createdAt);
  }
  for (const book of books) {
    if (book.workId === null) continue;
    bump(workActivity, book.workId, book.linkedAt);
    bump(workActivity, resolvedWorkId(book.workId) ?? book.workId, book.linkedAt);
  }
  for (const [id, author] of catalogAuthorById) bump(authorActivity, id, author.createdAt);
  for (const work of workById.values()) {
    for (const authorId of work.authorIds) {
      bump(authorActivity, authorId, work.createdAt);
      bump(authorActivity, resolvedCatalogAuthorId(authorId) ?? authorId, work.createdAt);
    }
  }

  return {
    authors: [...catalogAuthorById].map(([authorId, author]) => ({
      authorId,
      canonicalName: author.canonicalName,
      alternateNames: author.alternateNames,
      sortName: author.sortName,
      kind: author.kind,
      status: author.status,
      mergedInto: author.mergedInto,
      mergedFrom: author.mergedFrom,
      createdBy: author.createdBy,
      createdAt: author.createdAt,
      reviewedAt: author.reviewedAt,
      activityAt: authorActivity.get(authorId) ?? author.createdAt,
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
      mergedInto: work.mergedInto,
      mergedFrom: work.mergedFrom,
      createdBy: work.createdBy,
      createdAt: work.createdAt,
      reviewedAt: work.reviewedAt,
      activityAt: workActivity.get(workId) ?? work.createdAt,
      editionCount: editionCounts.get(workId) ?? 0,
      linkedBookCount: linkedCounts.get(workId) ?? 0,
      warnings: workWarnings.get(workId) ?? [],
    })),
    editions: [...editionById].map(([editionId, edition]) => ({
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
      createdBy: edition.createdBy,
      createdAt: edition.createdAt,
    })),
    books,
    findings,
  };
}
