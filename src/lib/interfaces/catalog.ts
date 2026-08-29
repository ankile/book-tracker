import type { Timestamp } from 'firebase/firestore';

export type WorkVisibility = 'internal' | 'searchable';
export type WorkStatus = 'active' | 'merged';
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

export interface WorkDocument {
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
  mergedFrom?: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Work extends WorkDocument {
  id: string;
}

export interface WorkTitleIndexEntry {
  workId: string;
  title: string;
  titleKey: string;
  visibility: WorkVisibility;
}

export interface EditionDocument {
  workId: string;
  isbn13: string | null;
  title: string;
  authorNames: string[];
  publisher: string;
  publishedDate: string;
  language: string;
  translatorNames: string[];
  format: EditionFormat;
  suggestedPageCount: number | null;
  coverUrl: string;
  externalIds: Record<string, string>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Edition extends EditionDocument {
  id: string;
}

export interface IsbnIndexEntry {
  workId: string;
  editionId: string;
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
  authorNames: string[];
  coverUrl: string;
  mergedFrom: string[];
}

export interface CatalogEditionSummary {
  editionId: string;
  workId: string;
  isbn13: string | null;
  title: string;
  authorNames: string[];
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

export interface CatalogWorkInput {
  canonicalTitle: string;
  alternateTitles: string[];
  authorNames: string[];
  coverUrl: string;
  subjects: string[];
  fiction: boolean | null;
}

export interface CatalogEditionInput {
  isbn13: string | null;
  title: string;
  authorNames: string[];
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
  username: string;
  displayName: string;
  status: 'reading' | 'finished';
  pageCount: number;
  editionIsbn13: string | null;
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

export interface AdminCatalogWorkRow {
  workId: string;
  canonicalTitle: string;
  alternateTitles: string[];
  authorNames: string[];
  coverUrl: string;
  subjects: string[];
  fiction: boolean | null;
  visibility: WorkVisibility;
  status: WorkStatus;
  mergedInto: string | null;
  mergedFrom: string[];
  updatedAt: number;
  editionCount: number;
  linkedBookCount: number;
  warnings: string[];
}

export interface AdminCatalogEditionRow extends Omit<CatalogEditionInput, 'externalIds'> {
  editionId: string;
  workId: string;
  externalIds: Record<string, string>;
  updatedAt: number;
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
  pageCount: number;
  publisher: string;
  publishedDate: string;
  coverUrl: string;
  workId: string | null;
  editionId: string | null;
  matchMethod: CatalogMatchMethod | null;
  linkedAt: number | null;
  createdAt: number;
  updatedAt: number;
  anomaly: string | null;
}

export interface AdminCatalogFinding {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  workIds: string[];
  editionIds: string[];
  books: AdminCatalogBookTarget[];
}

export interface AdminCatalogLimits {
  works: number;
  editions: number;
  books: number;
  isbnIndexes: number;
  externalIdIndexes: number;
  authors: number;
}

export interface AdminCatalogScanResponse {
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
    type: 'createWork';
    workId: string;
    visibility: WorkVisibility;
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
    visibility: WorkVisibility;
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
  kind: 'work' | 'edition' | 'isbn' | 'external-id' | 'title-index';
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
  kind: 'work' | 'edition' | 'isbn' | 'external-id' | 'book' | 'title-index';
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
