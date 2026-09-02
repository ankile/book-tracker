// Planner for migrate-catalog-creation-dates.ts: the creation date of every
// work, edition and catalog author, where the record is dated later than
// its creator's first book. The catalog build (2026-09-01) dated everything
// it minted with its own run; the date that means something is when the
// creator first had the book (owner request 2026-09-02). So each record
// whose createdBy owns a book standing on it that is older than the record
// takes that book's createdAt. A record dated no later than that book is
// left alone, which is every record the add-book flow made (it is written
// a moment before its book), so a rerun plans nothing. Pure and
// deterministic; reuses the creators planner's notion of which books
// stand on a record.
import { Timestamp } from 'firebase-admin/firestore';
import {
  bookCreatedMillis,
  earliestBook,
  standingBooks,
  type CreatorBook,
  type CreatorCollection,
  type CreatorInput,
} from './catalog-creator-backfill.ts';

export interface PlannedCreatedAt {
  collection: CreatorCollection;
  id: string;
  // The new and the stored creation time, in epoch milliseconds.
  createdAt: number;
  was: number;
  // The book that decided it.
  bookPath: string;
}

export interface CreatedAtPlan {
  records: PlannedCreatedAt[];
}

export function planCatalogCreatedAt(input: CreatorInput): CreatedAtPlan {
  const standing = standingBooks(input);
  const records: PlannedCreatedAt[] = [];
  const redate = (
    collection: CreatorCollection,
    docs: ReadonlyMap<string, Record<string, unknown>>,
    books: ReadonlyMap<string, CreatorBook[]>,
  ): void => {
    for (const id of [...docs.keys()].sort()) {
      const record = docs.get(id)!;
      const { createdBy, createdAt } = record;
      if (createdBy === undefined) continue;
      if (typeof createdBy !== 'string') throw new Error(`${collection}/${id} has a non-string createdBy`);
      if (!(createdAt instanceof Timestamp)) throw new Error(`${collection}/${id} has no createdAt timestamp`);
      const first = earliestBook((books.get(id) ?? []).filter((book) => book.uid === createdBy));
      if (first === null) continue;
      const was = createdAt.toMillis();
      const bookMillis = bookCreatedMillis(first);
      if (bookMillis >= was) continue;
      records.push({
        collection, id, createdAt: bookMillis, was, bookPath: `users/${first.uid}/books/${first.bookId}`,
      });
    }
  };
  redate('works', input.works, standing.works);
  redate('editions', input.editions, standing.editions);
  redate('catalogAuthors', input.authors, standing.authors);
  return { records };
}
