import { FunctionsError } from 'firebase/functions';
import {
  externalIndexDigestInput,
  normalizeCatalogIdentity,
} from '../../../shared/catalogIdentity.ts';
import type {
  AdminCatalogApplyResponse,
  AdminCatalogBookRow,
  AdminCatalogBookTarget,
  AdminReviewResponse,
  CatalogScan,
} from '../interfaces/catalog.ts';
import {
  type Data,
  exactKeys,
  integer,
  nonEmptyString,
  record,
} from './decodePrimitives.ts';

function nonNegativeInteger(value: unknown, context: string): number {
  const decoded = integer(value, context);
  if (decoded < 0) throw new TypeError(`${context}: expected a non-negative integer`);
  return decoded;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// The externalIdIndex document id, computed the way the server computes it
// (functions/src/catalog.ts externalIndexId) so the live scan can check
// every index row against its own provider and external id.
export async function externalIndexId(provider: string, id: string): Promise<string> {
  return sha256Hex(externalIndexDigestInput(provider, id));
}

// The id catalog.ensureauthors mints for a new author (functions/src/catalog.ts
// catalogAuthorId): "author_" and the first 24 hex digits of the SHA-256 of
// "author\0" + the normalized canonical name. The console derives it for an
// author it creates so a reader who later adds the same name lands on that
// document instead of minting a duplicate.
export async function catalogAuthorIdFor(canonicalName: string): Promise<string> {
  const digest = await sha256Hex(`author\0${normalizeCatalogIdentity(canonicalName)}`);
  return `author_${digest.slice(0, 24)}`;
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

export function decodeAdminReviewResponse(value: unknown): AdminReviewResponse {
  const data = record(value, 'admin-review response');
  exactKeys(data, ['updated'], 'admin-review response');
  return { updated: nonNegativeInteger(data.updated, 'admin-review response.updated') };
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
