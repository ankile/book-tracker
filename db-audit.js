// Read-only drift report over the whole database. Run before and after
// every migration and diff the outputs: deterministic path-sorted lines,
// one per finding, then per-class counts.
//
// Book/update traversal uses .get() (the migration convention — orphans
// under deleted parents are not data to repair); the dedicated orphan
// checks at the end use listDocuments() diffs to REPORT those orphans.
//
//   node db-audit.js            # emulator
//   node db-audit.js --prod     # production (read-only)
import { parseFlags, connect } from './migrate-lib.js';
import { isFinished } from './src/lib/utils/finished.js';

const flags = parseFlags(process.argv.slice(2));
const { db } = await connect(flags);

const findings = [];
const found = (cls, path, detail = '') => findings.push({ cls, path, detail });

const users = await db.collection('users').get();

for (const user of users.docs) {
  const books = await user.ref.collection('books').get();

  for (const book of books.docs) {
    const b = book.data();
    const p = book.ref.path;

    for (const field of ['createdAt', 'updatedAt', 'author', 'isbn', 'owner', 'pagesRead', 'timeRead', 'finished', 'currentPage', 'pageCount']) {
      if (b[field] === undefined) found(`book.missing.${field}`, p);
    }
    for (const field of ['currentPage', 'pageCount', 'pagesRead', 'timeRead']) {
      if (b[field] !== undefined && !Number.isFinite(b[field])) {
        found(`book.nonnumeric.${field}`, p, String(b[field]));
      }
    }
    if (b.finished === true && b.currentPage === undefined && b.pageCount === undefined) {
      found('book.finished-no-pages', p);
    } else if (b.finished === true && !isFinished(b.currentPage, b.pageCount)) {
      found('book.finished-pages-disagree', p, `${b.currentPage}/${b.pageCount}`);
    }
    if (b.finished !== true && isFinished(b.currentPage, b.pageCount)) {
      found('book.unfinished-pages-equal', p, `${b.currentPage}/${b.pageCount}`);
    }
    if (Number.isFinite(b.currentPage) && Number.isFinite(b.pageCount) && b.currentPage > b.pageCount) {
      found('book.page-overrun', p, `${b.currentPage}/${b.pageCount}`);
    }
    if (b.activeTimer) found('book.active-timer', p, JSON.stringify(b.activeTimer));

    // Author pre-flight for the authors migration.
    if (typeof b.author === 'string') {
      if (b.author.trim() === '') found('author.empty', p);
      if (b.author.includes(',')) found('author.has-comma', p, b.author);
      if (b.author.includes('&')) found('author.has-ampersand', p, b.author);
      if (/\band\b/i.test(b.author)) found('author.has-and', p, b.author);
    }

    const updates = await book.ref.collection('updates').get();
    for (const update of updates.docs) {
      const u = update.data();
      const up = update.ref.path;
      if (!['reading', 'update'].includes(u.type)) found('update.bad-type', up, String(u.type));
      if (u.owner === undefined) found('update.missing.owner', up);
      if (u.createdAt === undefined) found('update.missing.createdAt', up);
      if (u.book === undefined) found('update.missing.book', up);
      if (Number.isFinite(u.fromPage) && Number.isFinite(u.toPage) && u.pagesRead !== u.toPage - u.fromPage) {
        found('update.pages-arithmetic', up, `${u.fromPage}->${u.toPage} pagesRead=${u.pagesRead}`);
      }
    }
  }
}

// Orphans: parents that are listable but do not exist as documents, with
// children underneath. Report-only, never repaired (see migrate-add-owner).
const listedUsers = await db.collection('users').listDocuments();
const existingUsers = new Set(users.docs.map((d) => d.id));
for (const ref of listedUsers) {
  if (!existingUsers.has(ref.id)) found('orphan.user', ref.path);
}
for (const user of users.docs) {
  const listedBooks = await user.ref.collection('books').listDocuments();
  const existing = new Set((await user.ref.collection('books').get()).docs.map((d) => d.id));
  for (const ref of listedBooks) {
    if (!existing.has(ref.id)) found('orphan.book', ref.path);
  }
}

// Distinct author strings, for the authors-migration pre-flight summary.
const authorSet = new Set();
for (const user of users.docs) {
  const books = await user.ref.collection('books').get();
  for (const book of books.docs) {
    const a = book.data().author;
    if (typeof a === 'string' && a.trim() !== '') authorSet.add(a.trim());
  }
}

findings.sort((a, b) => (a.cls === b.cls ? (a.path < b.path ? -1 : 1) : a.cls < b.cls ? -1 : 1));
for (const f of findings) {
  console.log(`${f.cls} ${f.path}${f.detail ? ` [${f.detail}]` : ''}`);
}
console.log('---');
const counts = {};
for (const f of findings) counts[f.cls] = (counts[f.cls] ?? 0) + 1;
for (const cls of Object.keys(counts).sort()) console.log(`${cls}: ${counts[cls]}`);
console.log(`users: ${users.size}`);
console.log(`distinct-author-strings: ${authorSet.size}`);
console.log(`findings: ${findings.length}`);
