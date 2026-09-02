// Move createdAt on every work, edition and catalog author back to the
// creation of its creator's first book standing on it, where that is
// earlier (catalog-creation-dates-backfill.ts plans it). The catalog build dated
// everything it minted with its own run. Idempotent: a record dated no later
// than that book is left alone, so a rerun plans nothing.
//
//   node migrate-catalog-creation-dates.ts                 # emulator dry-run
//   node migrate-catalog-creation-dates.ts --apply         # emulator apply
//   node migrate-catalog-creation-dates.ts --prod          # prod dry-run
//   node migrate-catalog-creation-dates.ts --prod --apply  # prod apply (typed confirm)
import { Timestamp } from 'firebase-admin/firestore';
import { planCatalogCreatedAt } from './catalog-creation-dates-backfill.ts';
import type { CreatorBook } from './catalog-creator-backfill.ts';
import { connect, parseFlags } from './migrate-lib.ts';

const flags = parseFlags(process.argv.slice(2));
if (flags.rest.length > 0) throw new Error(`unexpected arguments ${flags.rest.join(' ')}`);
const { db } = await connect({ prod: flags.prod, database: flags.database, confirmWrite: flags.prod && flags.apply });

const docs = async (name: string): Promise<Map<string, Record<string, unknown>>> =>
  new Map((await db.collection(name).get()).docs.map((doc) => [doc.id, doc.data()]));
const [works, editions, authors, bookDocs] = await Promise.all([
  docs('works'),
  docs('editions'),
  docs('catalogAuthors'),
  db.collectionGroup('books').get(),
]);
const books: CreatorBook[] = bookDocs.docs.map((doc) => {
  const path = doc.ref.path.split('/');
  if (path.length !== 4 || path[0] !== 'users' || path[2] !== 'books') {
    throw new Error(`unexpected book path ${doc.ref.path}`);
  }
  return { uid: path[1], bookId: doc.id, data: doc.data() };
});

const plan = planCatalogCreatedAt({ works, editions, authors, books });
const count = (collection: string): number => plan.records.filter((record) => record.collection === collection).length;
const iso = (millis: number): string => new Date(millis).toISOString();
console.log(`records dated after their creator's first book: ${plan.records.length} of ${works.size + editions.size + authors.size}`);
console.log(`planned: ${count('works')} works, ${count('editions')} editions, ${count('catalogAuthors')} authors to redate`);
for (const record of plan.records) {
  console.log(`SET ${record.collection}/${record.id} createdAt=${iso(record.createdAt)} was=${iso(record.was)} first=${record.bookPath}`);
}

if (!flags.apply) {
  console.log('dry-run: nothing written');
} else {
  let redated = 0;
  for (let start = 0; start < plan.records.length; start += 400) {
    const batch = db.batch();
    for (const record of plan.records.slice(start, start + 400)) {
      batch.update(db.collection(record.collection).doc(record.id), { createdAt: Timestamp.fromMillis(record.createdAt) });
      redated += 1;
    }
    await batch.commit();
  }
  console.log(`applied: ${redated} records redated`);
}
