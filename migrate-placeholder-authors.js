// Repair migration: placeholder attributions are not author entities.
// The first authors migration turned every author string into entities,
// including placeholders like "Various Authors" (the Bible). The rule now
// is: placeholders yield no entities — the book keeps its raw author
// string as display text with authors: []. This script applies that rule
// retroactively: strips placeholder entries from books' authors arrays
// (leaving the author string untouched when nothing remains, re-joining
// it when real co-authors remain) and deletes placeholder author docs so
// autocomplete never suggests them. Idempotent: a clean re-run writes 0.
//
//   node migrate-placeholder-authors.js                    # emulator dry-run
//   node migrate-placeholder-authors.js --apply            # emulator apply
//   node migrate-placeholder-authors.js --prod             # prod dry-run
//   node migrate-placeholder-authors.js --prod --apply     # prod apply
import { parseFlags, connect, batcher } from './migrate-lib.js';
import { joinAuthors, isPlaceholderAuthor } from './src/lib/utils/authors.js';

const flags = parseFlags(process.argv.slice(2));
const { db } = await connect({ ...flags, confirmWrite: flags.apply });
const writes = batcher(db, { apply: flags.apply });

const users = await db.collection('users').get();
for (const user of users.docs) {
  const books = await user.ref.collection('books').get();
  for (const book of books.docs) {
    const b = book.data();
    if (!Array.isArray(b.authors)) continue;
    const kept = b.authors.filter((a) => !isPlaceholderAuthor(a.name));
    if (kept.length === b.authors.length) continue;

    const patch = { authors: kept };
    // With real co-authors left, the string stays the canonical join;
    // with none, the existing string IS the placeholder display text.
    if (kept.length > 0) patch.author = joinAuthors(kept.map((a) => a.name));
    console.log(`${flags.apply ? 'UPDATE' : 'DRY'} ${book.ref.path} [${b.author}] authors ${b.authors.length} -> ${kept.length}`);
    await writes.update(book.ref, patch);
  }

  const authorDocs = await user.ref.collection('authors').get();
  for (const authorDoc of authorDocs.docs) {
    if (isPlaceholderAuthor(authorDoc.data().name)) {
      console.log(`${flags.apply ? 'DELETE' : 'DRY-DELETE'} ${authorDoc.ref.path} [${authorDoc.data().name}]`);
      await writes.delete(authorDoc.ref);
    }
  }
}
await writes.flush();
console.log(`${writes.count()} ops ${flags.apply ? 'applied' : '(dry run, nothing written)'}`);
