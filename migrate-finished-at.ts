// One-time finishedAt backfill for books finished before the field existed.
//
//   node migrate-finished-at.ts
//   node migrate-finished-at.ts --apply
//   node migrate-finished-at.ts --prod
//   node migrate-finished-at.ts --prod --apply
import {parseFlags, connect} from './migrate-lib.ts';
import {planFinishedAt} from './finished-at-migration.ts';

const flags = parseFlags(process.argv.slice(2));
if (flags.rest.length > 0) throw new Error(`unexpected arguments: ${flags.rest.join(' ')}`);
const {db} = await connect({...flags, confirmWrite: flags.apply});

let writes = 0;
const users = await db.collection('users').listDocuments();
for (const user of users) {
  const books = await user.collection('books').get();
  for (const book of books.docs) {
    if (!flags.apply) {
      const updates = await book.ref.collection('updates').get();
      const patch = planFinishedAt(
        book.data(),
        updates.docs.map((update) => ({id: update.id, data: update.data()})),
      );
      if (patch === null) continue;
      console.log(`DRY ${book.ref.path} finishedAt=${patch.finishedAt.toDate().toISOString()}`);
      writes += 1;
      continue;
    }
    const applied = await db.runTransaction(async (tx) => {
      const [freshBook, freshUpdates] = await Promise.all([
        tx.get(book.ref),
        tx.get(book.ref.collection('updates')),
      ]);
      if (!freshBook.exists) throw new Error(`${book.ref.path} disappeared during migration`);
      const patch = planFinishedAt(
        freshBook.data() ?? {},
        freshUpdates.docs.map((update) => ({id: update.id, data: update.data()})),
      );
      if (patch !== null) tx.update(book.ref, patch);
      return patch;
    });
    if (applied === null) continue;
    console.log(`MIGRATE ${book.ref.path} finishedAt=${applied.finishedAt.toDate().toISOString()}`);
    writes += 1;
  }
}

console.log(
  `${writes} books ${flags.apply ? 'stamped' : 'need a finishedAt stamp (dry run, nothing written)'}`,
);
