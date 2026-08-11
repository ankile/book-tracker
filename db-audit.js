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
import { AUTHOR_KINDS, joinPersonName } from './src/lib/utils/authors.js';

const flags = parseFlags(process.argv.slice(2));
const { db } = await connect(flags);

const findings = [];
const found = (cls, path, detail = '') => findings.push({ cls, path, detail });

const users = await db.collection('users').get();

// Info-level author bookkeeping (summary lines, not findings): orphaned
// author docs are a legitimate steady state — deleting or editing a book
// never garbage-collects its authors, and an orphan is still useful for
// autocomplete — but the counts make drift visible in audit diffs.
let authorDocCount = 0;
let authorOrphanCount = 0;

for (const user of users.docs) {
  const books = await user.ref.collection('books').get();

  // Author entity checks: doc shape only. Ids are deterministic at
  // creation but OPAQUE afterward (rename edits name/nameLower in place),
  // so id === authorIdFor(name) is deliberately NOT an invariant.
  const authorDocs = await user.ref.collection('authors').get();
  const authorDocIds = new Set(authorDocs.docs.map((d) => d.id));
  authorDocCount += authorDocs.size;
  for (const authorDoc of authorDocs.docs) {
    const a = authorDoc.data();
    const ap = authorDoc.ref.path;
    if (typeof a.name !== 'string' || a.name.trim() === '') {
      found('authordoc.bad-name', ap, JSON.stringify(a.name));
    } else if (a.nameLower !== a.name.toLowerCase()) {
      found('authordoc.namelower-mismatch', ap, `${a.nameLower} != ${a.name.toLowerCase()}`);
    }
    if (!AUTHOR_KINDS.includes(a.kind)) found('authordoc.bad-kind', ap, String(a.kind));
    // Persons carry explicit name parts; the stored name is exactly their
    // join, so display, sorting, and abbreviation can never disagree.
    if (a.kind === 'person') {
      if (typeof a.familyName !== 'string' || a.familyName.trim() === '') {
        found('authordoc.missing-familyname', ap, a.name);
      } else {
        if (a.givenName !== undefined && (typeof a.givenName !== 'string' || a.givenName.trim() === '')) {
          found('authordoc.bad-givenname', ap, JSON.stringify(a.givenName));
        }
        const joined = joinPersonName({ givenName: a.givenName ?? '', familyName: a.familyName });
        if (a.name !== joined) found('authordoc.name-parts-mismatch', ap, `${a.name} != ${joined}`);
      }
    } else if (a.givenName !== undefined || a.familyName !== undefined) {
      found('authordoc.parts-on-nonperson', ap, a.name);
    }
  }

  const referencedAuthorIds = new Set();

  for (const book of books.docs) {
    const b = book.data();
    const p = book.ref.path;

    for (const field of ['createdAt', 'updatedAt', 'authorIds', 'isbn', 'owner', 'pagesRead', 'timeRead', 'finished', 'currentPage', 'pageCount']) {
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

    // Author references: every id resolves to an author doc, no dupes.
    if (b.authorIds !== undefined) {
      if (
        !Array.isArray(b.authorIds) ||
        b.authorIds.some((id) => typeof id !== 'string' || id === '') ||
        new Set(b.authorIds).size !== b.authorIds.length
      ) {
        found('book.authorids-bad-shape', p, JSON.stringify(b.authorIds));
      } else {
        for (const id of b.authorIds) {
          referencedAuthorIds.add(id);
          if (!authorDocIds.has(id)) found('book.author-doc-missing', p, id);
        }
      }
    }

    // Legacy authorship fields mean the last writer was an old client (the
    // current client deletes them on every write): this is the migration
    // pre-flight before the authorIds run, and the straggler detector
    // after it — a migration re-run clears it either way.
    if (b.author !== undefined || b.authors !== undefined) {
      const which = ['author', 'authors'].filter((f) => b[f] !== undefined).join('+');
      found('book.legacy-author-field', p, which);
      if (Array.isArray(b.authors)) {
        for (const a of b.authors) referencedAuthorIds.add(a.id);
      }
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

  for (const authorDoc of authorDocs.docs) {
    if (!referencedAuthorIds.has(authorDoc.id)) authorOrphanCount += 1;
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

findings.sort((a, b) => (a.cls === b.cls ? (a.path < b.path ? -1 : 1) : a.cls < b.cls ? -1 : 1));
for (const f of findings) {
  console.log(`${f.cls} ${f.path}${f.detail ? ` [${f.detail}]` : ''}`);
}
console.log('---');
const counts = {};
for (const f of findings) counts[f.cls] = (counts[f.cls] ?? 0) + 1;
for (const cls of Object.keys(counts).sort()) console.log(`${cls}: ${counts[cls]}`);
console.log(`users: ${users.size}`);
console.log(`author-docs: ${authorDocCount}`);
console.log(`author-orphans: ${authorOrphanCount}`);
console.log(`findings: ${findings.length}`);
