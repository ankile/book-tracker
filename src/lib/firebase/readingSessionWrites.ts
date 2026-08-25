import {
  doc,
  increment,
  Timestamp,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import {
  planReadingSessionDelete,
  planReadingSessionUpdate,
  type ReadingAggregateBook,
  type ReadingSessionValues,
} from '../utils/readingSessionMutation.ts';

interface ReadingSessionWriteBase {
  firestore: Firestore;
  userId: string;
  bookId: string;
  sessionId: string;
  previous: ReadingSessionValues;
  book: ReadingAggregateBook;
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
  const sessionRef = doc(firestore, 'users', userId, 'books', bookId, 'updates', sessionId);
  const bookRef = doc(firestore, 'users', userId, 'books', bookId);
  const mutation = planReadingSessionUpdate(previous, next, book, sessionId);
  const batch = writeBatch(firestore);
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
}: ReadingSessionWriteBase): Promise<void> {
  const sessionRef = doc(firestore, 'users', userId, 'books', bookId, 'updates', sessionId);
  const bookRef = doc(firestore, 'users', userId, 'books', bookId);
  const mutation = planReadingSessionDelete(previous, book, sessionId);
  const batch = writeBatch(firestore);
  batch.delete(sessionRef);
  batch.update(bookRef, {
    pagesRead: increment(mutation.deltaPages),
    timeRead: increment(mutation.deltaTime),
    ...(mutation.progress ?? {}),
    updatedAt: Timestamp.now(),
  });
  return batch.commit();
}
