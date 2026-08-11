// Person-name-parts migration: person author docs get explicit
// givenName/familyName, prefilled by the last-token split of the stored
// name. The split is the same prefill the entry form now shows, so any
// "Le Guin"-style corrections are made afterward in the /authors edit
// modal — this script only makes the parts exist.
//
// Policy table:
//
//   kind 'person', familyName present     -> skip (migrated; never
//                                            rewritten, edits are truth)
//   kind 'person', familyName missing     -> split name: last token ->
//                                            familyName, rest ->
//                                            givenName (omitted when
//                                            empty — mononyms)
//   kind 'entity' / 'placeholder'         -> skip (no parts by design)
//   kind missing/invalid                  -> crash (run
//                                            migrate-author-ids.js first)
//   doc updatedAt                         -> never written
//
// Idempotent: a clean re-run writes 0 ops.
//
//   node migrate-person-names.js                    # emulator dry-run
//   node migrate-person-names.js --apply            # emulator apply
//   node migrate-person-names.js --prod             # prod dry-run
//   node migrate-person-names.js --prod --apply     # prod apply (typed confirm)
import { parseFlags, connect, batcher } from './migrate-lib.js';
import { AUTHOR_KINDS, splitPersonName } from './src/lib/utils/authors.js';

const flags = parseFlags(process.argv.slice(2));
const { db } = await connect({ ...flags, confirmWrite: flags.apply });
const writes = batcher(db, { apply: flags.apply });
const tag = flags.apply ? 'UPDATE' : 'DRY';

let backfilled = 0;
const users = await db.collection('users').get();
for (const user of users.docs) {
  const authorDocs = await user.ref.collection('authors').get();
  for (const authorDoc of authorDocs.docs) {
    const a = authorDoc.data();
    if (!AUTHOR_KINDS.includes(a.kind)) throw new Error(`author doc without valid kind (run migrate-author-ids.js first): ${authorDoc.ref.path}`);
    if (a.kind !== 'person' || a.familyName !== undefined) continue;

    const { givenName, familyName } = splitPersonName(a.name);
    const patch = givenName === '' ? { familyName } : { givenName, familyName };
    console.log(`${tag} ${authorDoc.ref.path} [${a.name}] -> given [${givenName}] family [${familyName}]`);
    await writes.update(authorDoc.ref, patch);
    backfilled += 1;
  }
}

await writes.flush();
console.log(`${backfilled} person docs backfilled, ${writes.count()} total ops ${flags.apply ? 'applied' : '(dry run, nothing written)'}`);
