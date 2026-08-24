// Repair migration: normalize legacy book documents to the current shape.
// Idempotent — every write is guarded on the defect being present, so a
// re-run after a clean pass performs 0 writes. Kept cheap to re-run because
// stale offline clients can flush old-shape writes days after a migration.
//
// Policy table (see the hardening plan / MIGRATIONS.md):
//   finished:true, both pages numeric, unequal  -> currentPage := pageCount
//   finished:true, page(s) missing/non-numeric  -> report + skip (human call)
//   finished missing                            -> := isFinished(pages)
//   finished:false but pages equal              -> := true (a stale client
//     wrote pages without the flag; the backstop trigger that used to
//     reconcile this live was deleted 2026-08-11, this re-run repairs it)
//   createdAt missing                           -> earliest update createdAt,
//                                                  else book updatedAt, else report
//   pagesRead / timeRead missing                -> := 0
//   author / isbn missing                       -> := ''
//   owner missing                               -> := users/<uid> ref
//   activeTimer set                             -> report only (may hold a live
//                                                  Toggl entryId)
//   updatedAt                                   -> never written (batcher crashes)
//
//   node migrate-normalize-books.ts                    # emulator dry-run
//   node migrate-normalize-books.ts --apply            # emulator apply
//   node migrate-normalize-books.ts --prod             # prod dry-run
//   node migrate-normalize-books.ts --prod --apply     # prod apply (typed confirm)
import { parseFlags, connect, batcher } from './migrate-lib.ts';
import { isFinished } from './src/lib/utils/finished.ts';

const flags = parseFlags(process.argv.slice(2));
const { db } = await connect({ ...flags, confirmWrite: flags.apply });
const writes = batcher(db, { apply: flags.apply });

const users = await db.collection('users').get();
for (const user of users.docs) {
  const books = await user.ref.collection('books').get();
  for (const book of books.docs) {
    const b = book.data();
    const patch: Record<string, unknown> = {};

    if (b.finished === true && !isFinished(b.currentPage, b.pageCount)) {
      if (Number.isFinite(b.currentPage) && Number.isFinite(b.pageCount)) {
        patch.currentPage = b.pageCount;
      } else {
        console.log(`SKIP ${book.ref.path} finished=true but pages=${b.currentPage}/${b.pageCount} — needs a human decision`);
      }
    }
    if (b.finished === undefined) patch.finished = isFinished(b.currentPage, b.pageCount);
    if (b.finished === false && isFinished(b.currentPage, b.pageCount)) patch.finished = true;

    if (b.createdAt === undefined) {
      const first = await book.ref.collection('updates').orderBy('createdAt').limit(1).get();
      if (!first.empty) patch.createdAt = first.docs[0].data().createdAt;
      else if (b.updatedAt !== undefined) patch.createdAt = b.updatedAt;
      else console.log(`SKIP ${book.ref.path} no createdAt and no source to backfill from`);
    }

    if (b.pagesRead === undefined) patch.pagesRead = 0;
    if (b.timeRead === undefined) patch.timeRead = 0;
    if (b.author === undefined) patch.author = '';
    if (b.isbn === undefined) patch.isbn = '';
    if (b.owner === undefined) patch.owner = db.doc(`users/${user.id}`);

    if (b.activeTimer) console.log(`REPORT ${book.ref.path} activeTimer=${JSON.stringify(b.activeTimer)}`);

    if (Object.keys(patch).length > 0) {
      console.log(`${flags.apply ? 'UPDATE' : 'DRY'} ${book.ref.path} ${Object.keys(patch).sort().join(',')}`);
      await writes.update(book.ref, patch);
    }
  }
}
await writes.flush();
console.log(`${writes.count()} book updates ${flags.apply ? 'applied' : '(dry run, nothing written)'}`);
