import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { externalIndexDigestInput } from '../shared/catalogIdentity.ts';
import {
  scanCatalog,
  type CatalogScanBookDocument,
  type CatalogScanDocument,
  type CatalogScanIndexDocument,
  type CatalogScanInput,
} from '../shared/catalogScan.ts';

const at = (ms: number) => ({ toMillis: () => ms });
const now = at(2000);

const authorDocument = (id: string, canonicalName: string, extra: Record<string, unknown> = {}): CatalogScanDocument => ({
  id,
  data: {
    canonicalName, alternateNames: [], nameKeys: [canonicalName.toLowerCase()],
    sortName: canonicalName.split(' ').at(-1), kind: 'person', status: 'active', mergedFrom: [],
    createdAt: now, updatedAt: now, ...extra,
  },
});

const workDocument = (id: string, title: string, extra: Record<string, unknown> = {}): CatalogScanDocument => ({
  id,
  data: {
    canonicalTitle: title, alternateTitles: [], titleKeys: [title.toLowerCase()],
    authorIds: ['ada-author'], coverUrl: '', subjects: [], fiction: true, status: 'active',
    mergedFrom: [], createdAt: now, updatedAt: now, ...extra,
  },
});

const editionDocument = (id: string, workId: string, extra: Record<string, unknown> = {}): CatalogScanDocument => ({
  id,
  data: {
    workId, isbn13: null, title: 'Edition', publisher: '', publishedDate: '', language: '',
    translatorNames: [], format: 'unknown', suggestedPageCount: null, coverUrl: '',
    externalIds: {}, createdAt: now, updatedAt: now, ...extra,
  },
});

const bookDocument = (bookId: string, extra: Record<string, unknown> = {}, uid = 'reader'): CatalogScanBookDocument => ({
  uid,
  bookId,
  data: {
    title: 'Pair Work', pageCount: 100, isbn: '', workId: null, editionId: null,
    matchMethod: null, linkedAt: null, createdAt: now, updatedAt: now, ...extra,
  },
});

const externalIndexDocument = (
  provider: string,
  externalId: string,
  workId: string,
  editionId: string,
  id = createHash('sha256').update(externalIndexDigestInput(provider, externalId)).digest('hex'),
): CatalogScanIndexDocument => ({
  id,
  data: { provider, externalId, workId, editionId },
  expectedId: createHash('sha256').update(externalIndexDigestInput(provider, externalId)).digest('hex'),
});

const input = (overrides: Partial<CatalogScanInput>): CatalogScanInput => ({
  authors: [authorDocument('ada-author', 'Ada Author')],
  works: [],
  editions: [],
  isbnIndex: [],
  externalIdIndex: [],
  books: [],
  liveUserIds: new Set(['reader']),
  ...overrides,
});

const codes = (scan: ReturnType<typeof scanCatalog>, code: string) =>
  scan.findings.filter((finding) => finding.code === code);

// The scan's link suggestions: "exact" means the complete normalized author
// identity agrees (the migration contract), and an ISBN-10 normalizes the
// same way the link/apply path normalizes it.
test('scan suggestions need the complete author set and read ISBN-10 books', () => {
  const scan = scanCatalog(input({
    authors: [
      authorDocument('ada-author', 'Ada Author'),
      authorDocument('grace-author', 'Grace Author', {
        alternateNames: ['G. Author'], nameKeys: ['grace author', 'g author'],
      }),
      authorDocument('extra-author', 'Extra Author'),
    ],
    works: [workDocument('pair-work', 'Pair Work', { authorIds: ['ada-author', 'grace-author'] })],
    editions: [editionDocument('pair-edition', 'pair-work', { isbn13: '9780441478125' })],
    isbnIndex: [{ id: '9780441478125', data: { workId: 'pair-work', editionId: 'pair-edition' } }],
    books: [
      bookDocument('partial', { authorIds: ['ada-author'] }),
      bookDocument('complete', { authorIds: ['ada-author', 'grace-author'] }),
      bookDocument('superset', { authorIds: ['ada-author', 'grace-author', 'extra-author'] }),
      bookDocument('isbn-ten', { title: 'Some Other Title', isbn: '0-441-47812-3' }),
    ],
  }));
  const exact = codes(scan, 'unmatched-title-author-candidate');
  assert.deepEqual(exact.map(({ books, workIds }) => [books[0].bookId, workIds]), [['complete', ['pair-work']]]);
  const isbnTen = scan.books.find(({ bookId }) => bookId === 'isbn-ten');
  assert.deepEqual({ isbn13: isbnTen?.isbn13, rawIsbn: isbnTen?.rawIsbn }, { isbn13: '9780441478125', rawIsbn: null });
  assert.deepEqual(
    codes(scan, 'unmatched-isbn-candidate').map(({ books, editionIds }) => [books[0].bookId, editionIds]),
    [['isbn-ten', ['pair-edition']]],
  );
  // The partial and superset books fall through to similarity: same title,
  // one agreeing author, so they are offered as likely, never as exact.
  assert.deepEqual(
    codes(scan, 'likely-title-author-candidate').map(({ books, workIds }) => [books[0].bookId, workIds]),
    [['partial', ['pair-work']], ['superset', ['pair-work']]],
  );
  assert.equal(scan.works[0].linkedBookCount, 0);
});

