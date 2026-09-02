// Planner for migrate-catalog-creators.ts: createdBy for every work, edition
// and catalog author that has none. The catalog build derived the catalog
// from readers' existing books and stamped no creator; the owner's reading
// (2026-09-02) is that the creator of a shared record is the reader whose
// book brought it in first. So each record goes to the owner of the
// earliest-created personal book that stands on it: for a work, the books
// linked to it directly or through an alias merged into it; for an edition,
// the books linked to it; for an author, the books on the works naming it
// directly or through an alias merged into it. A record nothing stands on
// is listed for review and left alone. Pure and deterministic: ties on the
// book's createdAt fall to the lexically first book path.
import { Timestamp } from 'firebase-admin/firestore';

type Doc = Record<string, unknown>;

export interface CreatorBook {
  uid: string;
  bookId: string;
  data: Doc;
}

export interface CreatorInput {
  works: ReadonlyMap<string, Doc>;
  editions: ReadonlyMap<string, Doc>;
  authors: ReadonlyMap<string, Doc>;
  books: readonly CreatorBook[];
}

export type CreatorCollection = 'works' | 'editions' | 'catalogAuthors';

export interface PlannedCreator {
  collection: CreatorCollection;
  id: string;
  uid: string;
  // The book that decided it.
  bookPath: string;
  // Distinct accounts with a book standing on the record.
  readers: number;
}

export interface CreatorReview {
  collection: CreatorCollection;
  id: string;
  reason: string;
}

export interface CreatorPlan {
  creators: PlannedCreator[];
  review: CreatorReview[];
}

const bookPath = (book: CreatorBook): string => `users/${book.uid}/books/${book.bookId}`;

function createdMillis(book: CreatorBook): number {
  const value = book.data.createdAt;
  if (!(value instanceof Timestamp)) throw new Error(`${bookPath(book)} has no createdAt timestamp`);
  return value.toMillis();
}

function earliest(books: readonly CreatorBook[]): CreatorBook | null {
  if (books.length === 0) return null;
  return [...books].sort((left, right) =>
    createdMillis(left) - createdMillis(right) || bookPath(left).localeCompare(bookPath(right)))[0];
}

// The survivor a merged record redirects to, one hop, or the id itself.
function survivorOf(records: ReadonlyMap<string, Doc>, id: string): string {
  const record = records.get(id);
  return record !== undefined && record.status === 'merged' && typeof record.mergedInto === 'string' ?
    record.mergedInto : id;
}

function push<K>(map: Map<K, CreatorBook[]>, key: K, books: readonly CreatorBook[]): void {
  map.set(key, [...(map.get(key) ?? []), ...books]);
}

export function planCatalogCreators(input: CreatorInput): CreatorPlan {
  const booksByWork = new Map<string, CreatorBook[]>();
  const booksByEdition = new Map<string, CreatorBook[]>();
  for (const book of input.books) {
    const { workId, editionId } = book.data;
    if (typeof workId === 'string' || typeof editionId === 'string') createdMillis(book);
    if (typeof workId === 'string') {
      push(booksByWork, workId, [book]);
      const survivor = survivorOf(input.works, workId);
      if (survivor !== workId) push(booksByWork, survivor, [book]);
    }
    if (typeof editionId === 'string') push(booksByEdition, editionId, [book]);
  }
  const booksByAuthor = new Map<string, CreatorBook[]>();
  for (const [workId, work] of input.works) {
    if (!Array.isArray(work.authorIds)) throw new Error(`works/${workId} has no authorIds`);
    const books = booksByWork.get(workId) ?? [];
    for (const authorId of work.authorIds) {
      if (typeof authorId !== 'string') throw new Error(`works/${workId} has a non-string author id`);
      push(booksByAuthor, authorId, books);
      const survivor = survivorOf(input.authors, authorId);
      if (survivor !== authorId) push(booksByAuthor, survivor, books);
    }
  }

  const creators: PlannedCreator[] = [];
  const review: CreatorReview[] = [];
  const attribute = (
    collection: CreatorCollection,
    records: ReadonlyMap<string, Doc>,
    standing: ReadonlyMap<string, CreatorBook[]>,
  ): void => {
    for (const id of [...records.keys()].sort()) {
      const record = records.get(id)!;
      if (record.createdBy !== undefined) {
        if (typeof record.createdBy !== 'string') throw new Error(`${collection}/${id} has a non-string createdBy`);
        continue;
      }
      const books = standing.get(id) ?? [];
      const first = earliest(books);
      if (first === null) {
        review.push({ collection, id, reason: 'no personal book stands on it' });
        continue;
      }
      creators.push({
        collection, id, uid: first.uid, bookPath: bookPath(first),
        readers: new Set(books.map((book) => book.uid)).size,
      });
    }
  };
  attribute('works', input.works, booksByWork);
  attribute('editions', input.editions, booksByEdition);
  attribute('catalogAuthors', input.authors, booksByAuthor);
  return { creators, review };
}
