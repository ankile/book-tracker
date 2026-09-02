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
  consoleHref,
  DEFAULT_CONSOLE_QUERY,
  filterByCreator,
  filterByReview,
  paginate,
  parseConsoleQuery,
  activeOnly,
  authorPickerOptions,
  editionPickerOptions,
  workPickerOptions,
  reviewLabel,
  reviewStatus,
  duplicateFindingsFor,
  editAuthorDraft,
  editEditionDraft,
  editWorkDraft,
  filterRows,
  hideWorkDraft,
  linkBooksDraft,
  mergeAuthorsDraft,
  mergeEditionsDraft,
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
  fiction: true, language: 'en', status: 'active', mergedInto: null, mergedFrom: [], createdBy: null,
  createdAt: 1000, reviewedAt: null, activityAt: 1000, editionCount: 1, linkedBookCount: 0, warnings: [],
  ...overrides,
});
const author = (overrides: Partial<AdminCatalogAuthorRow> = {}): AdminCatalogAuthorRow => ({
  authorId: 'le-guin', canonicalName: 'Ursula K. Le Guin', alternateNames: ['Ursula Le Guin'],
  sortName: 'Le Guin', kind: 'person', status: 'active', mergedInto: null, mergedFrom: [],
  createdBy: null, createdAt: 500, reviewedAt: null, activityAt: 500, workCount: 1, warnings: [], ...overrides,
});
const edition = (overrides: Partial<AdminCatalogEditionRow> = {}): AdminCatalogEditionRow => ({
  editionId: 'edition-a', workId: 'work-a', isbn13: '9780441478125',
  title: 'The Left Hand of Darkness', publisher: 'Ace', publishedDate: '1987', language: 'en',
  translatorNames: [], format: 'full', suggestedPageCount: 304, coverUrl: '',
  externalIds: {'open-library': 'OL1M', 'google-books': 'abc'}, createdBy: null, createdAt: 1000,
  status: 'active', mergedInto: null, mergedFrom: [], ...overrides,
});
const book = (overrides: Partial<AdminCatalogBookRow> = {}): AdminCatalogBookRow => ({
  uid: 'reader', bookId: 'book-1', title: 'Left Hand', authorNames: ['Ursula K. Le Guin'],
  isbn13: null, rawIsbn: null, pageCount: 300, publisher: '', coverUrl: '', language: '', workId: 'work-a',
  editionId: null, linkedAt: null, anomaly: null, ...overrides,
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
      authorIds: ['le-guin'], coverUrl: 'https://covers.test/a.jpg', subjects: [], fiction: null, language: 'en',
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
  assert.throws(() => buildOperation(editWorkDraft(work({language: 'English'}))), /two- or three-letter code/);
  // Typed codes are normalized to lowercase; blank is unknown.
  assert.equal(operationOf(buildOperation(editWorkDraft(work({language: ' NO '}))), 'editWork').work.language, 'no');
  assert.equal(operationOf(buildOperation(editWorkDraft(work({language: ''}))), 'editWork').work.language, '');

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

  const emails = new Map([['abcdefghijk', 'ada@example.test'], ['blank', '']]);
  assert.equal(creatorLabel(null, emails), 'unknown');
  assert.equal(creatorLabel('abcdefghijk', emails), 'ada@example.test');
  assert.equal(creatorLabel('blank', emails), 'blank');
  assert.equal(creatorLabel('stranger', emails), 'stranger');
});

test('the console view round-trips through the URL, drops defaults, and restarts paging when the list changes', () => {
  assert.deepEqual(parseConsoleQuery(new URLSearchParams('')), DEFAULT_CONSOLE_QUERY);
  const query = parseConsoleQuery(new URLSearchParams('tab=authors&q=le+guin&page=3&review=needs&creator=others'));
  assert.deepEqual(query, {tab: 'authors', q: 'le guin', page: 3, review: 'needs', creator: 'others', inactive: false});
  // Anything unrecognised falls back rather than failing.
  assert.deepEqual(parseConsoleQuery(new URLSearchParams('tab=nope&page=0&review=x&creator=y')), DEFAULT_CONSOLE_QUERY);
  assert.deepEqual(parseConsoleQuery(new URLSearchParams('page=2.5')), DEFAULT_CONSOLE_QUERY);
  assert.equal(consoleHref(query), '/admin?tab=authors&q=le+guin&page=3&review=needs&creator=others');
  assert.equal(consoleHref(query, {page: 4}), '/admin?tab=authors&q=le+guin&page=4&review=needs&creator=others');
  // Merged aliases and hidden works are out unless asked; asking is a flag
  // in the URL that, like every other change of list, starts over at page 1.
  assert.equal(parseConsoleQuery(new URLSearchParams('inactive=1')).inactive, true);
  assert.equal(parseConsoleQuery(new URLSearchParams('inactive=true')).inactive, false);
  assert.equal(consoleHref(query, {inactive: true}), '/admin?tab=authors&q=le+guin&review=needs&creator=others&inactive=1');
  assert.equal(consoleHref({...query, inactive: true}, {inactive: false}), '/admin?tab=authors&q=le+guin&review=needs&creator=others');
  const rows = [
    work({workId: 'live'}), work({workId: 'alias', status: 'merged', mergedInto: 'live'}),
    work({workId: 'shelved', status: 'hidden'}),
  ];
  assert.deepEqual(activeOnly(rows, false).map((row) => row.workId), ['live']);
  assert.deepEqual(activeOnly(rows, true).map((row) => row.workId), ['live', 'alias', 'shelved']);
  // A new search, tab or filter starts at page 1; the same value keeps the page.
  assert.equal(consoleHref(query, {q: 'dune'}), '/admin?tab=authors&q=dune&review=needs&creator=others');
  assert.equal(consoleHref(query, {tab: 'works'}), '/admin?q=le+guin&review=needs&creator=others');
  assert.equal(consoleHref(query, {tab: 'authors'}), consoleHref(query));
  assert.equal(consoleHref(DEFAULT_CONSOLE_QUERY, {tab: 'works', review: 'all'}), '/admin');
});