test('a similar title with an agreeing author is a likely candidate, ranked and capped at five', () => {
  const works = Array.from({ length: 7 }, (_, index) =>
    workDocument(`work-${index}`, `The Long Road Home ${index}`));
  const scan = scanCatalog(input({
    works,
    books: [bookDocument('similar', { title: 'Long Road Home', authorIds: ['ada-author'] })],
  }));
  const likely = codes(scan, 'likely-title-author-candidate');
  assert.equal(likely.length, 1);
  assert.equal(likely[0].workIds.length, 5);
  assert.deepEqual(likely[0].books, [{ uid: 'reader', bookId: 'similar' }]);
});

// One malformed personal book is reported and dropped, not coerced into a
// plausible row: the console curates identity, and a placeholder title would
// hide the corruption behind something that looked like data.
test('a malformed book row is reported and skipped', () => {
  const scan = scanCatalog(input({
    books: [
      bookDocument('readable', { title: 'Readable' }),
      bookDocument('untitled', { title: 42 }),
      bookDocument('unlinkable', { title: 'Bad link', matchMethod: 'guessed' }),
      bookDocument('bad-publisher', { title: 'Typed wrong', publisher: 7 }),
    ],
  }));
  assert.deepEqual(scan.books.map(({ bookId }) => bookId), ['readable']);
  const anomalies = codes(scan, 'book-row-anomaly');
  assert.deepEqual(anomalies.map(({ books }) => books[0].bookId).sort(), [
    'bad-publisher', 'unlinkable', 'untitled',
  ]);
  assert.equal(anomalies.some(({ message }) => /title must be a non-empty string/.test(message)), true);
  assert.equal(anomalies.some(({ message }) => /Invalid catalog link/.test(message)), true);
  assert.equal(anomalies.some(({ message }) => /publisher must be a string/.test(message)), true);
});

// A missing or nonsensical page count is a display gap, not a reason to
// drop the row.
test('a book with no page count is still scanned', () => {
  const scan = scanCatalog(input({
    books: [{ uid: 'reader', bookId: 'no-pages', data: {
      title: 'No page count', workId: null, editionId: null, matchMethod: null, linkedAt: null,
    } }],
  }));
  assert.deepEqual(scan.books.map(({ bookId, pageCount }) => [bookId, pageCount]), [['no-pages', null]]);
});

