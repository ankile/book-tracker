import { FunctionsError } from 'firebase/functions';
import type {
  AdminCatalogApplyResponse,
  AdminCatalogAuthorRow,
  AdminCatalogBookRow,
  AdminCatalogBookTarget,
  AdminCatalogChange,
  AdminCatalogEditionRow,
  AdminCatalogExpectedBook,
  AdminCatalogExpectedDocument,
  AdminCatalogExpectedState,
  AdminCatalogFinding,
  AdminCatalogFindingCode,
  AdminCatalogLimits,
  AdminCatalogPreviewResponse,
  AdminCatalogScanResponse,
  AdminCatalogWorkRow,
  CatalogAuthorStatus,
  CatalogMatchMethod,
  WorkStatus,
} from '../interfaces/catalog.ts';
import {
  boolean,
  type Data,
  editionFormat,
  exactKeys,
  finiteNumber,
  integer,
  nonEmptyString,
  nullableNumber,
  nullableString,
  record,
  string,
  strings,
} from './decodePrimitives.ts';

function nonNegativeInteger(value: unknown, context: string): number {
  const decoded = integer(value, context);
  if (decoded < 0) throw new TypeError(`${context}: expected a non-negative integer`);
  return decoded;
}

function positiveInteger(value: unknown, context: string): number {
  const decoded = integer(value, context);
  if (decoded <= 0) throw new TypeError(`${context}: expected a positive integer`);
  return decoded;
}

function array<T>(value: unknown, context: string, decode: (entry: unknown, context: string) => T): T[] {
  if (!Array.isArray(value)) throw new TypeError(`${context}: expected an array`);
  return value.map((entry, index) => decode(entry, `${context}[${index}]`));
}

function workStatus(value: unknown, context: string): WorkStatus {
  if (value !== 'active' && value !== 'merged' && value !== 'hidden') {
    throw new TypeError(`${context}: expected active, merged or hidden`);
  }
  return value;
}

function authorStatus(value: unknown, context: string): CatalogAuthorStatus {
  if (value !== 'active' && value !== 'merged') {
    throw new TypeError(`${context}: expected active or merged`);
  }
  return value;
}

function decodeAuthor(value: unknown, context: string): AdminCatalogAuthorRow {
  const data = record(value, context);
  exactKeys(data, [
    'authorId', 'canonicalName', 'alternateNames', 'sortName',
    'kind', 'status', 'mergedFrom', 'workCount', 'warnings',
  ], context);
  if (data.kind !== 'person' && data.kind !== 'entity' && data.kind !== 'placeholder') {
    throw new TypeError(`${context}.kind: expected a supported catalog author kind`);
  }
  return {
    authorId: nonEmptyString(data.authorId, `${context}.authorId`),
    canonicalName: nonEmptyString(data.canonicalName, `${context}.canonicalName`),
    alternateNames: strings(data.alternateNames, `${context}.alternateNames`),
    sortName: nonEmptyString(data.sortName, `${context}.sortName`),
    kind: data.kind,
    status: authorStatus(data.status, `${context}.status`),
    mergedFrom: strings(data.mergedFrom, `${context}.mergedFrom`),
    workCount: nonNegativeInteger(data.workCount, `${context}.workCount`),
    warnings: strings(data.warnings, `${context}.warnings`),
  };
}

function catalogMatchMethod(value: unknown, context: string): CatalogMatchMethod | null {
  if (value === null) return null;
  if (
    value !== 'isbn' && value !== 'external-id' && value !== 'catalog-choice' &&
    value !== 'migration' && value !== 'admin'
  ) {
    throw new TypeError(`${context}: expected a catalog match method or null`);
  }
  return value;
}

function nullableBoolean(value: unknown, context: string): boolean | null {
  return value === null ? null : boolean(value, context);
}

function stringRecord(value: unknown, context: string): Record<string, string> {
  const data = record(value, context);
  return Object.fromEntries(Object.entries(data).map(([key, entry]) => [
    key,
    string(entry, `${context}.${key}`),
  ]));
}

function jsonValue(value: unknown, context: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return finiteNumber(value, context);
  if (Array.isArray(value)) return value.map((entry, index) => jsonValue(entry, `${context}[${index}]`));
  const data = record(value, context);
  return Object.fromEntries(Object.entries(data).map(([key, entry]) => [
    key,
    jsonValue(entry, `${context}.${key}`),
  ]));
}

