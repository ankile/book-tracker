import { isFinished } from './finished.ts';

export interface ReadingSessionValues {
  fromPage: number;
  toPage: number;
  pagesRead: number;
  timeRead: number;
}

export interface ReadingAggregateBook {
  currentPage: number;
  currentPageUpdateId?: string | null;
  pageCount: number;
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
): ReadingAggregateMutation {
  const affectsProgress = book.currentPageUpdateId === sessionId;
  return {
    deltaPages: -session.pagesRead,
    deltaTime: -session.timeRead,
    progress: affectsProgress
      ? {
        currentPage: session.fromPage,
        currentPageUpdateId: null,
        finished: isFinished(session.fromPage, book.pageCount),
      }
      : null,
  };
}