test('link anomalies name the broken side and count links against the surviving work', () => {
  const scan = scanCatalog(input({
    works: [
      workDocument('survivor', 'Survivor'),
      workDocument('absorbed', 'Absorbed', { status: 'merged', mergedInto: 'survivor' }),
      workDocument('dangling', 'Dangling', { status: 'merged' }),
      workDocument('other', 'Other'),
    ],
    editions: [
      editionDocument('survivor-edition', 'survivor'),
      editionDocument('other-edition', 'other'),
    ],
    liveUserIds: new Set(['reader']),
    books: [
      bookDocument('direct', { workId: 'survivor', editionId: 'survivor-edition' }),
      bookDocument('one-hop', { workId: 'absorbed', editionId: null }),
      bookDocument('broken-work', { workId: 'dangling' }),
      bookDocument('missing-work', { workId: 'vanished' }),
      bookDocument('missing-edition', { workId: 'survivor', editionId: 'vanished-edition' }),
      bookDocument('foreign-edition', { workId: 'survivor', editionId: 'other-edition' }),
      bookDocument('orphan', { workId: 'survivor' }, 'ghost'),
      bookDocument('seven-authors', {
        authorIds: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'],
      }),
      bookDocument('unknown-author', { authorIds: ['nobody'] }),
    ],
  }));
  const anomalyOf = Object.fromEntries(scan.books.map(({ bookId, anomaly }) => [bookId, anomaly]));
  assert.deepEqual(anomalyOf, {
    'direct': null,
    'one-hop': null,
    'broken-work': 'missing or broken work',
    'missing-work': 'missing or broken work',
    'missing-edition': 'missing edition',
    'foreign-edition': 'edition belongs to another work',
    'orphan': 'orphaned data',
    'seven-authors': 'missing or malformed author',
    'unknown-author': 'missing or malformed author',
  });
  assert.equal(codes(scan, 'book-link-anomaly').length, 7);
  // direct, one-hop, missing-edition, foreign-edition and the orphan all
  // point at the survivor; the two dangling links count against their own id.
  assert.deepEqual(
    scan.works.map(({ workId, linkedBookCount }) => [workId, linkedBookCount]),
    [['survivor', 5], ['absorbed', 0], ['dangling', 1], ['other', 0]],
  );
  // Anomalous books never get link candidates.
  assert.deepEqual(codes(scan, 'unmatched-title-author-candidate'), []);
});

test('catalog integrity findings: duplicates, indexes, redirects, name keys, unsupported fields', () => {
  const scan = scanCatalog(input({
    authors: [
      authorDocument('ada-author', 'Ada Author'),
      authorDocument('ada-twin', 'Ada Author'),
      authorDocument('stale-keys', 'Stale Keys', { nameKeys: ['old key'] }),
      authorDocument('merged-away', 'Merged Away', { status: 'merged', mergedInto: 'nobody' }),
      authorDocument('extra-field', 'Extra Field', { legacyName: 'x' }),
    ],
    works: [
      workDocument('one', 'Same Book'),
      workDocument('two', 'Same Book', { authorIds: ['ada-author'], titleKeys: ['same book', 'alias'] }),
      workDocument('three', 'Other Book', { authorIds: ['merged-away', 'missing-author'] }),
      workDocument('redirect', 'Redirect', { status: 'merged' }),
      workDocument('legacy', 'Legacy', { oldField: true }),
    ],
    editions: [
      editionDocument('ed-one', 'one', { isbn13: '9780140328721', externalIds: { 'open-library': 'OL1M' } }),
      editionDocument('ed-orphan', 'no-such-work'),
      editionDocument('ed-legacy', 'one', { legacyField: 1 }),
    ],
    isbnIndex: [
      { id: '9780140328721', data: { workId: 'one', editionId: 'ed-one' } },
      { id: '9780441478125', data: { workId: 'one', editionId: 'ed-one' } },
      { id: '9780316769488', data: { workId: 'two', editionId: 'ed-one' } },
    ],
    externalIdIndex: [
      externalIndexDocument('open-library', 'OL1M', 'one', 'ed-one'),
      externalIndexDocument('open-library', 'OL1M', 'one', 'ed-one', 'wrong-id'),
      externalIndexDocument('open-library', 'OL2M', 'one', 'ed-one'),
    ],
  }));
  assert.deepEqual(codes(scan, 'suspected-duplicate-works').map(({ workIds }) => workIds), [['one', 'two']]);
  assert.deepEqual(codes(scan, 'duplicate-author-name').map(({ message }) => message), [
    'Active catalog authors share normalized name ada author.',
  ]);
  assert.deepEqual(codes(scan, 'isbn-index-mismatch').map(({ editionIds, workIds }) => [workIds, editionIds]), [
    [['one'], ['ed-one']], [['two'], ['ed-one']],
  ]);
  assert.equal(codes(scan, 'external-id-index-mismatch').length, 2);
  assert.deepEqual(codes(scan, 'edition-missing-work').map(({ editionIds }) => editionIds), [['ed-orphan']]);
  assert.deepEqual(codes(scan, 'edition-invariant').map(({ editionIds, message }) => [editionIds, message]), [
    [['ed-legacy'], 'unsupported field legacyField'],
  ]);
  const workWarnings = Object.fromEntries(scan.works.map(({ workId, warnings }) => [workId, warnings]));
  assert.deepEqual(workWarnings.three, ['broken author reference merged-away', 'broken author reference missing-author']);
  assert.deepEqual(workWarnings.redirect, ['broken redirect']);
  assert.deepEqual(workWarnings.legacy, ['unsupported field oldField']);
  assert.equal(codes(scan, 'work-invariant').length, 4); // three ×2, redirect, legacy
  const authorWarnings = Object.fromEntries(scan.authors.map(({ authorId, warnings }) => [authorId, warnings]));
  assert.deepEqual(authorWarnings['ada-author'], ['duplicate name ada author']);
  assert.deepEqual(authorWarnings['stale-keys'], ['name index mismatch']);
  assert.deepEqual(authorWarnings['merged-away'], ['broken redirect']);
  assert.deepEqual(authorWarnings['extra-field'], ['unsupported field legacyName']);
  assert.deepEqual(
    scan.works.map(({ workId, editionCount }) => [workId, editionCount]),
    [['one', 2], ['two', 0], ['three', 0], ['redirect', 0], ['legacy', 0]],
  );
  // one, two, redirect and legacy all name ada-author; three's references are broken.
  assert.equal(scan.authors.find(({ authorId }) => authorId === 'ada-author')?.workCount, 4);
});

