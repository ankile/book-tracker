// Planner for migrate-book-editions.ts: the editions that put every linked
// personal book on an edition of its work. Any book linked to a work stands
// for an edition of it (owner decision 2026-09-01) — the catalog build only
// minted editions for ISBNs, so a work whose readers' books carried none
// has none, and a book on a work another reader's ISBN seeded has no
// edition of its own. Two readers' editions that turn out to be the same
// are merged later by an operator; the planner never guesses that.
//
// Pure and deterministic: the script feeds it stored documents and writes
// what it returns. Ids come from the same formula the admin link path uses
// (functions/src/adminCatalog.ts mintedEditionFor), so a rerun and an admin
// relink name the same document.
import { deterministicCatalogId } from './cross-user-work-migration.ts';
import { normalizeCatalogTitle } from './src/lib/utils/catalog.ts';
import { normalizeIsbn } from './src/lib/utils/isbn.ts';

type Doc = Record<string, unknown>;

export interface BackfillBook {
  uid: string;
  bookId: string;
  data: Doc;
}

export interface BackfillInput {
  works: ReadonlyMap<string, Doc>;
  editions: ReadonlyMap<string, Doc>;
  isbnIndex: ReadonlyMap<string, Doc>;
  books: readonly BackfillBook[];
  // Accounts whose users document exists without a tombstone.
  liveUserIds: ReadonlySet<string>;
}

export interface EditionDocument {
  workId: string;
  isbn13: string | null;
  title: string;
  publisher: string;
  publishedDate: string;
  language: string;
  translatorNames: string[];
  format: 'unknown';
  suggestedPageCount: number | null;
  coverUrl: string;
  externalIds: Record<string, string>;
  createdBy: string;
}

export interface PlannedEdition {
  editionId: string;
  workId: string;
  uid: string;
  // false when the document already exists (a rerun) or the book's ISBN is
  // already indexed to an edition of the work, which the books join instead.
  create: boolean;
  // true when an isbnIndex row is created alongside the edition.
  indexIsbn: boolean;
  data: EditionDocument;
  bookPaths: string[];
}

export interface BackfillReview {
  path: string;
  reason: string;
}

export interface BackfillPlan {
  editions: PlannedEdition[];
  review: BackfillReview[];
}

export const bookPath = (book: BackfillBook): string => `users/${book.uid}/books/${book.bookId}`;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function catalogCoverUrl(value: unknown): string {
  return typeof value === 'string' && /^https:\/\/[^\s]+$/u.test(value) ? value : '';
}

function suggestedPageCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

// The id the admin link path derives for the same book and work.
export function backfillEditionId(workId: string, book: BackfillBook): string {
  return deterministicCatalogId('edition', `${workId}\0${book.uid}/${book.bookId}`);
}

export function editionFromBook(workId: string, book: BackfillBook): EditionDocument {
  const title = text(book.data.title).trim();
  if (title === '') throw new Error(`${bookPath(book)} has no title`);
  return {
    workId,
    isbn13: normalizeIsbn(text(book.data.isbn)),
    title,
    publisher: text(book.data.publisher),
    publishedDate: text(book.data.publishedDate),
    language: '',
    translatorNames: [],
    format: 'unknown',
    suggestedPageCount: suggestedPageCount(book.data.pageCount),
    coverUrl: catalogCoverUrl(book.data.coverUrl),
    externalIds: {},
    createdBy: book.uid,
  };
}

// One edition per reader per distinct book identity on a work: a reread
// (the same title, publisher and ISBN under the same account) shares one
// edition; a second reader, or a different edition of the same work under
// one account, gets its own.
function identityKey(workId: string, book: BackfillBook): string {
  return [
    workId,
    book.uid,
    normalizeIsbn(text(book.data.isbn)) ?? '',
    normalizeCatalogTitle(text(book.data.title)),
    text(book.data.publisher).trim().toLowerCase(),
  ].join('\0');
}

export function planBookEditions(input: BackfillInput): BackfillPlan {
  const review: BackfillReview[] = [];
  const groups = new Map<string, BackfillBook[]>();
  const sorted = [...input.books].sort((left, right) => bookPath(left).localeCompare(bookPath(right)));
  for (const book of sorted) {
    const { workId, editionId } = book.data;
    if (typeof workId !== 'string') continue;
    if (editionId !== null && editionId !== undefined) continue;
    const path = bookPath(book);
    if (!input.liveUserIds.has(book.uid)) {
      review.push({ path, reason: 'owner account missing or tombstoned' });
      continue;
    }
    const work = input.works.get(workId);
    if (work === undefined) {
      review.push({ path, reason: `work ${workId} missing` });
      continue;
    }
    if (work.status === 'merged') {
      review.push({ path, reason: `work ${workId} is merged; relink through the console` });
      continue;
    }
    if (text(book.data.title).trim() === '') {
      review.push({ path, reason: 'book has no title' });
      continue;
    }
    const key = identityKey(workId, book);
    groups.set(key, [...(groups.get(key) ?? []), book]);
  }

  const editions: PlannedEdition[] = [];
  for (const books of groups.values()) {
    const seed = books[0];
    const workId = text(seed.data.workId);
    const data = editionFromBook(workId, seed);
    const bookPaths = books.map(bookPath);
    if (data.isbn13 !== null) {
      const indexed = input.isbnIndex.get(data.isbn13);
      if (indexed !== undefined) {
        if (indexed.workId !== workId || typeof indexed.editionId !== 'string') {
          for (const path of bookPaths) {
            review.push({ path, reason: `ISBN ${data.isbn13} is indexed to another work` });
          }
          continue;
        }
        editions.push({
          editionId: indexed.editionId, workId, uid: seed.uid, create: false, indexIsbn: false,
          data, bookPaths,
        });
        continue;
      }
    }
    const editionId = backfillEditionId(workId, seed);
    const existing = input.editions.get(editionId);
    if (existing !== undefined) {
      if (existing.workId !== workId) {
        for (const path of bookPaths) {
          review.push({ path, reason: `edition ${editionId} exists under another work` });
        }
        continue;
      }
      editions.push({ editionId, workId, uid: seed.uid, create: false, indexIsbn: false, data, bookPaths });
      continue;
    }
    editions.push({
      editionId, workId, uid: seed.uid, create: true, indexIsbn: data.isbn13 !== null, data, bookPaths,
    });
  }
  return { editions, review };
}
