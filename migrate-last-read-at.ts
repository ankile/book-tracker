// One-time lastReadAt backfill for books written before the field existed.
// Writes exactly one field per book that lacks it (a timestamp, or an
// explicit null for a book never read); never touches updatedAt,
// createdAt, or any update row. Idempotent: a second apply stamps nothing.
// See last-read-at-migration.ts for the rule.
//
//   node migrate-last-read-at.ts                    # emulator dry-run
//   node migrate-last-read-at.ts --apply            # emulator apply
//   node migrate-last-read-at.ts --prod             # prod dry-run
//   node migrate-last-read-at.ts --prod --apply     # prod apply (typed confirm)
//
// Every run prints one line per planned stamp (path, ISO date or null,
// which rule chose it, and the book's updatedAt beside it), REVIEW lines
// for books whose updatedAt is newer than the stamp — the books a metadata
// edit had moved up the reading list — and a summary.
import {parseFlags, connect} from './migrate-lib.ts';
import {planLastReadAt} from './last-read-at-migration.ts';

const flags = parseFlags(process.argv.slice(2));
if (flags.rest.length > 0) throw new Error(`unexpected arguments: ${flags.rest.join(' ')}`);
const {db} = await connect({...flags, confirmWrite: flags.apply});

const iso = (value: {toMillis(): number} | null) => value === null ? 'null' : new Date(value.toMillis()).toISOString();
let stamped = 0;
let never = 0;
let reviews = 0;

const users = await db.collection('users').listDocuments();
for (const user of users) {
  // A tombstoned account (SEC-006 soft delete) is frozen: the private
  // deletion runbook is the only thing that writes to it.
  const account = await user.get();
  if (account.get('deletedAt') !== undefined) {
    console.log(`SKIP tombstoned-account ${user.path}`);
    continue;
  }
  const books = await user.collection('books').get();
  for (const book of books.docs) {
    const plan = await (flags.apply
      ? db.runTransaction(async (tx) => {
        const [freshBook, freshUpdates] = await Promise.all([
          tx.get(book.ref),
          tx.get(book.ref.collection('updates')),
        ]);
        const freshData = freshBook.data();
        if (freshData === undefined) throw new Error(`${book.ref.path} disappeared during migration`);
        const fresh = planLastReadAt(
          freshData,
          freshUpdates.docs.map((update) => ({id: update.id, data: update.data()})),
        );
        if (fresh !== null) tx.update(book.ref, {lastReadAt: fresh.lastReadAt});
        return fresh;
      })
      : book.ref.collection('updates').get().then((updates) => planLastReadAt(
        book.data(),
        updates.docs.map((update) => ({id: update.id, data: update.data()})),
      )));
    if (plan === null) continue;
    const updatedAt = book.get('updatedAt') as {toMillis(): number} | undefined;
    console.log(`${flags.apply ? 'MIGRATE' : 'DRY'} ${book.ref.path} lastReadAt=${iso(plan.lastReadAt)} via=${plan.via} updatedAt=${iso(updatedAt ?? null)}`);
    if (plan.lastReadAt !== null && updatedAt !== undefined && updatedAt.toMillis() > plan.lastReadAt.toMillis()) {
      reviews += 1;
      console.log(`REVIEW ${book.ref.path} updatedAt is newer than the last reading row: a metadata edit had moved this book`);
    }
    if (plan.via === 'never') never += 1; else stamped += 1;
  }
}

console.log(`SUMMARY stamped:${stamped} never-read:${never} REVIEW:${reviews}`);
console.log(
  `${stamped + never} books ${flags.apply ? 'written' : 'need a lastReadAt (dry run, nothing written)'}`,
);
