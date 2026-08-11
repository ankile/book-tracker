// Author-ids migration: books reference authors by id only. Rebuild
// authorIds from the legacy fields on every book that still carries them,
// delete those fields, and backfill the explicit kind on author docs.
//
// Policy table (re-run reconciliation — legacy fields present means the
// LAST WRITER WAS AN OLD CLIENT; the new client deletes them on every
// write, so legacy is always the newer truth over any authorIds on the
// same doc):
//
//   authorIds present, no author/authors        -> skip (migrated, clean)
//   authors: [{id,name},...] non-empty          -> authorIds := ids (assert
//                                                  id === authorIdFor(name)
//                                                  and no dup ids: violation
//                                                  means an unmodeled
//                                                  writer, crash), mint any
//                                                  missing docs, DELETE
//                                                  author+authors
//   author string only (authors undefined)      -> splitAuthors, mint docs
//                                                  as persons, authorIds :=
//                                                  ids, DELETE author
//                                                  (pre-entity-era client)
//   authors: [], author non-empty               -> the old client dropped
//                                                  the text as a
//                                                  placeholder: mint docs
//                                                  as kind 'placeholder',
//                                                  authorIds := ids, DELETE
//                                                  legacy
//   legacy empty ('' / []), stale authorIds
//     non-empty                                 -> report + SKIP (an
//                                                  old-client edit blanked
//                                                  the form; the stale ids
//                                                  are the only surviving
//                                                  attribution — human
//                                                  call, recover from the
//                                                  snapshot)
//   legacy empty, no/empty authorIds            -> authorIds := [], DELETE
//                                                  legacy
//   none of author/authors/authorIds            -> crash (unknown shape)
//   author doc without kind                     -> kind := KINDS pin by
//                                                  nameLower, else 'person'
//   existing author docs                        -> name/kind NEVER
//                                                  rewritten from book
//                                                  data (a rename must
//                                                  survive re-runs)
//   book updatedAt                              -> never written (batcher
//                                                  enforces)
//
// Idempotent: a clean re-run writes 0 ops.
//
//   node migrate-author-ids.js                    # emulator dry-run
//   node migrate-author-ids.js --apply            # emulator apply
//   node migrate-author-ids.js --prod             # prod dry-run
//   node migrate-author-ids.js --prod --apply     # prod apply (typed confirm)
import { Timestamp, FieldValue } from 'firebase-admin/firestore';
import { parseFlags, connect, batcher } from './migrate-lib.js';
import { splitAuthors, authorIdFor } from './src/lib/utils/authors.js';

// Pinned kinds for known non-person authors that predate the kind field,
// keyed by authorIdFor-normalized name; everything else this script mints
// or backfills is a person (placeholder branch aside). Extend if more
// surface before their books are edited. Pre-kind docs have never been
// renamed (every rename also writes kind), so their id IS the normalized
// name and the backfill can key on it.
const KINDS = new Map([
  ['harvard business review', 'entity'],
]);

const flags = parseFlags(process.argv.slice(2));
const { db } = await connect({ ...flags, confirmWrite: flags.apply });
const writes = batcher(db, { apply: flags.apply });
const tag = flags.apply ? 'UPDATE' : 'DRY';

let booksMigrated = 0;
let kindsBackfilled = 0;
let skipped = 0;

const users = await db.collection('users').get();
for (const user of users.docs) {
  const authorDocs = await user.ref.collection('authors').get();
  const knownIds = new Set(authorDocs.docs.map((d) => d.id));

  // Kind backfill on pre-kind docs. update(), and only when the field is
  // missing: an already-assigned kind (or a rename) is never clobbered.
  for (const authorDoc of authorDocs.docs) {
    const a = authorDoc.data();
    if (a.kind !== undefined) continue;
    const kind = KINDS.get(authorDoc.id) ?? 'person';
    console.log(`${tag} ${authorDoc.ref.path} kind := ${kind}`);
    await writes.update(authorDoc.ref, { kind });
    kindsBackfilled += 1;
  }

  // Mint an author doc unless it exists; existing docs are the truth (the
  // legacy name embedded on a book is historical once a rename happened).
  const mint = async (id, name, kindIfNew) => {
    if (knownIds.has(id)) return;
    knownIds.add(id);
    await writes.set(
      user.ref.collection('authors').doc(id),
      {
        name,
        nameLower: name.toLowerCase(),
        kind: KINDS.get(authorIdFor(name)) ?? kindIfNew,
        updatedAt: Timestamp.now(),
      },
      { merge: true },
    );
  };

  const books = await user.ref.collection('books').get();
  for (const book of books.docs) {
    const b = book.data();
    const p = book.ref.path;
    const legacyPresent = b.author !== undefined || b.authors !== undefined;

    if (!legacyPresent) {
      if (!Array.isArray(b.authorIds)) throw new Error(`unknown book shape (no authorship at all): ${p}`);
      continue;
    }

    let authorIds;
    let legacyDescription;
    if (Array.isArray(b.authors) && b.authors.length > 0) {
      const ids = b.authors.map((a) => a.id);
      if (new Set(ids).size !== ids.length) throw new Error(`duplicate ids in legacy authors array: ${p}`);
      for (const a of b.authors) {
        if (a.id !== authorIdFor(a.name)) throw new Error(`unmodeled writer, id/name mismatch on ${p}: ${a.id} != ${authorIdFor(a.name)}`);
        await mint(a.id, a.name, 'person');
      }
      authorIds = ids;
      legacyDescription = `authors: ${b.authors.map((a) => a.name).join(' | ')}`;
    } else {
      const names = splitAuthors(b.author ?? '');
      if (names.length === 0 && Array.isArray(b.authorIds) && b.authorIds.length > 0) {
        console.log(`SKIP ${p} — legacy authorship empty but stale authorIds [${b.authorIds.join(' | ')}] survive; needs a human decision`);
        skipped += 1;
        continue;
      }
      // authors: [] means the old client dropped the raw text as a
      // placeholder attribution; authors undefined is a pre-entity-era
      // string of ordinary names.
      const kindIfNew = Array.isArray(b.authors) ? 'placeholder' : 'person';
      authorIds = [];
      for (const name of names) {
        const id = authorIdFor(name);
        await mint(id, name, kindIfNew);
        authorIds.push(id);
      }
      legacyDescription = `author: ${b.author ?? '<none>'}`;
    }

    console.log(`${tag} ${p} [${legacyDescription}] -> authorIds [${authorIds.join(' | ')}]`);
    await writes.update(book.ref, {
      authorIds,
      author: FieldValue.delete(),
      authors: FieldValue.delete(),
    });
    booksMigrated += 1;
  }
}

await writes.flush();
console.log(
  `${booksMigrated} books migrated, ${kindsBackfilled} author kinds backfilled, ` +
  `${skipped} skipped, ${writes.count()} total ops ${flags.apply ? 'applied' : '(dry run, nothing written)'}`
);