test('review status: never marked, changed since the mark, or done; filters split on it and on the creator', () => {
  const never = {reviewedAt: null, activityAt: 5000, createdBy: 'me'};
  const changed = {reviewedAt: 4000, activityAt: 5000, createdBy: 'someone'};
  const done = {reviewedAt: 5000, activityAt: 5000, createdBy: null};
  assert.equal(reviewStatus(never), 'never');
  assert.equal(reviewStatus(changed), 'changed');
  assert.equal(reviewStatus(done), 'done');
  assert.equal(reviewLabel(never), 'needs review');
  assert.equal(reviewLabel(changed), 'changed since review 1970-01-01');
  assert.equal(reviewLabel(done), 'reviewed 1970-01-01');
  const rows = [never, changed, done];
  assert.deepEqual(filterByReview(rows, 'all'), rows);
  assert.deepEqual(filterByReview(rows, 'needs'), [never, changed]);
  assert.deepEqual(filterByReview(rows, 'done'), [done]);
  assert.deepEqual(filterByCreator(rows, 'all', 'me'), rows);
  assert.deepEqual(filterByCreator(rows, 'me', 'me'), [never]);
  // Without a creator a record counts as someone else's.
  assert.deepEqual(filterByCreator(rows, 'others', 'me'), [changed, done]);
});

test('paginate windows the rows, clamps the page, and reports positions', () => {
  const rows = Array.from({length: 120}, (_, index) => index + 1);
  assert.deepEqual(paginate(rows, 1, 50), {rows: rows.slice(0, 50), page: 1, pages: 3, total: 120, from: 1, to: 50});
  assert.deepEqual(paginate(rows, 3, 50).rows, rows.slice(100));
  assert.deepEqual(paginate(rows, 3, 50).to, 120);
  // Past the end lands on the last page; below the start on the first.
  assert.equal(paginate(rows, 9, 50).page, 3);
  assert.equal(paginate(rows, 0, 50).page, 1);
  assert.deepEqual(paginate([], 4, 50), {rows: [], page: 1, pages: 1, total: 0, from: 0, to: 0});
});

test('an edition merge names the work, its sources and one survivor that is not a source', () => {
  const draft = mergeEditionsDraft('work-a', ['edition-b', 'edition-c']);
  assert.equal(operationTitle(draft), 'Merge editions');
  assert.throws(() => buildOperation(draft), /Surviving edition ID/);
  assert.deepEqual(buildOperation(mergeEditionsDraft('work-a', ['edition-b', 'edition-c'], 'edition-a')), {
    type: 'mergeEditions', workId: 'work-a', sourceEditionIds: ['edition-b', 'edition-c'], targetEditionId: 'edition-a',
  });
  assert.throws(() => buildOperation(mergeEditionsDraft('work-a', ['edition-b', 'edition-c'], 'edition-b')), /cannot also be a source/);
  assert.throws(() => buildOperation(mergeEditionsDraft('work-a', [], 'edition-a')), /at least one source edition ID/);
});

test('picker options say enough to tell records apart and search what an operator knows', () => {
  const names = new Map([['le-guin', 'Ursula K. Le Guin']]);
  const [option] = workPickerOptions([work({linkedBookCount: 4, editionCount: 2, status: 'hidden'})], names);
  assert.equal(option.title, 'The Left Hand of Darkness');
  assert.equal(option.detail, 'Ursula K. Le Guin · work-a');
  assert.equal(option.meta, '4 readers · 2 editions · created 1970-01-01 · hidden');
  assert.ok(option.search.includes('left hand') && option.search.includes('le guin') && option.search.includes('work-a'));
  const [person] = authorPickerOptions([author({workCount: 1})]);
  assert.equal(person.detail, 'Le Guin · person · le-guin');
  assert.equal(person.meta, '1 work · also Ursula Le Guin');
  assert.ok(person.search.includes('ursula le guin'));
  const [row] = editionPickerOptions([edition()], new Map([['work-a', 'The Left Hand of Darkness']]));
  assert.equal(row.detail, '9780441478125 · Ace · 1987 · edition-a');
  assert.equal(row.meta, 'The Left Hand of Darkness · en');
  assert.ok(row.search.includes('9780441478125') && row.search.includes('the left hand of darkness'));
  assert.equal(editionPickerOptions([edition({isbn13: null, publisher: '', language: ''})], new Map())[0].detail, 'no ISBN · 1987 · edition-a');
});
