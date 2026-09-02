import type { Timestamp } from 'firebase/firestore';

// 'hidden' is the admin soft delete: the work and every link to it stay,
// search and reader pages leave it out.
export type WorkStatus = 'active' | 'merged' | 'hidden';
export type CatalogAuthorKind = 'person' | 'entity' | 'placeholder';
export type CatalogAuthorStatus = 'active' | 'merged';
export type EditionFormat = 'full' | 'abridged' | 'revised' | 'unknown';
export type CatalogMatchMethod =
  | 'isbn'
  | 'external-id'
  | 'catalog-choice'
  | 'migration'
  | 'admin';

export interface CatalogLink {
  workId: string | null;
  editionId: string | null;
  matchMethod: CatalogMatchMethod | null;
  linkedAt: Timestamp | null;
}

export interface CatalogAuthorSummary {
  authorId: string;
  canonicalName: string;
  sortName: string;
  kind: CatalogAuthorKind;
}

export interface CatalogSelection {
  workId: string;
  editionId: string | null;
  matchMethod: Extract<CatalogMatchMethod, 'isbn' | 'external-id' | 'catalog-choice'>;
}

export interface CatalogSearchRequest {
  isbn13?: string;
  title?: string;
  authorNames?: string[];
  externalId?: {provider: string; id: string};
}

export interface CatalogWorkSummary {
  workId: string;
  canonicalTitle: string;
  alternateTitles: string[];
  authors: CatalogAuthorSummary[];
  coverUrl: string;
  subjects: string[];
  fiction: boolean | null;
  mergedFrom: string[];
}

export interface CatalogEditionSummary {
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
}

export interface CatalogSearchResult {
  workId: string;
  editionId: string | null;
  confidence: 'exact-edition' | 'strong-work' | 'possible-work';
  reason: string;
  work: CatalogWorkSummary;
  edition: CatalogEditionSummary | null;
}

export interface CatalogSearchResponse {
  results: CatalogSearchResult[];
}

export interface CatalogCreateRequest {
  work: CatalogWorkInput;
  edition: CatalogEditionInput;
}

export interface CatalogCreateResponse {
  workId: string;
  editionId: string;
  created: boolean;
}

// Adds an edition to a work the catalog already has, for a book whose
// chosen work had no matching edition.
export interface CatalogAddEditionRequest {
  workId: string;
  edition: CatalogEditionInput;
}

export type CatalogAddEditionResponse = CatalogCreateResponse;

export interface CatalogWorkInput {
  canonicalTitle: string;
  alternateTitles: string[];
  authorIds: string[];
  coverUrl: string;
  subjects: string[];
  fiction: boolean | null;
}

export interface CatalogAuthorInput {
  canonicalName: string;
  alternateNames: string[];
  sortName: string;
  kind: CatalogAuthorKind;
}

export interface CatalogAuthorCreateInput {
  canonicalName: string;
  sortName: string;
  kind: CatalogAuthorKind;
}

export interface EnsureCatalogAuthorsRequest {
  authors: CatalogAuthorCreateInput[];
}

export interface EnsureCatalogAuthorsResponse {
  authorIds: string[];
}

export interface CatalogEditionInput {
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
}

export interface WorkReadersRequest {
  workId: string;
  cursor?: string | null;
}

export interface WorkReaderAttemptSummary {
  // One key per reader: the username when a public profile names them,
  // otherwise an opaque key the server derives, so rereads still group.
  readerKey: string;
  username: string | null;
  displayName: string | null;
  status: 'reading' | 'finished';
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

export interface WorkReadersResponse {
  work: CatalogWorkSummary;
  editions: CatalogEditionSummary[];
  attempts: WorkReaderAttemptSummary[];
  incomplete: boolean;
  omittedAttempts: number;
  nextCursor: string | null;
}

// The scan rows, finding shape and codes are the shared scan's
// (shared/catalogScan.ts): the browser computes them from live listeners.
export type {
  AdminCatalogAuthorRow,
  AdminCatalogBookRow,
  AdminCatalogBookTarget,
  AdminCatalogEditionRow,
  AdminCatalogFinding,
  AdminCatalogFindingCode,
  AdminCatalogWorkRow,
  CatalogScan,
} from '../../../shared/catalogScan.ts';
import type { AdminCatalogBookTarget } from '../../../shared/catalogScan.ts';

export type AdminCatalogOperation =
  | {
    type: 'upsertAuthor';
    authorId: string;
    author: CatalogAuthorInput;
  }
  | {
    type: 'mergeAuthors';
    sourceAuthorId: string;
    targetAuthorId: string;
  }
  | {
    type: 'createWork';
    workId: string;
    status: 'active' | 'hidden';
    work: CatalogWorkInput;
    books: AdminCatalogBookTarget[];
  }
  | {
    type: 'linkBooks';
    books: AdminCatalogBookTarget[];
    target: null | {workId: string; editionId: string | null};
  }
  | {
    type: 'mergeWorks';
    sourceWorkIds: string[];
    targetWorkId: string;
  }
  | {
    type: 'mergeEditions';
    workId: string;
    sourceEditionIds: string[];
    targetEditionId: string;
  }
  | {
    type: 'editWork';
    workId: string;
    status: 'active' | 'hidden';
    work: CatalogWorkInput;
  }
  | {
    type: 'upsertEdition';
    editionId: string;
    workId: string;
    edition: CatalogEditionInput;
  }
  | {
    type: 'repointIsbn';
    isbn13: string;
    editionId: string;
  };

export interface AdminCatalogExpectedDocument {
  kind: 'author' | 'work' | 'edition' | 'isbn' | 'external-id' | 'title-index';
  id: string;
  exists: boolean;
  updatedAt: number | null;
}

export interface AdminCatalogExpectedBook extends AdminCatalogBookTarget {
  workId: string | null;
  editionId: string | null;
  matchMethod: CatalogMatchMethod | null;
  linkedAt: number | null;
  decisionIsbn13: string | null;
}

export interface AdminCatalogExpectedState {
  catalog: AdminCatalogExpectedDocument[];
  books: AdminCatalogExpectedBook[];
}

export type AdminCatalogDiffValue = Record<string, unknown> | null;

export interface AdminCatalogChange {
  kind: 'author' | 'work' | 'edition' | 'isbn' | 'external-id' | 'book' | 'title-index';
  id: string;
  action: 'create' | 'update' | 'delete';
  before: AdminCatalogDiffValue;
  after: AdminCatalogDiffValue;
}

export interface AdminCatalogPreviewRequest {
  operation: AdminCatalogOperation;
}

export interface AdminCatalogPreviewResponse {
  operationId: string;
  operationHash: string;
  expected: AdminCatalogExpectedState;
  changes: AdminCatalogChange[];
  touchedDocuments: number;
}

export interface AdminCatalogApplyRequest {
  operationId: string;
  operation: AdminCatalogOperation;
  expected: AdminCatalogExpectedState;
}

export interface AdminCatalogApplyResponse {
  operationId: string;
  applied: true;
  touchedDocuments: number;
}

// admin.review: mark works or authors reviewed (or not). One console page
// of ids per call.
export interface AdminReviewRequest {
  kind: 'work' | 'author';
  ids: string[];
  reviewed: boolean;
}

export interface AdminReviewResponse {
  updated: number;
}
