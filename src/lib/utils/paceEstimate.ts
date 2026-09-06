// Reading pace for a book, in minutes per page, from the best evidence the
// library holds (owner request 2026-09-06). A book with its own sessions
// uses its own pace. A book never read borrows one, coarsest last:
//
//   author  — the reader's other books sharing an author with it
//   genre   — the reader's other fiction or non-fiction, matching its flag
//   library — every other book the reader has timed
//
// Borrowed paces are pooled (total minutes over total pages, so a long book
// counts for more than a short one) and only from books with both pages
// and minutes on record. The source travels with the number so the UI can
// say how rough the estimate is; null means there is nothing to go on.

export interface PaceBook {
  id: string;
  authorIds?: string[];
  fiction: boolean | null;
  pagesRead: number;
  timeRead: number;
}

export type PaceSource = 'own' | 'author' | 'genre' | 'library';

export interface Pace {
  minutesPerPage: number;
  source: PaceSource;
}

function timed(book: PaceBook): boolean {
  return book.pagesRead > 0 && book.timeRead > 0;
}

function pooled(books: readonly PaceBook[]): number | null {
  let pages = 0;
  let minutes = 0;
  for (const book of books) {
    if (!timed(book)) continue;
    pages += book.pagesRead;
    minutes += book.timeRead;
  }
  return pages > 0 ? minutes / pages : null;
}

export function paceFor(book: PaceBook, library: readonly PaceBook[]): Pace | null {
  if (timed(book)) return { minutesPerPage: book.timeRead / book.pagesRead, source: 'own' };
  const others = library.filter((candidate) => candidate.id !== book.id);
  const authors = new Set(book.authorIds ?? []);
  const byAuthor = pooled(others.filter((candidate) =>
    (candidate.authorIds ?? []).some((authorId) => authors.has(authorId))));
  if (byAuthor !== null) return { minutesPerPage: byAuthor, source: 'author' };
  if (book.fiction !== null) {
    const byGenre = pooled(others.filter((candidate) => candidate.fiction === book.fiction));
    if (byGenre !== null) return { minutesPerPage: byGenre, source: 'genre' };
  }
  const byLibrary = pooled(others);
  return byLibrary === null ? null : { minutesPerPage: byLibrary, source: 'library' };
}

export function minutesLeft(book: { currentPage: number; pageCount: number }, pace: Pace): number {
  return Math.round(Math.max(0, book.pageCount - book.currentPage) * pace.minutesPerPage);
}

// The tooltip for a borrowed pace; an own pace needs none.
export function paceNote(pace: Pace, book: { fiction: boolean | null }): string | null {
  switch (pace.source) {
    case 'own': return null;
    case 'author': return 'Estimated from your pace on other books by this author';
    case 'genre': return `Estimated from your pace on other ${book.fiction ? 'fiction' : 'non-fiction'}`;
    case 'library': return 'Estimated from your average pace across your library';
  }
}