function jsonObject(value: unknown, context: string): Record<string, unknown> | null {
  if (value === null) return null;
  return jsonValue(record(value, context), context) as Record<string, unknown>;
}

function decodeBookTarget(value: unknown, context: string): AdminCatalogBookTarget {
  const data = record(value, context);
  exactKeys(data, ['uid', 'bookId'], context);
  return {
    uid: nonEmptyString(data.uid, `${context}.uid`),
    bookId: nonEmptyString(data.bookId, `${context}.bookId`),
  };
}

function decodeWork(value: unknown, context: string): AdminCatalogWorkRow {
  const data = record(value, context);
  exactKeys(data, [
    'workId', 'canonicalTitle', 'alternateTitles', 'authorIds', 'coverUrl', 'subjects',
    'fiction', 'status', 'mergedFrom', 'createdBy', 'createdAt',
    'editionCount', 'linkedBookCount', 'warnings',
  ], context);
  return {
    workId: nonEmptyString(data.workId, `${context}.workId`),
    canonicalTitle: nonEmptyString(data.canonicalTitle, `${context}.canonicalTitle`),
    alternateTitles: strings(data.alternateTitles, `${context}.alternateTitles`),
    authorIds: strings(data.authorIds, `${context}.authorIds`),
    coverUrl: string(data.coverUrl, `${context}.coverUrl`),
    subjects: strings(data.subjects, `${context}.subjects`),
    fiction: nullableBoolean(data.fiction, `${context}.fiction`),
    status: workStatus(data.status, `${context}.status`),
    mergedFrom: strings(data.mergedFrom, `${context}.mergedFrom`),
    createdBy: nullableString(data.createdBy, `${context}.createdBy`),
    createdAt: finiteNumber(data.createdAt, `${context}.createdAt`),
    editionCount: nonNegativeInteger(data.editionCount, `${context}.editionCount`),
    linkedBookCount: nonNegativeInteger(data.linkedBookCount, `${context}.linkedBookCount`),
    warnings: strings(data.warnings, `${context}.warnings`),
  };
}

function decodeEdition(value: unknown, context: string): AdminCatalogEditionRow {
  const data = record(value, context);
  exactKeys(data, [
    'editionId', 'workId', 'isbn13', 'title', 'publisher', 'publishedDate',
    'language', 'translatorNames', 'format', 'suggestedPageCount', 'coverUrl',
    'externalIds',
  ], context);
  const suggestedPageCount = nullableNumber(data.suggestedPageCount, `${context}.suggestedPageCount`);
  if (suggestedPageCount !== null && (!Number.isSafeInteger(suggestedPageCount) || suggestedPageCount <= 0)) {
    throw new TypeError(`${context}.suggestedPageCount: expected a positive safe integer or null`);
  }
  return {
    editionId: nonEmptyString(data.editionId, `${context}.editionId`),
    workId: nonEmptyString(data.workId, `${context}.workId`),
    isbn13: nullableString(data.isbn13, `${context}.isbn13`),
    title: nonEmptyString(data.title, `${context}.title`),
    publisher: string(data.publisher, `${context}.publisher`),
    publishedDate: string(data.publishedDate, `${context}.publishedDate`),
    language: string(data.language, `${context}.language`),
    translatorNames: strings(data.translatorNames, `${context}.translatorNames`),
    format: editionFormat(data.format, `${context}.format`),
    suggestedPageCount,
    coverUrl: string(data.coverUrl, `${context}.coverUrl`),
    externalIds: stringRecord(data.externalIds, `${context}.externalIds`),
  };
}

