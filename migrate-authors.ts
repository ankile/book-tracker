// Authors migration: make authors first-class entities. For every book
// without an authors array, split the legacy author string, upsert one
// users/{uid}/authors/{authorId} doc per name, and write the authors array
// (plus the re-joined canonical author string) onto the book. Books whose
// author string is empty get authors: []. Idempotent: books with an
// authors array are skipped entirely, so a clean re-run writes 0.
//
// The book's updatedAt is deliberately untouched (batcher enforces it) —
// list order must not change. Author docs are set() with merge, which may
// legitimately stamp their own updatedAt.
//
//   node migrate-authors.ts                    # emulator dry-run
//   node migrate-authors.ts --apply            # emulator apply
//   node migrate-authors.ts --prod             # prod dry-run
//   node migrate-authors.ts --prod --apply     # prod apply (typed confirm)
import { Timestamp } from 'firebase-admin/firestore';
import { parseFlags, connect, batcher } from './migrate-lib.ts';
import { splitAuthors, joinAuthors, authorIdFor } from './src/lib/utils/authors.ts';

const flags = parseFlags(process.argv.slice(2));
const { db } = await connect({ ...flags, confirmWrite: flags.apply });
const writes = batcher(db, { apply: flags.apply });

let booksMigrated = 0;
const users = await db.collection('users').get();
for (const user of users.docs) {
  const books = await user.ref.collection('books').get();
  for (const book of books.docs) {
    const b = book.data();
    if (Array.isArray(b.authors)) continue;

    const names = splitAuthors(b.author ?? '');
    const authors: Array<{ id: string; name: string }> = [];
    for (const name of names) {
      const id = authorIdFor(name);
      authors.push({ id, name });
      await writes.set(
        user.ref.collection('authors').doc(id),
        { name, nameLower: name.toLowerCase(), updatedAt: Timestamp.now() },
        { merge: true },
      );
    }
    console.log(`${flags.apply ? 'UPDATE' : 'DRY'} ${book.ref.path} [${b.author ?? '<none>'}] -> [${names.join(' | ')}]`);
    await writes.update(book.ref, { authors, author: joinAuthors(names) });
    booksMigrated += 1;
  }
}
await writes.flush();
console.log(`${booksMigrated} books migrated, ${writes.count()} total ops ${flags.apply ? 'applied' : '(dry run, nothing written)'}`);