// A malformed catalog document is a red finding and is left out, never a
// blank page: the server is its only writer, so this is a bug report.
test('a malformed catalog document is reported and skipped without hiding the rest', () => {
  const scan = scanCatalog(input({
    authors: [
      authorDocument('ada-author', 'Ada Author'),
      { id: 'bad-author', data: { canonicalName: 3 } },
    ],
    works: [
      workDocument('good', 'Good'),
      workDocument('bad-status', 'Bad', { status: 'invented' }),
      workDocument('no-created', 'No created', { createdAt: 'yesterday' }),
    ],
    editions: [
      editionDocument('fine', 'good'),
      { id: 'bad-edition', data: { workId: 'good', title: 'x' } },
    ],
  }));
  assert.deepEqual(scan.works.map(({ workId }) => workId), ['good']);
  assert.deepEqual(scan.authors.map(({ authorId }) => authorId), ['ada-author']);
  assert.deepEqual(scan.editions.map(({ editionId }) => editionId), ['fine']);
  const anomalies = codes(scan, 'catalog-row-anomaly');
  assert.deepEqual(anomalies.map(({ workIds, editionIds, message }) => [workIds, editionIds, message]), [
    [[], [], 'Invalid catalog author catalogAuthors/bad-author.'],
    [['bad-status'], [], 'Invalid work status at works/bad-status.'],
    [['no-created'], [], 'works/no-created.createdAt must be a timestamp.'],
    [[], ['bad-edition'], 'Invalid catalog edition editions/bad-edition.'],
  ]);
  assert.equal(anomalies.every(({ severity }) => severity === 'error'), true);
});

test('work rows carry creator, status and merged aliases; merged author ids resolve one hop', () => {
  const scan = scanCatalog(input({
    authors: [
      authorDocument('ada-author', 'Ada Author'),
      authorDocument('ada-alias', 'A. Author', { status: 'merged', mergedInto: 'ada-author' }),
    ],
    works: [
      workDocument('reader-made', 'Reader Made', {
        createdBy: 'reader', status: 'hidden', mergedFrom: ['older'], authorIds: ['ada-alias'],
      }),
    ],
    books: [bookDocument('aliased', { title: 'Reader Made', authorIds: ['ada-alias'] })],
  }));
  assert.deepEqual(scan.works.map(({ workId, createdBy, status, mergedFrom, warnings, createdAt }) =>
    [workId, createdBy, status, mergedFrom, warnings, createdAt]), [
    ['reader-made', 'reader', 'hidden', ['older'], ['stale author alias ada-alias'], 2000],
  ]);
  assert.deepEqual(scan.books[0].authorNames, ['Ada Author']);
  assert.equal(scan.authors.find(({ authorId }) => authorId === 'ada-author')?.workCount, 1);
  // A hidden work is not an exact-title candidate.
  assert.deepEqual(codes(scan, 'unmatched-title-author-candidate'), []);
});

