import type { DocumentReference, Timestamp } from "firebase/firestore";

// A users/{uid}/books doc. Every field below is written by the current
// client on create; the optional markers mean "may be absent on docs last
// written by an older client" — migrate-normalize-books.js and
// migrate-enrich-books.js are the repair paths that close those gaps.
export interface Book {
  id: string;
  currentPage: number;
  pageCount: number;
  // Lifetime aggregates over reading sessions; used to project pace.
  pagesRead?: number;
  timeRead?: number;
  title: string;
  finished?: boolean;
  // Always present (possibly '') since the 2026-08-11 normalize backfill;
  // the Look up button rewrites it as a bare ISBN-13 when it validates.
  isbn?: string;
  owner?: DocumentReference;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  // ISBN-derived metadata from Open Library (Look up button or
  // migrate-enrich-books.js); shapes defined in utils/bookMetadata.js.
  // Advisory display data — owner-forgeable, never load-bearing.
  // coverUrl is the covers.openlibrary.org -M size ('' when none);
  // fiction is a subjects-derived guess, null when unknown.
  coverUrl?: string;
  publisher?: string;
  publishedDate?: string;
  subjects?: string[];
  fiction?: boolean | null;
  // Author doc ids into users/{uid}/authors, in display order.
  authorIds?: string[];
  // Legacy authorship, present only on docs last written by pre-authorIds
  // clients. Legacy wins on read: its presence proves an old client wrote
  // last, so any authorIds alongside it are stale. Removed once the
  // straggler migration passes clean.
  author?: string;
  authors?: { id: string; name: string }[];
  // entryId is only present for Toggl-backed timers; local timers store just the start time
  activeTimer?: { entryId?: number; start: string } | null;
}
