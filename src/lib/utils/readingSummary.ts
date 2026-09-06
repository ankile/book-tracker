import type { Book } from '../interfaces/book.ts';

export function readingSummary(books: readonly Pick<Book, 'currentPage' | 'pageCount' | 'pagesRead' | 'timeRead'>[]) {
  let pages = 0, progress = 0, minutesRead = 0, minutesLeft = 0, unknownBooks = 0;
  for (const book of books) {
    const read = Math.min(book.pageCount, Math.max(0, book.currentPage));
    pages += book.pageCount;
    progress += read;
    minutesRead += book.timeRead;
    const remaining = book.pageCount - read;
    if (remaining > 0) {
      if (book.pagesRead > 0 && book.timeRead > 0) minutesLeft += remaining * book.timeRead / book.pagesRead;
      else unknownBooks++;
    }
  }
  return { count: books.length, pagesLeft: pages - progress,
    completion: pages > 0 ? progress / pages * 100 : 0, minutesRead, minutesLeft, unknownBooks };
}
