import { FunctionsError } from 'firebase/functions';
import { externalIndexDigestInput } from '../../../shared/catalogIdentity.ts';
import type {
  AdminCatalogApplyResponse,
  AdminCatalogBookRow,
  AdminCatalogBookTarget,
  AdminCatalogChange,
  AdminCatalogExpectedBook,
  AdminCatalogExpectedDocument,
  AdminCatalogExpectedState,
  AdminCatalogPreviewResponse,
  CatalogMatchMethod,
  CatalogScan,
} from '../interfaces/catalog.ts';
import {
  boolean,
  type Data,
  exactKeys,
  finiteNumber,
  integer,
  nonEmptyString,
  nullableNumber,
  nullableString,
  record,
} from './decodePrimitives.ts';

function nonNegativeInteger(value: unknown, context: string): number {
  const decoded = integer(value, context);
  if (decoded < 0) throw new TypeError(`${context}: expected a non-negative integer`);
  return decoded;
}

function array<T>(value: unknown, context: string, decode: (entry: unknown, context: string) => T): T[] {
  if (!Array.isArray(value)) throw new TypeError(`${context}: expected an array`);
  return value.map((entry, index) => decode(entry, `${context}[${index}]`));
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

// The externalIdIndex document id, computed the way the server computes it
// (functions/src/catalog.ts externalIndexId) so the live scan can check
// every index row against its own provider and external id.
export async function externalIndexId(provider: string, id: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(externalIndexDigestInput(provider, id)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface AdminCatalogCandidate {
  workId: string;
  editionId: string | null;
  label: 'Exact ISBN' | 'Exact title and author' | 'Possible title and author';
  title: string;
}

export function adminCatalogCandidatesForBook(
  scan: Pick<CatalogScan, 'findings' | 'works'>,
  book: AdminCatalogBookTarget,
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

// Candidates for every unmatched book in one pass over the findings, so the
// page does not rescan the finding list per row on every render.
export function adminCatalogCandidatesByBook(
  scan: Pick<CatalogScan, 'findings' | 'works' | 'books'>,
): Map<string, AdminCatalogCandidate[]> {
  return new Map(scan.books
    .filter((book: AdminCatalogBookRow) => book.workId === null)
    .map((book) => [`${book.uid}/${book.bookId}`, adminCatalogCandidatesForBook(scan, book)]));
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
