import type { DocumentReference, Timestamp } from 'firebase/firestore';
import type { ReferenceLike, TimestampLike } from './common.ts';

interface UpdateViewBase {
  book: ReferenceLike;
  createdAt: TimestampLike;
  pagesRead: number;
}

export interface ReadingUpdateView extends UpdateViewBase {
  type: 'reading';
  timeRead: number;
  fromPage?: number;
  toPage?: number;
}

export interface PageCorrectionView extends UpdateViewBase {
  type: 'update';
  timeRead?: never;
  fromPage?: number;
  toPage?: number;
}

export type BookUpdateView = ReadingUpdateView | PageCorrectionView;

interface StoredUpdateBase {
  id: string;
  owner: DocumentReference;
  book: DocumentReference;
  fromPage: number;
  toPage: number;
  pagesRead: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ReadingSession extends StoredUpdateBase {
  type: 'reading';
  timeRead: number;
}

export interface PageCorrection extends StoredUpdateBase {
  type: 'update';
  timeRead?: never;
}

export type BookUpdate = ReadingSession | PageCorrection;
