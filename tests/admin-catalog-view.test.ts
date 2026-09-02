import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AdminCatalogAuthorRow,
  AdminCatalogBookRow,
  AdminCatalogEditionRow,
  AdminCatalogOperation,
  AdminCatalogWorkRow,
} from '../src/lib/interfaces/catalog.ts';
import {
  authorSearchText,
  booksByWork,
  buildOperation,
  createAuthorDraft,
  createEditionDraft,
  createWorkDraft,
  creatorLabel,
  duplicateFindingsFor,
  editAuthorDraft,
  editEditionDraft,
  editWorkDraft,
  filterRows,
  hideWorkDraft,
  linkBooksDraft,
  mergeAuthorsDraft,
  mergeIntoOldestDraft,
  mergeWorksDraft,
  operationTitle,
  repointIsbnDraft,
  sortAuthors,
  workSearchText,
  worksByAuthor,
} from '../src/lib/utils/adminCatalogView.ts';

const work = (overrides: Partial<AdminCatalogWorkRow> = {}): AdminCatalogWorkRow => ({
  workId: 'work-a', canonicalTitle: 'The Left Hand of Darkness', alternateTitles: ['Left Hand'],
  authorIds: ['le-guin'], coverUrl: 'https://covers.test/a.jpg', subjects: ['Science fiction'],
  fiction: true, status: 'active', mergedInto: null, mergedFrom: [], createdBy: null,
  createdAt: 1000, editionCount: 1, linkedBookCount: 0, warnings: [], ...overrides,
});
const author = (overrides: Partial<AdminCatalogAuthorRow> = {}): AdminCatalogAuthorRow => ({
  authorId: 'le-guin', canonicalName: 'Ursula K. Le Guin', alternateNames: ['Ursula Le Guin'],
  sortName: 'Le Guin', kind: 'person', status: 'active', mergedInto: null, mergedFrom: [],
  createdAt: 500, workCount: 1, warnings: [], ...overrides,
});
const edition = (overrides: Partial<AdminCatalogEditionRow> = {}): AdminCatalogEditionRow => ({
  editionId: 'edition-a', workId: 'work-a', isbn13: '9780441478125',
  title: 'The Left Hand of Darkness', publisher: 'Ace', publishedDate: '1987', language: 'en',
  translatorNames: [], format: 'full', suggestedPageCount: 304, coverUrl: '',
  externalIds: {'open-library': 'OL1M', 'google-books': 'abc'}, ...overrides,
});
const book = (overrides: Partial<AdminCatalogBookRow> = {}): AdminCatalogBookRow => ({
  uid: 'reader', bookId: 'book-1', title: 'Left Hand', authorNames: ['Ursula K. Le Guin'],
  isbn13: null, rawIsbn: null, pageCount: 300, publisher: '', coverUrl: '', workId: 'work-a',
  editionId: null, anomaly: null, ...overrides,
});

function operationOf<T extends AdminCatalogOperation['type']>(
  operation: AdminCatalogOperation,
  type: T,
): Extract<AdminCatalogOperation, {type: T}> {
  assert.equal(operation.type, type);
  return operation as Extract<AdminCatalogOperation, {type: T}>;
}

test('edit and hide drafts round-trip a work row into the edit operation', () => {
  assert.deepEqual(buildOperation(editWorkDraft(work({fiction: null, subjects: []}))), {
    type: 'editWork', workId: 'work-a', status: 'active',
    work: {
      canonicalTitle: 'The Left Hand of Darkness', alternateTitles: ['Left Hand'],
      authorIds: ['le-guin'], coverUrl: 'https://covers.test/a.jpg', subjects: [], fiction: null,
    },
  });
  const hidden = operationOf(buildOperation(hideWorkDraft(work())), 'editWork');
  assert.equal(hidden.status, 'hidden');
  assert.equal(hidden.work.fiction, true);
  // A hidden work opens as hidden, so a plain edit does not unhide it.
  const kept = operationOf(buildOperation(editWorkDraft(work({status: 'hidden', fiction: false}))), 'editWork');
  assert.equal(kept.status, 'hidden');
  assert.equal(kept.work.fiction, false);
  assert.equal(operationTitle(editWorkDraft(work())), 'Edit work');
});

test('work drafts are validated before any preview is requested', () => {
  assert.throws(() => buildOperation(editWorkDraft(work({canonicalTitle: '  '}))), /Canonical title is required/);
  assert.throws(() => buildOperation(editWorkDraft(work({authorIds: []}))), /At least one catalog author ID/);
  assert.throws(() => buildOperation(editWorkDraft(work({workId: 'a/b'}))), /Work ID must be one Firestore document ID/);

  const draft = createWorkDraft([{uid: 'u', bookId: 'b'}]);
  if (draft.type !== 'createWork') throw new Error('expected a createWork draft');
  assert.match(draft.workId, /^work-[0-9a-f-]{36}$/u);
  assert.equal(operationTitle(draft), 'New work');
  draft.canonicalTitle = 'Dune';
  draft.authorIds = 'herbert\n\nherbert';
  const created = operationOf(buildOperation(draft), 'createWork');
  assert.deepEqual(created.books, [{uid: 'u', bookId: 'b'}]);
  assert.deepEqual(created.work.authorIds, ['herbert']);
  assert.equal(created.status, 'active');
});

