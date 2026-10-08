// Reading pace for a book, in minutes per page, from the best evidence the
// library holds (owner request 2026-09-06). A book with its own sessions
// uses its own pace. A book never read borrows one, coarsest last:
//
//   words   — its edition's words per page, at the reader's minutes per
//             word on their other measured books (owner decision
//             2026-10-08: time left in words wherever the edition carries
//             a Word Counter estimate)
//   author  — the reader's other books sharing an author with it
//   genre   — the reader's other fiction or non-fiction, matching its flag
//   library — every other book the reader has timed
//
// Words come first among borrowed paces: the page-based ones assume every
// book sets the same number of words on a page, which is what a measured
// edition corrects. A measured book or donor counts only on the page count
// its edition was measured on (shared/wordEstimate.ts). Borrowed paces are
// pooled (total minutes over total pages or words, so a long book counts
// for more than a short one) and only from books with both pages and
// minutes on record. The source travels with the number so the UI can say
// how rough the estimate is; null means there is nothing to go on.
import { matchedWordEstimate } from '../../../shared/wordEstimate.ts';
import type { EditionWordEstimate } from '../interfaces/catalog.ts';

export interface PaceBook {
  id: string;
  authorIds?: string[];
  fiction: boolean | null;
  pagesRead: number;
  timeRead: number;
  // The catalog edition and page count a Word Counter estimate must match;
  // absent on books the words tier cannot apply to.
  editionId?: string | null;
  pageCount?: number | null;
}

export type PaceSource = 'own' | 'words' | 'author' | 'genre' | 'library';

export type WordEstimates = ReadonlyMap<string, EditionWordEstimate>;
const NO_ESTIMATES: WordEstimates = new Map();

// Words per page of the book's edition, when it was measured on the book's
// page count.
export function bookWordsPerPage(book: PaceBook, estimates: WordEstimates): number | null {
  if (book.editionId === undefined || book.editionId === null ||
      book.pageCount === undefined || book.pageCount === null) return null;
  return matchedWordEstimate(estimates.get(book.editionId), book.pageCount)?.wordsPerPage ?? null;
}

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

// Editions whose Word Counter estimates these paces can use: the books being
// paced, and every timed book that could lend a pace in words.
export function paceEditionIds(targets: readonly PaceBook[], library: readonly PaceBook[]): string[] {
  const ids = [...targets, ...library.filter(timed)].map((book) => book.editionId);
  return [...new Set(ids.flatMap((id) => (id === undefined || id === null ? [] : [id])))].sort();
}

function pooledMinutesPerWord(books: readonly PaceBook[], estimates: WordEstimates): number | null {
  let words = 0;
  let minutes = 0;
  for (const book of books) {
    const wordsPerPage = bookWordsPerPage(book, estimates);
    if (!timed(book) || wordsPerPage === null) continue;
    words += book.pagesRead * wordsPerPage;
    minutes += book.timeRead;
  }
  return words > 0 ? minutes / words : null;
}

export function paceFor(
  book: PaceBook,
  library: readonly PaceBook[],
  estimates: WordEstimates = NO_ESTIMATES,
): Pace | null {
  if (timed(book)) return { minutesPerPage: book.timeRead / book.pagesRead, source: 'own' };
  const others = library.filter((candidate) => candidate.id !== book.id);
  const wordsPerPage = bookWordsPerPage(book, estimates);
  if (wordsPerPage !== null) {
    const minutesPerWord = pooledMinutesPerWord(others, estimates);
    if (minutesPerWord !== null) return { minutesPerPage: wordsPerPage * minutesPerWord, source: 'words' };
  }
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
    case 'words': return 'Estimated from this edition\'s words per page and your reading speed in words on other measured books';
    case 'author': return 'Estimated from your pace on other books by this author';
    case 'genre': return `Estimated from your pace on other ${book.fiction ? 'fiction' : 'non-fiction'}`;
    case 'library': return 'Estimated from your average pace across your library';
  }
}
