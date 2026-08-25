import type { DocumentReference, Timestamp } from 'firebase/firestore';
import type { LegacyEmbeddedAuthor } from './author.ts';
import type { BookMetadata } from './metadata.ts';

// A normalized users/{uid}/books doc returned by the Firestore decoder.
// Legacy stored shapes are repaired at that boundary before application
// code sees this model.
export interface LocalActiveTimer {
  start: string;
  entryId?: undefined;
}

export interface TogglActiveTimer {
  start: string;
  entryId: number;
}

export interface StartingTogglTimer {
  state: 'starting';
  operationId: string;
  start: string;
  claimedAt: Timestamp;
}

export interface UnknownTogglTimerOutcome {
  state: 'outcome-unknown';
  operationId: string;
  start: string;
  claimedAt: Timestamp;
  error: string;
}

export type ActiveTimer =
  | LocalActiveTimer
  | TogglActiveTimer
  | StartingTogglTimer
  | UnknownTogglTimerOutcome;

interface BookBase extends BookMetadata {
  id: string;
  currentPage: number;
  // The update-row id that most recently set currentPage. Missing/null is a
  // documented legacy state: progress can be displayed but no historical
  // session can safely claim ownership of it.
  currentPageUpdateId?: string | null;
  pageCount: number;
  pagesRead: number;
  timeRead: number;
  title: string;
  finished: boolean;
  isbn: string;
  owner: DocumentReference;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  activeTimer: ActiveTimer | null;
}

export interface CurrentBook extends BookBase {
  authorIds: string[];
  author?: never;
  authors?: never;
}

interface LegacyBookBase extends BookBase {
  // An old writer may leave stale ids beside the legacy fields. The legacy
  // fields remain authoritative until the reconciliation migration runs.
  authorIds?: string[];
}

export interface LegacyStringAuthorBook extends LegacyBookBase {
  author: string;
  authors?: LegacyEmbeddedAuthor[];
}

export interface LegacyEmbeddedAuthorsBook extends LegacyBookBase {
  author?: string;
  authors: LegacyEmbeddedAuthor[];
}

export type Book = CurrentBook | LegacyStringAuthorBook | LegacyEmbeddedAuthorsBook;

export function hasCurrentAuthorship(book: Book): book is CurrentBook {
  return book.author === undefined && book.authors === undefined;
}

export function isTogglTimer(timer: ActiveTimer): timer is TogglActiveTimer {
  return 'entryId' in timer && timer.entryId !== undefined;
}