test('author drafts leave a new id for derivation and require both names', () => {
  const fresh = createAuthorDraft();
  assert.equal(operationTitle(fresh), 'New author');
  assert.throws(() => buildOperation(fresh), /Author ID must be one Firestore document ID/);

  const edit = editAuthorDraft(author());
  assert.equal(operationTitle(edit), 'Edit author');
  assert.deepEqual(buildOperation(edit), {
    type: 'upsertAuthor', authorId: 'le-guin',
    author: {
      canonicalName: 'Ursula K. Le Guin', alternateNames: ['Ursula Le Guin'], sortName: 'Le Guin',
      kind: 'person',
    },
  });
  assert.throws(() => buildOperation(editAuthorDraft(author({sortName: ''}))), /Canonical and sort names are required/);

  assert.throws(() => buildOperation(mergeAuthorsDraft('a')), /Target author ID/);
  assert.deepEqual(buildOperation(mergeAuthorsDraft('a', 'b')), {
    type: 'mergeAuthors', sourceAuthorId: 'a', targetAuthorId: 'b',
  });
});

test('edition drafts round-trip external ids and validate ISBN, title, and pages', () => {
  const draft = editEditionDraft(edition());
  if (draft.type !== 'upsertEdition') throw new Error('expected an upsertEdition draft');
  assert.equal(draft.externalIds, 'open-library=OL1M\ngoogle-books=abc');
  const built = operationOf(buildOperation(draft), 'upsertEdition');
  assert.deepEqual(built.edition.externalIds, {'open-library': 'OL1M', 'google-books': 'abc'});
  assert.equal(built.edition.isbn13, '9780441478125');
  assert.equal(built.edition.suggestedPageCount, 304);
  assert.equal(built.workId, 'work-a');

  // The same ISBN spelled as ISBN-10 links to the same edition.
  draft.isbn = '0441478123';
  assert.equal(operationOf(buildOperation(draft), 'upsertEdition').edition.isbn13, '9780441478125');
  draft.isbn = '123';
  assert.throws(() => buildOperation(draft), /valid checksum/);
  draft.isbn = '';
  draft.pageCount = '0';
  assert.throws(() => buildOperation(draft), /positive whole number/);
  draft.pageCount = '';
  assert.equal(operationOf(buildOperation(draft), 'upsertEdition').edition.suggestedPageCount, null);
  draft.title = ' ';
  assert.throws(() => buildOperation(draft), /Edition title is required/);

  const fresh = createEditionDraft(work());
  if (fresh.type !== 'upsertEdition') throw new Error('expected an upsertEdition draft');
  assert.match(fresh.editionId, /^edition-[0-9a-f-]{36}$/u);
  assert.equal(fresh.workId, 'work-a');
  assert.equal(fresh.title, 'The Left Hand of Darkness');
  assert.equal(fresh.coverUrl, 'https://covers.test/a.jpg');
  assert.throws(() => buildOperation(createEditionDraft(null)), /Edition work ID/);
});

test('link, merge, and repoint drafts build their operations', () => {
  assert.deepEqual(buildOperation(linkBooksDraft([book()], null)), {
    type: 'linkBooks', books: [{uid: 'reader', bookId: 'book-1'}], target: null,
  });
  assert.deepEqual(
    operationOf(buildOperation(linkBooksDraft([book()], {workId: 'work-a', editionId: 'edition-a'})), 'linkBooks').target,
    {workId: 'work-a', editionId: 'edition-a'},
  );
  assert.deepEqual(
    operationOf(buildOperation(linkBooksDraft([book()], {workId: 'work-a', editionId: null})), 'linkBooks').target,
    {workId: 'work-a', editionId: null},
  );
  assert.throws(() => buildOperation(linkBooksDraft([], null)), /Select at least one personal book/);

  const merge = mergeIntoOldestDraft([
    work({workId: 'new', createdAt: 2000}),
    work({workId: 'old', createdAt: 1000}),
    work({workId: 'mid', createdAt: 1500}),
  ]);
  assert.ok(merge !== null);
  assert.deepEqual(buildOperation(merge), {
    type: 'mergeWorks', sourceWorkIds: ['mid', 'new'], targetWorkId: 'old',
  });
  assert.equal(mergeIntoOldestDraft([work()]), null);
  assert.throws(() => buildOperation(mergeWorksDraft([], 'old')), /at least one source work ID/);

  assert.deepEqual(buildOperation(repointIsbnDraft('0441478123', 'edition-b')), {
    type: 'repointIsbn', isbn13: '9780441478125', editionId: 'edition-b',
  });
  assert.throws(() => buildOperation(repointIsbnDraft('bad', 'edition-b')), /valid checksum/);
});

