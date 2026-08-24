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
