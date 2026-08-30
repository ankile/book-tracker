import {
  doc,
  increment,
  Timestamp,
  writeBatch,
  type DocumentReference,
  type Firestore,
  type WriteBatch,
} from 'firebase/firestore';
import {
  planReadingSessionDelete,
  planReadingSessionUpdate,
  type ReadingAggregateBook,
  type ReadingSessionValues,
  type ReadingProgressUpdate,
} from '../utils/readingSessionMutation.ts';

export interface ReadingSessionWriteStore {
  document(path: string, ...pathSegments: string[]): DocumentReference;
  batch(): WriteBatch;
}

export function createReadingSessionWriteStore(
  firestore: Firestore,
): ReadingSessionWriteStore {
  return {
    document: (path, ...pathSegments) => doc(firestore, path, ...pathSegments),
    batch: () => writeBatch(firestore),
  };
}

interface ReadingSessionWriteBase {
  firestore: ReadingSessionWriteStore;
  userId: string;
  bookId: string;
  sessionId: string;
  previous: ReadingSessionValues;
  book: ReadingAggregateBook;
}

interface ReadingSessionDeleteWrite extends ReadingSessionWriteBase {
  previousProgressUpdate: Pick<ReadingProgressUpdate, 'id' | 'toPage'> | null;
}

interface ReadingSessionUpdateWrite extends ReadingSessionWriteBase {
  next: Pick<ReadingSessionValues, 'fromPage' | 'toPage' | 'timeRead'>;
}

// No reads and no transactions: the already-decoded listener state is enough
// to form an atomic local batch. Firestore rules compare the claimed deltas to
// the server-side session before accepting a reconnect-flushed stale batch.
export function queueReadingSessionUpdate({
  firestore,
  userId,
  bookId,
  sessionId,
  previous,
  book,
  next,
}: ReadingSessionUpdateWrite): Promise<void> {
  const sessionRef = firestore.document('users', userId, 'books', bookId, 'updates', sessionId);
  const bookRef = firestore.document('users', userId, 'books', bookId);
  const mutation = planReadingSessionUpdate(previous, next, book, sessionId);
  const batch = firestore.batch();
  batch.update(sessionRef, {
    ...next,
    pagesRead: next.toPage - next.fromPage,
    updatedAt: Timestamp.now(),
  });
  batch.update(bookRef, {
    pagesRead: increment(mutation.deltaPages),
    timeRead: increment(mutation.deltaTime),
    ...(mutation.progress ?? {}),
    updatedAt: Timestamp.now(),
  });
  return batch.commit();
}

export function queueReadingSessionDelete({
  firestore,
  userId,
  bookId,
  sessionId,
  previous,
  book,
  previousProgressUpdate,
}: ReadingSessionDeleteWrite): Promise<void> {
  const sessionRef = firestore.document('users', userId, 'books', bookId, 'updates', sessionId);
  const bookRef = firestore.document('users', userId, 'books', bookId);
  const mutation = planReadingSessionDelete(
    previous,
    book,
    sessionId,
    previousProgressUpdate,
  );
  const batch = firestore.batch();
  batch.delete(sessionRef);
  batch.update(bookRef, {
    pagesRead: increment(mutation.deltaPages),
    timeRead: increment(mutation.deltaTime),
    ...(mutation.progress ?? {}),
    updatedAt: Timestamp.now(),
  });
  return batch.commit();
}
