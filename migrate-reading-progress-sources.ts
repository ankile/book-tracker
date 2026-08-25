// One-time progress-provenance backfill for existing books.
//
//   node migrate-reading-progress-sources.ts
//   node migrate-reading-progress-sources.ts --apply
//   node migrate-reading-progress-sources.ts --prod
//   node migrate-reading-progress-sources.ts --prod --apply
import {parseFlags, connect} from './migrate-lib.ts';
import {planReadingProgressSource} from './reading-progress-source-migration.ts';

const flags = parseFlags(process.argv.slice(2));
if (flags.rest.length > 0) throw new Error(`unexpected arguments: ${flags.rest.join(' ')}`);
const {db} = await connect({...flags, confirmWrite: flags.apply});

let writes = 0;
const users = await db.collection('users').get();
for (const user of users.docs) {
  const books = await user.ref.collection('books').get();
  for (const book of books.docs) {
    const inspect = async () => {
      const updates = await book.ref.collection('updates').get();
      return planReadingProgressSource(
        book.data(),
        updates.docs.map((update) => ({id: update.id, data: update.data()})),
      );
    };
    const patch = await inspect();
    if (patch === null) continue;
    console.log(
      `${flags.apply ? 'MIGRATE' : 'DRY'} ${book.ref.path} ` +
      `currentPageUpdateId=${String(patch.currentPageUpdateId)}`,
    );
    writes += 1;
    if (!flags.apply) continue;
    await db.runTransaction(async (tx) => {
      const [freshBook, freshUpdates] = await Promise.all([
        tx.get(book.ref),
        tx.get(book.ref.collection('updates')),
      ]);
      if (!freshBook.exists) throw new Error(`${book.ref.path} disappeared during migration`);
      const freshPatch = planReadingProgressSource(
        freshBook.data() ?? {},
        freshUpdates.docs.map((update) => ({id: update.id, data: update.data()})),
      );
      if (freshPatch !== null) tx.update(book.ref, freshPatch);
    });
  }
}

console.log(
  `${writes} books ${flags.apply ? 'migrated' : 'need migration (dry run, nothing written)'}`,
);
