// Classifies a book by what is wrong with its ISBN-derived metadata, for
// the /isbns repair page and the Me-page card that links to it.
//
// One status per book, most-actionable first: a book with no usable ISBN
// cannot be enriched at all, so that always outranks a missing cover.
import { normalizeIsbn } from './isbn.ts';

export const ISBN_MISSING = 'isbn-missing';
export const ISBN_INVALID = 'isbn-invalid';
export const NO_METADATA = 'no-metadata';
export const COVER_MISSING = 'cover-missing';

export type MetadataStatus =
  | typeof ISBN_MISSING
  | typeof ISBN_INVALID
  | typeof NO_METADATA
  | typeof COVER_MISSING;

export interface MetadataHealthBook {
  isbn?: string;
  coverUrl?: string;
  subjects?: readonly string[];
  fiction?: boolean | null;
}

// The statuses a corrected ISBN would fix, and the count the Me-page card
// shows — the crisp "books needing a human" number.
export const ISBN_PROBLEMS = [ISBN_MISSING, ISBN_INVALID] as const;

export const STATUS_LABELS: Record<MetadataStatus, string> = {
  [ISBN_MISSING]: 'No ISBN',
  [ISBN_INVALID]: 'Invalid ISBN',
  [NO_METADATA]: 'Nothing found',
  [COVER_MISSING]: 'No cover',
};

export const STATUS_ORDER: readonly MetadataStatus[] = [
  ISBN_MISSING,
  ISBN_INVALID,
  NO_METADATA,
  COVER_MISSING,
];

export function metadataStatus(book: MetadataHealthBook): MetadataStatus | null {
  if (!book.isbn) return ISBN_MISSING;
  if (normalizeIsbn(book.isbn) === null) return ISBN_INVALID;
  // A valid ISBN that both sources drew a blank on: usually an edition
  // neither catalogs, so another edition's ISBN is the fix.
  const classified = book.fiction === true || book.fiction === false;
  if (!book.coverUrl && (book.subjects?.length ?? 0) === 0 && !classified) return NO_METADATA;
  if (!book.coverUrl) return COVER_MISSING;
  return null;
}

// Books needing attention, grouped by status in severity order. Books that
// are fine are absent entirely.
export function groupByStatus<T extends MetadataHealthBook>(
  books: readonly T[],
): { status: MetadataStatus; label: string; books: T[] }[] {
  const groups = new Map<MetadataStatus, T[]>(
    STATUS_ORDER.map((status): [MetadataStatus, T[]] => [status, []]),
  );
  for (const book of books) {
    const status = metadataStatus(book);
    if (status === null) continue;
    const group = groups.get(status);
    if (group === undefined) throw new Error(`Missing metadata group: ${status}`);
    group.push(book);
  }
  return STATUS_ORDER
    .map((status) => {
      const groupedBooks = groups.get(status);
      if (groupedBooks === undefined) throw new Error(`Missing metadata group: ${status}`);
      return { status, label: STATUS_LABELS[status], books: groupedBooks };
    })
    .filter((group) => group.books.length > 0);
}

export function countIsbnProblems(books: readonly MetadataHealthBook[]): number {
  return books.filter((book) => {
    const status = metadataStatus(book);
    return status === ISBN_MISSING || status === ISBN_INVALID;
  }).length;
}
