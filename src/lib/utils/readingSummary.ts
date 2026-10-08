import type { Book } from '../interfaces/book.ts';
import { paceFor, type PaceBook, type WordEstimates } from './paceEstimate.ts';

type SummaryBook = Pick<Book, 'currentPage' | 'pageCount' | 'pagesRead' | 'timeRead'> & PaceBook;

// Time left per book comes from paceFor: its own pace when it has one,
// otherwise a pace borrowed from the rest of the library (in words where
// its edition was measured). A book with nothing to borrow from counts as
// unknown.
export function readingSummary(
  books: readonly SummaryBook[],
  library: readonly PaceBook[] = books,
  estimates?: WordEstimates,
) {
  let pages = 0, progress = 0, minutesRead = 0, minutesLeft = 0, unknownBooks = 0, borrowedBooks = 0;
  for (const book of books) {
    const read = Math.min(book.pageCount, Math.max(0, book.currentPage));
    pages += book.pageCount;
    progress += read;
    minutesRead += book.timeRead;
    const remaining = book.pageCount - read;
    if (remaining > 0) {
      const pace = paceFor(book, library, estimates);
      if (pace === null) unknownBooks++;
      else {
        minutesLeft += remaining * pace.minutesPerPage;
        if (pace.source !== 'own') borrowedBooks++;
      }
    }
  }
  return { count: books.length, pagesLeft: pages - progress,
    completion: pages > 0 ? progress / pages * 100 : 0, minutesRead, minutesLeft, unknownBooks, borrowedBooks };
}
