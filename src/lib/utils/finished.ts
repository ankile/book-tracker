// The finished-flag invariant, applied by every write that moves a page
// field: a book is finished exactly when its current page has reached the
// page count. Computed client-side in the same writeBatch as the page
// mutation so the flag is atomic with the pages and correct offline —
// the book changes lists instantly from the local cache. The (temporary)
// bookIsFinished trigger applies the same rule server-side for stale
// cached clients; keep the two in sync until the trigger is deleted.
//
// Plain module with no imports: migration and audit scripts share this
// exact rule via a direct import.
export function isFinished(currentPage: unknown, pageCount: unknown): boolean {
  return (
    Number.isFinite(currentPage) &&
    Number.isFinite(pageCount) &&
    currentPage === pageCount
  );
}

// finishedAt is stamped in the same batch that flips finished, from the
// book's previous state: becoming finished stamps now, staying finished
// keeps the stored stamp (the patch is empty), unfinished stores null.
// Generic over the timestamp type so migration and audit scripts, which
// use the Admin SDK's Timestamp, share it with the client.
export function finishedAtPatch<T>(
  wasFinished: boolean,
  nowFinished: boolean,
  now: T,
): { finishedAt: T | null } | Record<string, never> {
  if (!nowFinished) return { finishedAt: null };
  if (wasFinished) return {};
  return { finishedAt: now };
}

// A finished book's finish date is its explicit finishedAt stamp: the client
// writes it in the batch that flips finished and migrate-finished-at.ts
// backfilled every older book, so a finished book without one is a broken
// invariant (db-audit book.finished-without-finishedAt), not a case to
// paper over with updatedAt or createdAt.
export function finishedDateOf(book: {
  id?: string;
  finishedAt: { toDate(): Date } | null;
}): Date {
  if (book.finishedAt === null) {
    throw new Error(`finished book ${book.id ?? '(no id)'} has no finishedAt`);
  }
  return book.finishedAt.toDate();
}