function decodeBook(value: unknown, context: string): AdminCatalogBookRow {
  const data = record(value, context);
  exactKeys(data, [
    'uid', 'bookId', 'title', 'authorNames', 'isbn13', 'rawIsbn', 'pageCount',
    'publisher', 'coverUrl', 'workId', 'editionId', 'anomaly',
  ], context);
  const target = decodeBookTarget({uid: data.uid, bookId: data.bookId}, `${context}.target`);
  const pageCount = nullableNumber(data.pageCount, `${context}.pageCount`);
  if (pageCount !== null && (!Number.isSafeInteger(pageCount) || pageCount <= 0)) {
    throw new TypeError(`${context}.pageCount: expected a positive safe integer or null`);
  }
  return {
    ...target,
    title: nonEmptyString(data.title, `${context}.title`),
    authorNames: strings(data.authorNames, `${context}.authorNames`),
    isbn13: nullableString(data.isbn13, `${context}.isbn13`),
    rawIsbn: nullableString(data.rawIsbn, `${context}.rawIsbn`),
    pageCount,
    publisher: string(data.publisher, `${context}.publisher`),
    coverUrl: string(data.coverUrl, `${context}.coverUrl`),
    workId: nullableString(data.workId, `${context}.workId`),
    editionId: nullableString(data.editionId, `${context}.editionId`),
    anomaly: nullableString(data.anomaly, `${context}.anomaly`),
  };
}

const FINDING_CODES: readonly AdminCatalogFindingCode[] = [
  'book-row-anomaly', 'book-link-anomaly', 'unmatched-isbn-candidate',
  'unmatched-title-author-candidate', 'likely-title-author-candidate',
  'edition-missing-work', 'isbn-index-mismatch', 'external-id-index-mismatch',
  'work-invariant', 'duplicate-author-name', 'suspected-duplicate-works',
];

function findingCode(value: unknown, context: string): AdminCatalogFindingCode {
  const code = nonEmptyString(value, context);
  if (!FINDING_CODES.includes(code as AdminCatalogFindingCode)) {
    throw new TypeError(`${context}: expected a known catalog finding code`);
  }
  return code as AdminCatalogFindingCode;
}

function decodeFinding(value: unknown, context: string): AdminCatalogFinding {
  const data = record(value, context);
  exactKeys(data, ['code', 'severity', 'message', 'workIds', 'editionIds', 'books'], context);
  if (data.severity !== 'error' && data.severity !== 'warning') {
    throw new TypeError(`${context}.severity: expected error or warning`);
  }
  return {
    code: findingCode(data.code, `${context}.code`),
    severity: data.severity,
    message: nonEmptyString(data.message, `${context}.message`),
    workIds: strings(data.workIds, `${context}.workIds`),
    editionIds: strings(data.editionIds, `${context}.editionIds`),
    books: array(data.books, `${context}.books`, decodeBookTarget),
  };
}

function decodeLimits(value: unknown, context: string): AdminCatalogLimits {
  const data = record(value, context);
  exactKeys(data, ['catalogAuthors', 'works', 'books'], context);
  return {
    catalogAuthors: positiveInteger(data.catalogAuthors, `${context}.catalogAuthors`),
    works: positiveInteger(data.works, `${context}.works`),
    books: positiveInteger(data.books, `${context}.books`),
  };
}

export function decodeAdminCatalogScanResponse(value: unknown): AdminCatalogScanResponse {
  const data = record(value, 'admin-catalogscan response');
  exactKeys(data, [
    'authors', 'works', 'editions', 'books', 'nextBookCursor', 'bookCountsComplete',
    'findings', 'limits',
  ], 'admin-catalogscan response');
  return {
    authors: array(data.authors, 'admin-catalogscan response.authors', decodeAuthor),
    works: array(data.works, 'admin-catalogscan response.works', decodeWork),
    editions: array(data.editions, 'admin-catalogscan response.editions', decodeEdition),
    books: array(data.books, 'admin-catalogscan response.books', decodeBook),
    nextBookCursor: nullableString(data.nextBookCursor, 'admin-catalogscan response.nextBookCursor'),
    bookCountsComplete: boolean(data.bookCountsComplete, 'admin-catalogscan response.bookCountsComplete'),
    findings: array(data.findings, 'admin-catalogscan response.findings', decodeFinding),
    limits: decodeLimits(data.limits, 'admin-catalogscan response.limits'),
  };
}

export interface AdminCatalogCandidate {
  workId: string;
  editionId: string | null;
  label: 'Exact ISBN' | 'Exact title and author' | 'Possible title and author';
  title: string;
}

