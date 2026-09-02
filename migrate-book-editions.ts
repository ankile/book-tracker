// Put every linked personal book on an edition of its work: mint one
// edition per reader per distinct book identity from the book's own fields
// (book-edition-backfill.ts plans it) and link the books to it. Additive
// and idempotent: an existing edition under the deterministic id, or an
// ISBN already indexed to the work, is joined rather than duplicated, and a
// book that already has an edition is left alone. Books the planner will
// not decide (merged work, ISBN indexed elsewhere, tombstoned owner) are
// printed as REVIEW lines and skipped.
//
//   node migrate-book-editions.ts                 # emulator dry-run
//   node migrate-book-editions.ts --apply         # emulator apply
//   node migrate-book-editions.ts --prod          # prod dry-run
//   node migrate-book-editions.ts --prod --apply  # prod apply (typed confirm)
import { Timestamp } from 'firebase-admin/firestore';
import { planBookEditions, type BackfillBook } from './book-edition-backfill.ts';
import { connect, parseFlags } from './migrate-lib.ts';

const flags = parseFlags(process.argv.slice(2));
if (flags.rest.length > 0) throw new Error(`unexpected arguments ${flags.rest.join(' ')}`);
const { db } = await connect({ prod: flags.prod, database: flags.database, confirmWrite: flags.prod && flags.apply });

const docs = async (name: string): Promise<Map<string, Record<string, unknown>>> =>
  new Map((await db.collection(name).get()).docs.map((doc) => [doc.id, doc.data()]));
const [works, editions, isbnIndex, users, bookDocs] = await Promise.all([
  docs('works'),
  docs('editions'),
  docs('isbnIndex'),
  db.collection('users').get(),
  db.collectionGroup('books').get(),
]);
const liveUserIds = new Set(users.docs.filter((doc) => doc.get('deletedAt') === undefined).map((doc) => doc.id));
const books: BackfillBook[] = bookDocs.docs.map((doc) => {
  const path = doc.ref.path.split('/');
  if (path.length !== 4 || path[0] !== 'users' || path[2] !== 'books') {
    throw new Error(`unexpected book path ${doc.ref.path}`);
  }
  return { uid: path[1], bookId: doc.id, data: doc.data() };
});

const plan = planBookEditions({ works, editions, isbnIndex, books, liveUserIds });
const linkedWithout = books.filter((book) =>
  typeof book.data.workId === 'string' && (book.data.editionId === null || book.data.editionId === undefined));
console.log(`linked books without an edition: ${linkedWithout.length} of ${books.length}`);
console.log(`planned: ${plan.editions.filter((edition) => edition.create).length} editions to create, ` +
  `${plan.editions.filter((edition) => edition.indexIsbn).length} ISBN index rows, ` +
  `${plan.editions.reduce((total, edition) => total + edition.bookPaths.length, 0)} books to link, ` +
  `${plan.review.length} for review`);
for (const edition of plan.editions) {
  console.log(`${edition.create ? 'CREATE' : 'JOIN  '} editions/${edition.editionId} work=${edition.workId} ` +
    `${JSON.stringify(edition.data.title)} isbn=${edition.data.isbn13 ?? '-'} pages=${edition.data.suggestedPageCount ?? '-'} ` +
    `by=${edition.uid} books=${edition.bookPaths.join(',')}`);
}
for (const item of plan.review) console.log(`REVIEW ${item.path}: ${item.reason}`);

if (!flags.apply) {
  console.log('dry-run: nothing written');
} else {
  let created = 0;
  let linked = 0;
  for (const edition of plan.editions) {
    const now = Timestamp.now();
    const batch = db.batch();
    if (edition.create) {
      batch.create(db.collection('editions').doc(edition.editionId), {
        ...edition.data, createdAt: now, updatedAt: now,
      });
      created += 1;
    }
    if (edition.indexIsbn && edition.data.isbn13 !== null) {
      batch.create(db.collection('isbnIndex').doc(edition.data.isbn13), {
        workId: edition.workId, editionId: edition.editionId,
      });
    }
    for (const path of edition.bookPaths) {
      batch.set(db.doc(path), { editionId: edition.editionId }, { merge: true });
      linked += 1;
    }
    await batch.commit();
  }
  console.log(`applied: ${created} editions created, ${linked} books linked`);
}