// Authors and editions record the account whose add-book flow minted them
// (works already did); a linked book without an edition is drift the work
// page repairs, reported as a warning rather than a broken link.
test('authors and editions carry their creator; a linked book without an edition is a warning', () => {
  const scan = scanCatalog(input({
    authors: [
      authorDocument('ada-author', 'Ada Author', { createdBy: 'reader' }),
      authorDocument('bad-creator', 'Bad Creator', { createdBy: 7 }),
    ],
    works: [workDocument('pair', 'Pair Work')],
    editions: [editionDocument('pair-edition', 'pair', { createdBy: 'reader' })],
    books: [
      bookDocument('on-edition', {
        workId: 'pair', editionId: 'pair-edition', matchMethod: 'catalog-choice', linkedAt: now,
      }),
      bookDocument('no-edition', { workId: 'pair', matchMethod: 'migration', linkedAt: now }),
      bookDocument('unlinked'),
    ],
  }));
  assert.equal(scan.authors.find(({ authorId }) => authorId === 'ada-author')?.createdBy, 'reader');
  assert.equal(scan.editions[0].createdBy, 'reader');
  assert.deepEqual(
    scan.findings.filter(({ code }) => code === 'linked-without-edition')
      .map(({ books, workIds, severity }) => [books, workIds, severity]),
    [[[{ uid: 'reader', bookId: 'no-edition' }], ['pair'], 'warning']],
  );
  assert.equal(scan.books.find(({ bookId }) => bookId === 'no-edition')?.anomaly, null);
  assert.deepEqual(
    scan.findings.filter(({ code }) => code === 'catalog-row-anomaly').map(({ message }) => message),
    ['Invalid creator catalogAuthors/bad-creator.'],
  );
});

test('review marks and activity: a reviewed record moves when something lands on it after the mark', () => {
  const scan = scanCatalog(input({
    authors: [
      authorDocument('ada-author', 'Ada Author', { reviewedAt: at(2500) }),
      authorDocument('alias-author', 'A. Author', { status: 'merged', mergedInto: 'ada-author', createdAt: at(2100) }),
      authorDocument('bad-review', 'Bad Review', { reviewedAt: 'yesterday' }),
    ],
    works: [
      workDocument('quiet', 'Quiet Work', { reviewedAt: at(3000) }),
      workDocument('busy', 'Busy Work', { reviewedAt: at(3000), createdAt: at(2400) }),
      workDocument('old-busy', 'Old Busy', { status: 'merged', mergedInto: 'busy', authorIds: ['alias-author'], createdAt: at(4100) }),
      workDocument('fresh', 'Fresh Work'),
    ],
    editions: [
      editionDocument('busy-late', 'busy', { createdAt: at(3500) }),
      editionDocument('quiet-early', 'quiet', { createdAt: at(1500) }),
    ],
    books: [
      bookDocument('linked-late', { workId: 'old-busy', matchMethod: 'migration', linkedAt: at(4000) }),
      bookDocument('linked-early', { workId: 'quiet', editionId: 'quiet-early', matchMethod: 'isbn', linkedAt: at(1000) }),
    ],
  }));
  const works = new Map(scan.works.map(({ workId, reviewedAt, activityAt }) => [workId, [reviewedAt, activityAt]]));
  // Nothing landed on quiet after its review; busy gained an edition at
  // 3500 and, through its merged alias, a book link at 4000. The alias's
  // own creation is not survivor activity: only the operator merges, and
  // merging is a review.
  assert.deepEqual(works.get('quiet'), [3000, 2000]);
  assert.deepEqual(works.get('busy'), [3000, 4000]);
  assert.deepEqual(works.get('old-busy'), [null, 4100]);
  assert.deepEqual(works.get('fresh'), [null, 2000]);
  const authors = new Map(scan.authors.map(({ authorId, reviewedAt, activityAt }) => [authorId, [reviewedAt, activityAt]]));
  // The alias's work at 4100 names the survivor through the alias.
  assert.deepEqual(authors.get('ada-author'), [2500, 4100]);
  assert.deepEqual(authors.get('alias-author'), [null, 4100]);
  assert.equal(scan.editions.find(({ editionId }) => editionId === 'busy-late')?.createdAt, 3500);
  assert.deepEqual(
    scan.books.map(({ bookId, linkedAt }) => [bookId, linkedAt]).sort(),
    [['linked-early', 1000], ['linked-late', 4000]],
  );
  assert.deepEqual(
    scan.findings.filter(({ code }) => code === 'catalog-row-anomaly').map(({ message }) => message),
    ['catalogAuthors/bad-review.reviewedAt must be a timestamp.'],
  );
});
