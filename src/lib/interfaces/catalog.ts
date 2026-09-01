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

// The scan rows carry what the curation console renders or prefills a form
// with, and nothing else.
export interface AdminCatalogWorkRow {
  workId: string;
  canonicalTitle: string;
  alternateTitles: string[];
  authorIds: string[];
  coverUrl: string;
  subjects: string[];
  fiction: boolean | null;
  status: WorkStatus;
  mergedFrom: string[];
  // uid of the user who created the work through the add-book flow; null
  // for migration- or admin-created works. Newest first on the admin page.
  createdBy: string | null;
  createdAt: number;
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
  mergedFrom: string[];
  workCount: number;
  warnings: string[];
}

export interface AdminCatalogEditionRow extends Omit<CatalogEditionInput, 'externalIds'> {
  editionId: string;
  workId: string;
  externalIds: Record<string, string>;
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
  anomaly: string | null;
}

// The codes the scan emits (functions/src/adminCatalog.ts). Decoding them as
// a union is what makes an unlabelled code a decode failure instead of a
// blank cell.
export type AdminCatalogFindingCode =
  | 'book-row-anomaly'
  | 'book-link-anomaly'
  | 'unmatched-isbn-candidate'
  | 'unmatched-title-author-candidate'
  | 'likely-title-author-candidate'
  | 'edition-missing-work'
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

export interface AdminCatalogLimits {
  catalogAuthors: number;
  works: number;
  books: number;
}

export interface AdminCatalogScanResponse {
  authors: AdminCatalogAuthorRow[];
  works: AdminCatalogWorkRow[];
  editions: AdminCatalogEditionRow[];
  books: AdminCatalogBookRow[];
  nextBookCursor: string | null;
  bookCountsComplete: boolean;
  findings: AdminCatalogFinding[];
  limits: AdminCatalogLimits;
}

export interface AdminCatalogScanRequest {
  bookCursor?: string | null;
}

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
