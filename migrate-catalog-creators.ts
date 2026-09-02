// Stamp createdBy on every work, edition and catalog author that has none:
// the owner of the earliest personal book standing on the record
// (catalog-creator-backfill.ts plans it). Additive and idempotent: a record
// that carries a creator is left alone, so a rerun plans nothing. A record
// no personal book stands on is printed as a REVIEW line and skipped.
//
//   node migrate-catalog-creators.ts                 # emulator dry-run
//   node migrate-catalog-creators.ts --apply         # emulator apply
//   node migrate-catalog-creators.ts --prod          # prod dry-run
//   node migrate-catalog-creators.ts --prod --apply  # prod apply (typed confirm)
import { planCatalogCreators, type CreatorBook } from './catalog-creator-backfill.ts';
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

const plan = planCatalogCreators({ works, editions, authors, books });
const count = (collection: string): number => plan.creators.filter((creator) => creator.collection === collection).length;
const without = [...works.values(), ...editions.values(), ...authors.values()]
  .filter((record) => record.createdBy === undefined).length;
console.log(`records without a creator: ${without} of ${works.size + editions.size + authors.size}`);
console.log(`planned: ${count('works')} works, ${count('editions')} editions, ${count('catalogAuthors')} authors to stamp, ` +
  `${plan.review.length} for review`);
for (const creator of plan.creators) {
  console.log(`SET ${creator.collection}/${creator.id} createdBy=${creator.uid} first=${creator.bookPath} readers=${creator.readers}`);
}
for (const item of plan.review) console.log(`REVIEW ${item.collection}/${item.id}: ${item.reason}`);

if (!flags.apply) {
  console.log('dry-run: nothing written');
} else {
  let stamped = 0;
  for (let start = 0; start < plan.creators.length; start += 400) {
    const batch = db.batch();
    for (const creator of plan.creators.slice(start, start + 400)) {
      batch.update(db.collection(creator.collection).doc(creator.id), { createdBy: creator.uid });
      stamped += 1;
    }
    await batch.commit();
  }
  console.log(`applied: ${stamped} creators stamped`);
}
