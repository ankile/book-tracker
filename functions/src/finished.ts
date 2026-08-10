// The finished-flag invariant: a book is finished exactly when its current
// page has reached the page count, and only page movement may change the
// flag. Returns the write to apply, or null for no-op.
//
// The page-change gate is what makes bulk writes (migrations, backfills,
// restores) safe: a write that touches no page field can never flip
// finished, no matter what state the document is in. It also makes the
// trigger's own merge-set re-fire a no-op by construction. The numeric
// guard exists because legacy documents may lack page fields entirely —
// undefined === undefined must not mark a book finished.
import type {DocumentData} from "firebase-admin/firestore";

export function finishedTransition(
  before: DocumentData,
  after: DocumentData,
): { finished: boolean } | null {
  const pagesChanged =
    before.currentPage !== after.currentPage ||
    before.pageCount !== after.pageCount;
  if (!pagesChanged) return null;

  const {currentPage, pageCount, finished} = after;
  if (!Number.isFinite(currentPage) || !Number.isFinite(pageCount)) {
    return null;
  }
  if (currentPage === pageCount) {
    return finished === true ? null : {finished: true};
  }
  return finished ? {finished: false} : null;
}
