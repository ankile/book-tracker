// Stamp a default language on every work that has none and the carried copy
// on every personal book that has none (work-language-backfill.ts plans it:
// editions' overrides, else the ISBN registration group, else unknown and
// listed for review). Additive and idempotent: a work that carries the
// field, and a book that carries a language or '' where nothing better is
// known, are left alone, so a rerun plans nothing.
//
//   node migrate-work-languages.ts                 # emulator dry-run
//   node migrate-work-languages.ts --apply         # emulator apply
//   node migrate-work-languages.ts --prod          # prod dry-run
//   node migrate-work-languages.ts --prod --apply  # prod apply (typed confirm)
import { planWorkLanguages, type LanguageBook } from './work-language-backfill.ts';
import { connect, parseFlags } from './migrate-lib.ts';

const flags = parseFlags(process.argv.slice(2));
if (flags.rest.length > 0) throw new Error(`unexpected arguments ${flags.rest.join(' ')}`);
const { db } = await connect({ prod: flags.prod, database: flags.database, confirmWrite: flags.prod && flags.apply });

const docs = async (name: string): Promise<Map<string, Record<string, unknown>>> =>
  new Map((await db.collection(name).get()).docs.map((doc) => [doc.id, doc.data()]));
const [works, editions, bookDocs] = await Promise.all([
  docs('works'),
  docs('editions'),
  db.collectionGroup('books').get(),
]);
const books: LanguageBook[] = bookDocs.docs.map((doc) => {
  const path = doc.ref.path.split('/');
  if (path.length !== 4 || path[0] !== 'users' || path[2] !== 'books') {
    throw new Error(`unexpected book path ${doc.ref.path}`);
  }
  return { uid: path[1], bookId: doc.id, data: doc.data() };
});

const plan = planWorkLanguages({ works, editions, books });
const bySource = (source: string): number => plan.works.filter((work) => work.source === source).length;
console.log(`works without a language field: ${plan.works.length} of ${works.size}; ` +
  `books without one: ${books.filter((book) => book.data.language === undefined).length} of ${books.length}`);
console.log(`planned: ${plan.works.length} works (${bySource('editions')} from editions, ` +
  `${bySource('isbn-group')} from ISBN groups, ${bySource('none')} unknown), ` +
  `${plan.books.length} books, ${plan.review.length} for review`);
for (const work of plan.works) {
  console.log(`SET works/${work.id} language=${JSON.stringify(work.language)} via=${work.source}`);
}
for (const book of plan.books) {
  console.log(`SET users/${book.uid}/books/${book.bookId} language=${JSON.stringify(book.language)}`);
}
for (const item of plan.review) console.log(`REVIEW works/${item.id}: ${item.reason}`);

if (!flags.apply) {
  console.log('dry-run: nothing written');
} else {
  const updates = [
    ...plan.works.map((work) => ({ ref: db.collection('works').doc(work.id), language: work.language })),
    ...plan.books.map((book) => ({ ref: db.doc(`users/${book.uid}/books/${book.bookId}`), language: book.language })),
  ];
  for (let start = 0; start < updates.length; start += 400) {
    const batch = db.batch();
    for (const update of updates.slice(start, start + 400)) batch.update(update.ref, { language: update.language });
    await batch.commit();
  }
  console.log(`applied: ${plan.works.length} works and ${plan.books.length} books stamped`);
}
