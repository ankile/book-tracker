// One-time finishedAt backfill for books finished before the field existed.
// Writes exactly one field per finished book that lacks it; never touches
// updatedAt, createdAt, or any update row. Idempotent: a second apply
// stamps nothing. See finished-at-migration.ts for the rule.
//
//   node migrate-finished-at.ts                    # emulator dry-run
//   node migrate-finished-at.ts --apply            # emulator apply
//   node migrate-finished-at.ts --prod             # prod dry-run
//   node migrate-finished-at.ts --prod --apply     # prod apply (typed confirm)
//
// Every run prints one line per planned stamp (path, ISO date, which rule
// chose it), REVIEW lines for books with a row newer than the chosen
// progress row, and a per-user count of stamps by finish year — compare
// the latter with the "books by year" table on /me before applying.
import {parseFlags, connect} from './migrate-lib.ts';
import {planFinishedAt, type FinishedAtSource} from './finished-at-migration.ts';

const flags = parseFlags(process.argv.slice(2));
if (flags.rest.length > 0) throw new Error(`unexpected arguments: ${flags.rest.join(' ')}`);
const {db} = await connect({...flags, confirmWrite: flags.apply});

const iso = (value: {toMillis(): number}) => new Date(value.toMillis()).toISOString();
const bySource = new Map<FinishedAtSource, number>();
const byUserYear = new Map<string, Map<number, number>>();
let writes = 0;
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
        const fresh = planFinishedAt(
          freshData,
          freshUpdates.docs.map((update) => ({id: update.id, data: update.data()})),
        );
        if (fresh !== null) tx.update(book.ref, {finishedAt: fresh.finishedAt});
        return fresh;
      })
      : book.ref.collection('updates').get().then((updates) => planFinishedAt(
        book.data(),
        updates.docs.map((update) => ({id: update.id, data: update.data()})),
      )));
    if (plan === null) continue;
    console.log(`${flags.apply ? 'MIGRATE' : 'DRY'} ${book.ref.path} finishedAt=${iso(plan.finishedAt)} via=${plan.via}`);
    if (plan.laterRowAt !== null) {
      reviews += 1;
      console.log(`REVIEW ${book.ref.path} a later non-progress row exists at ${iso(plan.laterRowAt)}; stamped from the last forward progress`);
    }
    writes += 1;
    bySource.set(plan.via, (bySource.get(plan.via) ?? 0) + 1);
    const year = new Date(plan.finishedAt.toMillis()).getFullYear();
    const years = byUserYear.get(user.id) ?? new Map<number, number>();
    years.set(year, (years.get(year) ?? 0) + 1);
    byUserYear.set(user.id, years);
  }
}

for (const [uid, years] of byUserYear) {
  const table = [...years].sort(([a], [b]) => a - b).map(([year, count]) => `${year}:${count}`).join(' ');
  console.log(`YEARS users/${uid} ${table}`);
}
console.log(`SOURCES ${[...bySource].map(([via, count]) => `${via}:${count}`).join(' ')} REVIEW:${reviews}`);
console.log(
  `${writes} books ${flags.apply ? 'stamped' : 'need a finishedAt stamp (dry run, nothing written)'}`,
);
