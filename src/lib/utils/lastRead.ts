// lastReadAt is the moment of a book's newest reading activity and the
// only thing the reading list orders by. Reading and editing are separate
// kinds of change (owner decision 2026-09-05): a reading session or a
// forward page update stamps lastReadAt in the batch that writes its row,
// while a metadata edit moves updatedAt and leaves lastReadAt alone (the
// rules pin it across such edits). Before the field existed the list
// ordered by updatedAt, which put a book edited in the console above one
// read the day before.
//
// A row is reading activity when it is a timed session or moved the page
// forward. A page-count clamp from the edit form and a backward page
// correction are 'update' rows with zero or negative pagesRead: they
// correct the record, they are not reading.
//
// Plain module with no Firebase imports: migrate-last-read-at.ts and
// db-audit.ts share this exact rule with the client.

export interface ReadActivityRow<T extends { toMillis(): number }> {
  id: string;
  type: unknown;
  pagesRead: unknown;
  createdAt: T;
}

export function isReadingActivity(row: { type: unknown; pagesRead: unknown }): boolean {
  if (typeof row.pagesRead !== 'number' || !Number.isFinite(row.pagesRead)) {
    throw new TypeError('pagesRead must be a finite number');
  }
  return row.type === 'reading' || row.pagesRead > 0;
}

// The newest reading row's createdAt (ties by id, descending), or null for
// a book that was never read.
export function lastReadAtOf<T extends { toMillis(): number }>(
  rows: readonly ReadActivityRow<T>[],
): T | null {
  const newest = rows
    .filter(isReadingActivity)
    .toSorted((left, right) =>
      right.createdAt.toMillis() - left.createdAt.toMillis() ||
      right.id.localeCompare(left.id))[0];
  return newest === undefined ? null : newest.createdAt;
}

function sameInstant<T extends { toMillis(): number }>(left: T | null, right: T | null): boolean {
  if (left === null || right === null) return left === right;
  return left.toMillis() === right.toMillis();
}

// The stamp after a row is deleted, for the book patch of the deleting
// batch: no key when the remaining rows still justify the stored stamp,
// otherwise the newest remaining reading row (or null when none is left).
export function lastReadAtAfterDelete<T extends { toMillis(): number }>(
  rows: readonly ReadActivityRow<T>[],
  deletedId: string,
  stored: T | null,
): { lastReadAt: T | null } | Record<string, never> {
  const next = lastReadAtOf(rows.filter((row) => row.id !== deletedId));
  return sameInstant(next, stored) ? {} : { lastReadAt: next };
}

// Reading-list order: newest reading activity first; a book never read
// takes its place by when it was added. updatedAt is not a source.
export function readOrderMillis(book: {
  lastReadAt: { toMillis(): number } | null;
  createdAt: { toMillis(): number };
}): number {
  return (book.lastReadAt ?? book.createdAt).toMillis();
}
