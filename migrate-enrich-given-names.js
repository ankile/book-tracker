// Given-name enrichment for the surname-only person docs left by the
// pre-entity era of comma-separated entry ("Kahneman & Tversky" made a
// doc named just "Tversky"). The map below was curated by hand from the
// book covers the docs are attached to (2026-08-12); it is only valid
// for the OWNER account's docs, so the script is scoped to that uid —
// another user's "otto" could be a different Otto.
//
// Policy table:
//
//   doc id in GIVEN_NAMES, givenName absent   -> assert familyName matches
//                                                the id (unrenamed), set
//                                                givenName + rejoined
//                                                name/nameLower
//   doc id in GIVEN_NAMES, givenName present  -> skip (enriched, or the
//                                                user set one themselves)
//   enriched nameLower already exists on
//     another doc                             -> SKIP + report (that is a
//                                                merge, done in /authors)
//   doc id in KIND_FIXES                      -> not a person at all: set
//                                                kind, delete the parts
//   homer                                     -> untouched (true mononym)
//   doc updatedAt                             -> never written
//
// Idempotent: a clean re-run writes 0 ops. If a stale old client ever
// reverts a name via merge-upsert, the audit's name-parts-mismatch
// catches it (givenName survives the merge, the join no longer matches).
//
//   node migrate-enrich-given-names.js                    # emulator dry-run
//   node migrate-enrich-given-names.js --apply            # emulator apply
//   node migrate-enrich-given-names.js --prod             # prod dry-run
//   node migrate-enrich-given-names.js --prod --apply     # prod apply (typed confirm)
import { FieldValue } from 'firebase-admin/firestore';
import { parseFlags, connect, batcher } from './migrate-lib.js';
import { joinPersonName } from './src/lib/utils/authors.js';

const OWNER_UID = '1Cf0CaNfgnVSvTrF5dYjzRd9Xri2';

const GIVEN_NAMES = new Map([
  ['barto', 'Andrew G.'],        // Reinforcement Learning
  ['sutton', 'Richard S.'],      // Reinforcement Learning
  ['fisher', 'Roger'],           // Getting to Yes
  ['ury', 'William'],            // Getting to Yes
  ['gaiman', 'Neil'],            // Good Omens
  ['pratchett', 'Terry'],        // Good Omens
  ['goldstein', 'Joshua S.'],    // A Bright Future
  ['qvist', 'Staffan A.'],       // A Bright Future
  ['hunt', 'Andrew'],            // The Pragmatic Programmer
  ['thomas', 'David'],           // The Pragmatic Programmer
  ['safren', 'Steven A.'],       // Mastering Your Adult ADHD
  ['sprich', 'Susan E.'],        // Mastering Your Adult ADHD
  ['perlman', 'Carol A.'],       // Mastering Your Adult ADHD
  ['otto', 'Michael W.'],        // Mastering Your Adult ADHD
  ['posner', 'Eric A.'],         // Radical Markets
  ['weyl', 'E. Glen'],           // Radical Markets
  ['robinson', 'James A.'],      // Why Nations Fail
  ['savoie', 'Joey'],            // How to Launch a High-Impact Nonprofit
  ['stadler', 'Patrick'],        // How to Launch a High-Impact Nonprofit
  ['shann', 'Antonia'],          // How to Launch a High-Impact Nonprofit
]);

// "Stortinget" (the Norwegian parliament, on the Constitution) is an
// institution that the person-names migration could only treat as a
// person; it has no first name because it is not a person.
const KIND_FIXES = new Map([
  ['stortinget', 'entity'],
]);

const flags = parseFlags(process.argv.slice(2));
const { db } = await connect({ ...flags, confirmWrite: flags.apply });
const writes = batcher(db, { apply: flags.apply });
const tag = flags.apply ? 'UPDATE' : 'DRY';

const authorsCol = db.collection('users').doc(OWNER_UID).collection('authors');
const authorDocs = await authorsCol.get();
const nameLowers = new Map(authorDocs.docs.map((d) => [d.data().nameLower, d.id]));

let enriched = 0;
let kindsFixed = 0;
let skipped = 0;
for (const authorDoc of authorDocs.docs) {
  const a = authorDoc.data();
  const p = authorDoc.ref.path;

  if (KIND_FIXES.has(authorDoc.id)) {
    if (a.kind === KIND_FIXES.get(authorDoc.id)) continue;
    console.log(`${tag} ${p} kind ${a.kind} -> ${KIND_FIXES.get(authorDoc.id)}, parts removed`);
    await writes.update(authorDoc.ref, {
      kind: KIND_FIXES.get(authorDoc.id),
      givenName: FieldValue.delete(),
      familyName: FieldValue.delete(),
    });
    kindsFixed += 1;
    continue;
  }

  if (!GIVEN_NAMES.has(authorDoc.id)) continue;
  if (a.givenName !== undefined) continue;
  if (a.kind !== 'person' || a.familyName.toLowerCase() !== authorDoc.id) {
    throw new Error(`map entry no longer matches doc (renamed since curation?): ${p}`);
  }

  const givenName = GIVEN_NAMES.get(authorDoc.id);
  const name = joinPersonName({ givenName, familyName: a.familyName });
  const existing = nameLowers.get(name.toLowerCase());
  if (existing !== undefined && existing !== authorDoc.id) {
    console.log(`SKIP ${p} — "${name}" already exists as ${existing}; merge them in /authors instead`);
    skipped += 1;
    continue;
  }

  console.log(`${tag} ${p} [${a.name}] -> [${name}]`);
  await writes.update(authorDoc.ref, { givenName, name, nameLower: name.toLowerCase() });
  enriched += 1;
}

await writes.flush();
console.log(
  `${enriched} authors enriched, ${kindsFixed} kinds fixed, ${skipped} skipped, ` +
  `${writes.count()} total ops ${flags.apply ? 'applied' : '(dry run, nothing written)'}`
);