export function adminCatalogCandidatesForBook(
  scan: AdminCatalogScanResponse,
  book: AdminCatalogBookRow,
): AdminCatalogCandidate[] {
  const labels = {
    'unmatched-isbn-candidate': 'Exact ISBN',
    'unmatched-title-author-candidate': 'Exact title and author',
    'likely-title-author-candidate': 'Possible title and author',
  } as const;
  const rank = new Map(Object.keys(labels).map((code, index) => [code, index]));
  const candidates = new Map<string, AdminCatalogCandidate & {rank: number}>();
  for (const finding of scan.findings) {
    if (finding.code !== 'unmatched-isbn-candidate' &&
        finding.code !== 'unmatched-title-author-candidate' &&
        finding.code !== 'likely-title-author-candidate') continue;
    const candidateRank = rank.get(finding.code);
    if (candidateRank === undefined || !finding.books.some(
      (target) => target.uid === book.uid && target.bookId === book.bookId,
    )) continue;
    for (const candidateWorkId of finding.workIds) {
      const work = scan.works.find((row) => row.workId === candidateWorkId);
      if (work === undefined) continue;
      const existing = candidates.get(candidateWorkId);
      if (existing !== undefined && existing.rank <= candidateRank) continue;
      candidates.set(candidateWorkId, {
        workId: candidateWorkId,
        editionId: finding.code === 'unmatched-isbn-candidate' &&
          finding.editionIds.length === 1 ? finding.editionIds[0] : null,
        label: labels[finding.code],
        title: work.canonicalTitle,
        rank: candidateRank,
      });
    }
  }
  return [...candidates.values()]
    .sort((left, right) => left.rank - right.rank || left.title.localeCompare(right.title))
    .map(({rank: _rank, ...candidate}) => candidate);
}

function decodeExpectedDocument(value: unknown, context: string): AdminCatalogExpectedDocument {
  const data = record(value, context);
  exactKeys(data, ['kind', 'id', 'exists', 'updatedAt'], context);
  if (data.kind !== 'author' && data.kind !== 'work' && data.kind !== 'edition' && data.kind !== 'isbn' &&
      data.kind !== 'external-id' && data.kind !== 'title-index') {
    throw new TypeError(`${context}.kind: expected a versioned catalog document kind`);
  }
  return {
    kind: data.kind,
    id: nonEmptyString(data.id, `${context}.id`),
    exists: boolean(data.exists, `${context}.exists`),
    updatedAt: nullableNumber(data.updatedAt, `${context}.updatedAt`),
  };
}

function decodeExpectedBook(value: unknown, context: string): AdminCatalogExpectedBook {
  const data = record(value, context);
  exactKeys(data, [
    'uid', 'bookId', 'workId', 'editionId', 'matchMethod', 'linkedAt',
    'decisionIsbn13',
  ], context);
  return {
    ...decodeBookTarget({uid: data.uid, bookId: data.bookId}, `${context}.target`),
    workId: nullableString(data.workId, `${context}.workId`),
    editionId: nullableString(data.editionId, `${context}.editionId`),
    matchMethod: catalogMatchMethod(data.matchMethod, `${context}.matchMethod`),
    linkedAt: nullableNumber(data.linkedAt, `${context}.linkedAt`),
    decisionIsbn13: nullableString(data.decisionIsbn13, `${context}.decisionIsbn13`),
  };
}

function decodeExpected(value: unknown, context: string): AdminCatalogExpectedState {
  const data = record(value, context);
  exactKeys(data, ['catalog', 'books'], context);
  return {
    catalog: array(data.catalog, `${context}.catalog`, decodeExpectedDocument),
    books: array(data.books, `${context}.books`, decodeExpectedBook),
  };
}

function decodeChange(value: unknown, context: string): AdminCatalogChange {
  const data = record(value, context);
  exactKeys(data, ['kind', 'id', 'action', 'before', 'after'], context);
  if (
    data.kind !== 'author' && data.kind !== 'work' && data.kind !== 'edition' && data.kind !== 'isbn' &&
    data.kind !== 'external-id' &&
    data.kind !== 'book' && data.kind !== 'title-index'
  ) {
    throw new TypeError(`${context}.kind: expected a catalog change kind`);
  }
  if (data.action !== 'create' && data.action !== 'update' && data.action !== 'delete') {
    throw new TypeError(`${context}.action: expected create, update, or delete`);
  }
  return {
    kind: data.kind,
    id: nonEmptyString(data.id, `${context}.id`),
    action: data.action,
    before: jsonObject(data.before, `${context}.before`),
    after: jsonObject(data.after, `${context}.after`),
  };
}