test('booksByWork attributes a book on a merged alias to the survivor', () => {
  const byWork = booksByWork({
    works: [
      work(),
      work({workId: 'alias', status: 'merged', mergedInto: 'work-a'}),
      work({workId: 'broken', status: 'merged', mergedInto: null}),
    ],
    books: [
      book(),
      book({bookId: 'b2', workId: 'alias'}),
      book({bookId: 'b3', workId: 'broken'}),
      book({bookId: 'b4', workId: null}),
    ],
  });
  assert.deepEqual(byWork.get('work-a')?.map((row) => row.bookId), ['book-1', 'b2']);
  assert.equal(byWork.has('alias'), false);
  assert.deepEqual(byWork.get('broken')?.map((row) => row.bookId), ['b3']);
  assert.equal(byWork.size, 2);
});

test('worksByAuthor follows merged author aliases and skips merged works', () => {
  const scan = {
    authors: [author({mergedFrom: ['le-guin-old']})],
    works: [
      work({workId: 'w1', createdAt: 1}),
      work({workId: 'w2', authorIds: ['le-guin-old'], createdAt: 2}),
      work({workId: 'w3', status: 'merged', mergedInto: 'w1', createdAt: 3}),
      work({workId: 'w4', authorIds: ['other'], createdAt: 4}),
    ],
  };
  assert.deepEqual(worksByAuthor(scan, 'le-guin').map((row) => row.workId), ['w2', 'w1']);
  assert.deepEqual(worksByAuthor(scan, 'nobody'), []);
});

test('filterRows needs every token, ignores case, and searches aliases', () => {
  const names = new Map([['le-guin', 'Ursula K. Le Guin'], ['herbert', 'Frank Herbert']]);
  const rows = [
    work({alternateTitles: ['Vinterplaneten']}),
    work({workId: 'w2', canonicalTitle: 'Dune', authorIds: ['herbert'], createdBy: 'reader-uid'}),
  ];
  const text = (row: AdminCatalogWorkRow) => workSearchText(row, names);
  assert.equal(filterRows(rows, '  ', text).length, 2);
  assert.deepEqual(filterRows(rows, 'le guin darkness', text).map((row) => row.workId), ['work-a']);
  assert.deepEqual(filterRows(rows, 'DUNE herbert', text).map((row) => row.workId), ['w2']);
  assert.deepEqual(filterRows(rows, 'vinterplaneten', text).map((row) => row.workId), ['work-a']);
  assert.deepEqual(filterRows(rows, 'reader-uid', text).map((row) => row.workId), ['w2']);
  assert.deepEqual(filterRows(rows, 'dune guin', text), []);

  const authors = [author(), author({authorId: 'penguin', canonicalName: 'Penguin', sortName: 'Penguin', kind: 'entity', alternateNames: []})];
  assert.deepEqual(filterRows(authors, 'ursula le', authorSearchText).map((row) => row.authorId), ['le-guin']);
  assert.deepEqual(filterRows(authors, 'entity', authorSearchText).map((row) => row.authorId), ['penguin']);
});

test('author order, duplicate findings, and creator labels', () => {
  assert.deepEqual(sortAuthors([
    author({authorId: 'b', sortName: 'Zed'}),
    author({authorId: 'c', sortName: 'Adams', canonicalName: 'Zoe Adams'}),
    author({authorId: 'a', sortName: 'Adams', canonicalName: 'Amy Adams'}),
  ]).map((row) => row.authorId), ['a', 'c', 'b']);

  const scan = {
    findings: [
      {code: 'suspected-duplicate-works' as const, severity: 'warning' as const, message: 'dupe', workIds: ['work-a', 'w2'], editionIds: [], books: []},
      {code: 'work-invariant' as const, severity: 'error' as const, message: 'broken', workIds: ['work-a'], editionIds: [], books: []},
    ],
  };
  assert.deepEqual(duplicateFindingsFor(scan, 'work-a').map((finding) => finding.code), ['suspected-duplicate-works']);
  assert.deepEqual(duplicateFindingsFor(scan, 'w9'), []);

  assert.equal(creatorLabel(null), 'migration / admin');
  assert.equal(creatorLabel('abcdefghijk'), 'reader abcdefgh…');
  assert.equal(creatorLabel('abcdefghijk', true), 'reader abcdefghijk');
});
