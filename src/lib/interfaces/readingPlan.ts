import type { Timestamp } from 'firebase/firestore';
import type { CatalogSelection } from './catalog.ts';
import type { BookMetadata } from './metadata.ts';

// A users/{uid}/readingPlanEntries/{entryId} document: one row of the
// reader's private to-read queue (docs/to-read-plan.md). A 'planned' entry
// is an intention that is not yet a personal book; a 'book' entry is the
// saved queue position of the personal book with the same id. Nothing here
// is published or projected into profiles.

interface PlanEntryBase {
  id: string;
  // Fractional rank; the visible order is rank ascending, ties by id
  // (utils/readingPlan.ts). A move rewrites one document.
  rank: number;
  // A positive reader-supplied minutes-per-page estimate that overrides the
  // automatic pace until cleared.
  manualMinutesPerPage: number | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface PlannedAuthor {
  // A shared catalog author id, or null for a name the reader typed that
  // was not resolved when the entry was saved.
  id: string | null;
  name: string;
}

export interface PlannedEntry extends PlanEntryBase, BookMetadata {
  kind: 'planned';
  title: string;
  authors: PlannedAuthor[];
  // Unknown until the reader supplies it; Start reading requires one.
  pageCount: number | null;
  isbn: string;
  // The shared-work choice made when the entry was saved, carried onto the
  // personal book on Start reading.
  catalogLink: CatalogSelection | null;
}

export interface BookPlanEntry extends PlanEntryBase {
  kind: 'book';
}

export type PlanEntry = PlannedEntry | BookPlanEntry;

// users/{uid}/readingPlans/default: the reader's explicit daily-minutes
// scenario, used instead of the measured budget while set.
export interface ReadingPlanSettings {
  dailyMinutesOverride: number | null;
  updatedAt: Timestamp;
}

// A listener snapshot with the metadata the planner shows: whether the
// rows came from the local cache only and whether local writes are still
// waiting for the server.
export interface PlanSnapshot<T> {
  value: T;
  fromCache: boolean;
  hasPendingWrites: boolean;
}