export function decodeAdminCatalogPreviewResponse(value: unknown): AdminCatalogPreviewResponse {
  const data = record(value, 'admin-catalogpreview response');
  exactKeys(
    data,
    ['operationId', 'operationHash', 'expected', 'changes', 'touchedDocuments'],
    'admin-catalogpreview response',
  );
  return {
    operationId: nonEmptyString(data.operationId, 'admin-catalogpreview response.operationId'),
    operationHash: nonEmptyString(data.operationHash, 'admin-catalogpreview response.operationHash'),
    expected: decodeExpected(data.expected, 'admin-catalogpreview response.expected'),
    changes: array(data.changes, 'admin-catalogpreview response.changes', decodeChange),
    touchedDocuments: nonNegativeInteger(
      data.touchedDocuments,
      'admin-catalogpreview response.touchedDocuments',
    ),
  };
}

export function decodeAdminCatalogApplyResponse(value: unknown): AdminCatalogApplyResponse {
  const data = record(value, 'admin-catalogapply response');
  exactKeys(data, ['operationId', 'applied', 'touchedDocuments'], 'admin-catalogapply response');
  if (data.applied !== true) throw new TypeError('admin-catalogapply response.applied: expected true');
  return {
    operationId: nonEmptyString(data.operationId, 'admin-catalogapply response.operationId'),
    applied: true,
    touchedDocuments: nonNegativeInteger(
      data.touchedDocuments,
      'admin-catalogapply response.touchedDocuments',
    ),
  };
}

export type AdminCatalogFailure =
  | {kind: 'recent-auth-required'; maxAgeSeconds: number}
  | {kind: 'stale-preview'}
  | {kind: 'operation-too-large'; maxTouchedDocuments: number}
  | {kind: 'catalog-capacity'; collection: string; maximum: number}
  | {kind: 'catalog-invariant'}
  | {kind: 'identifier-conflict'}
  | {kind: 'unknown'};

export function classifyAdminCatalogFailure(error: unknown): AdminCatalogFailure {
  if (!(error instanceof FunctionsError)) return {kind: 'unknown'};
  if (typeof error.details !== 'object' || error.details === null || Array.isArray(error.details)) {
    return {kind: 'unknown'};
  }
  const details = error.details as Data;
  if (error.code === 'functions/failed-precondition' && details.reason === 'recent-auth-required' &&
      Number.isSafeInteger(details.maxAgeSeconds) && Number(details.maxAgeSeconds) > 0) {
    return {kind: 'recent-auth-required', maxAgeSeconds: Number(details.maxAgeSeconds)};
  }
  if (error.code === 'functions/aborted' && details.reason === 'stale-preview') {
    return {kind: 'stale-preview'};
  }
  if (error.code === 'functions/resource-exhausted' && details.reason === 'operation-too-large' &&
      Number.isSafeInteger(details.maxTouchedDocuments) && Number(details.maxTouchedDocuments) > 0) {
    return {kind: 'operation-too-large', maxTouchedDocuments: Number(details.maxTouchedDocuments)};
  }
  if (error.code === 'functions/resource-exhausted' && details.reason === 'catalog-capacity' &&
      typeof details.collection === 'string' && details.collection.length > 0 &&
      Number.isSafeInteger(details.maximum) && Number(details.maximum) > 0) {
    return {
      kind: 'catalog-capacity',
      collection: details.collection,
      maximum: Number(details.maximum),
    };
  }
  if (error.code === 'functions/failed-precondition' && details.reason === 'catalog-invariant') {
    return {kind: 'catalog-invariant'};
  }
  if (error.code === 'functions/failed-precondition' && details.reason === 'identifier-conflict') {
    return {kind: 'identifier-conflict'};
  }
  return {kind: 'unknown'};
}

export function parseAdminBookTargets(value: string): AdminCatalogBookTarget[] {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.split('/');
    if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
      throw new TypeError(`Expected one uid/bookId pair per line; got "${line}".`);
    }
    return {uid: parts[0], bookId: parts[1]};
  });
}

export function parseAdminStringList(value: string): string[] {
  return [...new Set(value.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean))];
}

export function parseAdminExternalIds(value: string): Record<string, string> {
  return Object.fromEntries(parseAdminStringList(value).map((line) => {
    const separator = line.indexOf('=');
    if (separator <= 0 || separator === line.length - 1) {
      throw new TypeError(`Expected one provider=id pair per line; got "${line}".`);
    }
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
}
