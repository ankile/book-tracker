import { finishedAtPatch, isFinished } from './finished.ts';

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
  finished: boolean;
}

export interface ReadingProgressUpdate {
  id: string;
  toPage: number;
  createdAt: { toMillis(): number };
}

// progress carries finishedAt only when the mutation flips finished
// (finishedAtPatch): a stamp of `now` on finishing, null on un-finishing,
// and no key at all when the flag is unchanged so the stored stamp stays.
export interface ReadingAggregateMutation<T> {
  deltaPages: number;
  deltaTime: number;
  progress: {
    currentPage: number;
    currentPageUpdateId: string | null;
    finished: boolean;
    finishedAt?: T | null;
  } | null;
}

// Aggregate increments commute for different sessions. Progress does not:
// only the update row recorded as the exact current-page source can move that
// page. Legacy books without a source id preserve progress rather than guess.
export function planReadingSessionUpdate<T>(
  previous: ReadingSessionValues,
  next: Pick<ReadingSessionValues, 'fromPage' | 'toPage' | 'timeRead'>,
  book: ReadingAggregateBook,
  sessionId: string,
  now: T,
): ReadingAggregateMutation<T> {
  const nextPagesRead = next.toPage - next.fromPage;
  const affectsProgress = book.currentPageUpdateId === sessionId;
  const finished = isFinished(next.toPage, book.pageCount);
  return {
    deltaPages: nextPagesRead - previous.pagesRead,
    deltaTime: next.timeRead - previous.timeRead,
    progress: affectsProgress
      ? {
        currentPage: next.toPage,
        currentPageUpdateId: sessionId,
        finished,
        ...finishedAtPatch(book.finished, finished, now),
      }
      : null,
  };
}

export function planReadingSessionDelete<T>(
  session: ReadingSessionValues,
  book: ReadingAggregateBook,
  sessionId: string,
  previousProgressUpdate: Pick<ReadingProgressUpdate, 'id' | 'toPage'> | null,
  now: T,
): ReadingAggregateMutation<T> {
  const affectsProgress = book.currentPageUpdateId === sessionId;
  if (affectsProgress && previousProgressUpdate !== null &&
      previousProgressUpdate.toPage !== session.fromPage) {
    throw new Error('The preceding update does not establish the restored page.');
  }
  const finished = isFinished(session.fromPage, book.pageCount);
  return {
    deltaPages: -session.pagesRead,
    deltaTime: -session.timeRead,
    progress: affectsProgress
      ? {
        currentPage: session.fromPage,
        currentPageUpdateId: previousProgressUpdate?.id ?? null,
        finished,
        ...finishedAtPatch(book.finished, finished, now),
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
