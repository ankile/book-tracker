import { isFinished } from './finished.ts';

export interface ReadingSessionValues {
  fromPage: number;
  toPage: number;
  pagesRead: number;
  timeRead: number;
}

export interface ReadingAggregateBook {
  currentPage: number;
  currentPageUpdateId: string | null;
  pageCount: number;
}

export interface ReadingProgressUpdate {
  id: string;
  toPage: number;
  createdAt: { toMillis(): number };
}

export interface ReadingAggregateMutation {
  deltaPages: number;
  deltaTime: number;
  progress: {
    currentPage: number;
    currentPageUpdateId: string | null;
    finished: boolean;
  } | null;
}

// Aggregate increments commute for different sessions. Progress does not:
// only the update row recorded as the exact current-page source can move that
// page. Legacy books without a source id preserve progress rather than guess.
export function planReadingSessionUpdate(
  previous: ReadingSessionValues,
  next: Pick<ReadingSessionValues, 'fromPage' | 'toPage' | 'timeRead'>,
  book: ReadingAggregateBook,
  sessionId: string,
): ReadingAggregateMutation {
  const nextPagesRead = next.toPage - next.fromPage;
  const affectsProgress = book.currentPageUpdateId === sessionId;
  return {
    deltaPages: nextPagesRead - previous.pagesRead,
    deltaTime: next.timeRead - previous.timeRead,
    progress: affectsProgress
      ? {
        currentPage: next.toPage,
        currentPageUpdateId: sessionId,
        finished: isFinished(next.toPage, book.pageCount),
      }
      : null,
  };
}

export function planReadingSessionDelete(
  session: ReadingSessionValues,
  book: ReadingAggregateBook,
  sessionId: string,
  previousProgressUpdate: Pick<ReadingProgressUpdate, 'id' | 'toPage'> | null,
): ReadingAggregateMutation {
  const affectsProgress = book.currentPageUpdateId === sessionId;
  if (affectsProgress && previousProgressUpdate !== null &&
      previousProgressUpdate.toPage !== session.fromPage) {
    throw new Error('The preceding update does not establish the restored page.');
  }
  return {
    deltaPages: -session.pagesRead,
    deltaTime: -session.timeRead,
    progress: affectsProgress
      ? {
        currentPage: session.fromPage,
        currentPageUpdateId: previousProgressUpdate?.id ?? null,
        finished: isFinished(session.fromPage, book.pageCount),
      }
      : null,
  };
}

// Client timestamps do not define server write order, especially offline.
// The source id proves the deleted row won progress ownership; among the
// surviving rows that establish its fromPage, timestamps and ids provide a
// stable choice for the new owner.
export function precedingProgressUpdate(
  updates: readonly ReadingProgressUpdate[],
  deleted: Pick<ReadingProgressUpdate, 'id'> & Pick<ReadingSessionValues, 'fromPage'>,
): ReadingProgressUpdate | null {
  return updates
    .filter((update) => update.id !== deleted.id && update.toPage === deleted.fromPage)
    .toSorted((left, right) =>
      right.createdAt.toMillis() - left.createdAt.toMillis() ||
      right.id.localeCompare(left.id)
    )[0] ?? null;
}
