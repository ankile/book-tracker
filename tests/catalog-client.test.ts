import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp } from 'firebase/firestore';

import type { Book } from '../src/lib/interfaces/book.ts';
import type { CatalogSearchResult, WorkReaderAttemptSummary } from '../src/lib/interfaces/catalog.ts';
import {
  appendDistinctReaderPage,
  automaticIsbnSelectionStillApplies,
  buildCatalogAddEditionRequest,
  buildCatalogCreateRequest,
  buildCatalogSearchRequest,
  catalogWorkHref,
  createLatestRequestGate,
  decodeCatalogAddEditionResponse,
  decodeCatalogSearchResponse,
  decodeEnsureCatalogAuthorsResponse,
  decodeWorkReadersResponse,
  displayTrackingCoverage,
  exactEditionPreselection,
  groupReaderAttempts,
  linkedBooksForWork,
  selectionForResult,
} from '../src/lib/utils/catalogClient.ts';

const work = {
  workId: 'work',
  canonicalTitle: 'The Left Hand of Darkness',
  alternateTitles: [],
  authors: [{authorId: 'le-guin', canonicalName: 'Ursula K. Le Guin', sortName: 'Le Guin', kind: 'person' as const}],
  coverUrl: '',
  subjects: ['Science fiction'],
  fiction: true,
  mergedFrom: ['old-work'],
};
const edition = {
  editionId: 'edition',
  workId: 'work',
  isbn13: '9780441478125',
  title: 'The Left Hand of Darkness',
  publisher: 'Ace',
  publishedDate: '1987',
  language: 'en',
  translatorNames: [],
  format: 'full' as const,
  suggestedPageCount: 304,
  coverUrl: '',
};
const exact: CatalogSearchResult = {
  workId: 'work',
  editionId: 'edition',
  confidence: 'exact-edition',
  reason: 'Exact ISBN edition',
  work,
  edition,
};

test('catalog search requests prefer a valid normalized ISBN and require authors for title-only search', () => {
  assert.deepEqual(buildCatalogSearchRequest({
    isbn: '0-441-47812-3',
    title: 'The Left Hand of Darkness',
    authorNames: ['Ursula K. Le Guin'],
  }), {
    isbn13: '9780441478125',
    title: 'The Left Hand of Darkness',
    authorNames: ['Ursula K. Le Guin'],
  });
  assert.equal(buildCatalogSearchRequest({isbn: '', title: 'Book', authorNames: []}), null);
  assert.deepEqual(buildCatalogSearchRequest({
    isbn: 'invalid', title: 'The Left Hand of Darkness', authorNames: ['Ursula K. Le Guin'],
  }), {title: 'The Left Hand of Darkness', authorNames: ['Ursula K. Le Guin']});
});

test('strict catalog search decoding checks nested ids and rejects extra fields', () => {
  assert.deepEqual(decodeCatalogSearchResponse({results: [exact]}), {results: [exact]});
  assert.throws(
    () => decodeCatalogSearchResponse({results: [{...exact, secret: true}]}),
    /expected only/,
  );
  assert.throws(
    () => decodeCatalogSearchResponse({results: [{...exact, edition: {...edition, workId: 'other'}}]}),
    /summary ids do not agree/,
  );
  assert.throws(
    () => decodeCatalogSearchResponse({results: [{...exact, work: {...exact.work, canonicalTitle: ''}}]}),
    /expected a non-empty string/,
  );
  assert.throws(() => decodeCatalogSearchResponse({results: ['not-a-result']}), /expected an object/);
  assert.throws(() => decodeCatalogSearchResponse({results: [null]}), /expected an object/);
});

test('ensure-authors decoding pairs one id per requested author', () => {
  assert.deepEqual(
    decodeEnsureCatalogAuthorsResponse({authorIds: ['first', 'second']}, 2),
    {authorIds: ['first', 'second']},
  );
  // The caller pairs ids with its new chips positionally, so a short, long
  // or non-string list has to fail here rather than land on the wrong chip.
  assert.throws(() => decodeEnsureCatalogAuthorsResponse({authorIds: ['only']}, 2), /expected 2 ids/);
  assert.throws(
    () => decodeEnsureCatalogAuthorsResponse({authorIds: ['first', 'second', 'extra']}, 2),
    /expected 2 ids/,
  );
  assert.throws(() => decodeEnsureCatalogAuthorsResponse({authorIds: [7]}, 1), /expected a string/);
  assert.throws(
    () => decodeEnsureCatalogAuthorsResponse({authorIds: ['first'], created: 1}, 1),
    /expected only authorIds/,
  );
});

test('catalog selection preselects one exact edition and keeps title matches explicit', () => {
  assert.equal(exactEditionPreselection([exact]), exact);
  assert.equal(exactEditionPreselection([exact, {...exact}]), null);
  assert.deepEqual(selectionForResult(exact), {
    workId: 'work', editionId: 'edition', matchMethod: 'isbn',
  });
  assert.deepEqual(selectionForResult({...exact, editionId: null, confidence: 'strong-work'}), {
    workId: 'work', editionId: null, matchMethod: 'catalog-choice',
  });
  assert.equal(automaticIsbnSelectionStillApplies('9780441478125', {
    isbn13: '9780441478125', title: 'Edited display title',
  }), true);
  assert.equal(automaticIsbnSelectionStillApplies('9780441478125', {
    isbn13: '9780316769488',
  }), false);
  assert.equal(automaticIsbnSelectionStillApplies('9780441478125', {
    title: 'No longer identified by ISBN', authorNames: ['Ursula K. Le Guin'],
  }), false);
});

test('duplicate warnings include books linked through merged aliases', () => {
  const linked = (id: string, workId: string | null) => ({
    id, workId, editionId: null, matchMethod: workId === null ? null : 'migration',
    linkedAt: workId === null ? null : Timestamp.fromMillis(1),
  }) as Book;
  const books = [linked('canonical', 'work'), linked('alias', 'old-work'), linked('other', 'other')];
  assert.deepEqual(linkedBooksForWork(books, work).map((book) => book.id), ['canonical', 'alias']);
  assert.deepEqual(linkedBooksForWork(books, work, 'alias').map((book) => book.id), ['canonical']);
});

test('every linked book opens its work page and an unlinked one has no href', () => {
  assert.equal(catalogWorkHref({workId: 'work/id'}), '/books/work%2Fid');
  assert.equal(catalogWorkHref({workId: 'work'}), '/books/work');
  assert.equal(catalogWorkHref({workId: null}), null);
});

test('tracking coverage is a clamped ratio when formatted', () => {
  assert.equal(displayTrackingCoverage(null), 'Not enough data');
  assert.equal(displayTrackingCoverage(0), '0%');
  assert.equal(displayTrackingCoverage(0.9), '90%');
  assert.equal(displayTrackingCoverage(1), '100%');
  assert.equal(displayTrackingCoverage(1.2), '100%');
});

test('latest request gate suppresses an older response after a new query or reset', () => {
  const gate = createLatestRequestGate();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
  gate.invalidate();
  assert.equal(gate.isCurrent(second), false);
});

test('work-reader response decoder is exact and groups rereads by profile', () => {
  const attempt = (
    username: string,
    status: 'reading' | 'finished',
    firstProgressAt = '2026-01-01',
  ): WorkReaderAttemptSummary => ({
    readerKey: username,
    username: username.startsWith('reader-') ? null : username,
    displayName: username === 'ada' ? 'Ada Lovelace' : username === 'grace' ? 'Grace Hopper' : null,
    status,
    pageCount: 304,
    firstProgressAt,
    firstReadAt: '2026-01-01',
    finishedAt: status === 'finished' ? '2026-01-03' : null,
    calendarDays: status === 'finished' ? 3 : null,
    activeDays: 2,
    trackedMinutes: 180,
    sessionCount: 3,
    qualifiedPagesPerHour: 50,
    percentPerHour: 16.4,
    trackingCoverage: 0.9,
  });
  const decoded = decodeWorkReadersResponse({
    work,
    editions: [edition],
    incomplete: false,
    omittedAttempts: 0,
    nextCursor: null,
    attempts: [
      attempt('grace', 'finished'),
      attempt('reader-1a2b', 'reading'),
      attempt('ada', 'finished', '2026-02-01'),
      attempt('ada', 'reading', '2026-01-01'),
    ],
  });
  assert.equal(decoded.attempts.length, 4);
  assert.equal(decoded.incomplete, false);
  assert.equal(decoded.omittedAttempts, 0);
  assert.equal(decoded.nextCursor, null);
  const groups = groupReaderAttempts(decoded.attempts);
  // Named readers first by name; the anonymous reader last, grouped by key.
  assert.deepEqual(groups.map((group) => [group.readerKey, group.username, group.attempts.length]), [
    ['ada', 'ada', 2], ['grace', 'grace', 1], ['reader-1a2b', null, 1],
  ]);
  assert.deepEqual(groups[0].attempts.map((attempt) => attempt.firstProgressAt), [
    '2026-01-01', '2026-02-01',
  ]);
  assert.deepEqual(
    appendDistinctReaderPage(
      [attempt('ada', 'reading')],
      [attempt('ada', 'finished'), attempt('grace', 'finished')],
    ).map((item) => [item.username, item.status]),
    [['ada', 'reading'], ['grace', 'finished']],
  );
  assert.throws(
    () => decodeWorkReadersResponse({...decoded, attempts: [{...decoded.attempts[0], email: 'private'}]}),
    /expected only/,
  );
  assert.throws(
    () => decodeWorkReadersResponse({
      ...decoded,
      attempts: [{...decoded.attempts[0], firstProgressAt: '2026-01-01T08:00:00.000Z'}],
    }),
    /valid YYYY-MM-DD calendar date/,
  );
});

// A work chosen by title gets the book's own edition added to it: the same
// edition the create path would seed, sent to the work by id, and the
// answer decoded as strictly as a creation.
test('the add-edition request carries the book\'s own edition to a named work', () => {
  const metadata = {
    coverUrl: 'https://covers.test/a.jpg', publisher: 'Ace', publishedDate: '1987',
    subjects: ['Science fiction'], fiction: true,
  };
  const request = buildCatalogAddEditionRequest({
    workId: 'work', title: 'Left Hand of Darkness', isbn: '0-441-47812-3', pageCount: 320, metadata,
  });
  assert.deepEqual(request, {
    workId: 'work',
    edition: {
      isbn13: '9780441478125', title: 'Left Hand of Darkness', publisher: 'Ace', publishedDate: '1987',
      language: '', translatorNames: [], format: 'unknown', suggestedPageCount: 320,
      coverUrl: 'https://covers.test/a.jpg', externalIds: {},
    },
  });
  const created = buildCatalogCreateRequest({
    title: 'Left Hand of Darkness', authorIds: ['le-guin'], isbn: '0-441-47812-3', pageCount: 320, metadata,
  });
  assert.deepEqual(created?.edition, request.edition);
  // An http cover and an invalid ISBN are dropped, not stored.
  const bare = buildCatalogAddEditionRequest({
    workId: 'work', title: 'T', isbn: '123', pageCount: 1, metadata: {...metadata, coverUrl: 'http://x'},
  });
  assert.equal(bare.edition.isbn13, null);
  assert.equal(bare.edition.coverUrl, '');

  assert.deepEqual(
    decodeCatalogAddEditionResponse({workId: 'work', editionId: 'edition-new', created: true}),
    {workId: 'work', editionId: 'edition-new', created: true},
  );
  assert.throws(
    () => decodeCatalogAddEditionResponse({workId: 'work', editionId: 'edition-new', created: true, extra: 1}),
    /catalog-addedition response/,
  );
  assert.throws(() => decodeCatalogAddEditionResponse({workId: 'work', editionId: '', created: true}), /editionId/);
});

// A title match is a work without an edition: both ids are null and the
// result must decode (the check that a summary agrees with its result
// once treated the missing edition as a disagreement, so no title-only
// suggestion ever reached the panel).
test('a work-level search result with no edition decodes; a missing summary for a named edition does not', () => {
  const workLevel = {
    workId: 'work', editionId: null, confidence: 'strong-work', reason: 'Exact title and author match',
    work, edition: null,
  };
  assert.deepEqual(decodeCatalogSearchResponse({results: [workLevel]}).results, [workLevel]);
  assert.throws(
    () => decodeCatalogSearchResponse({results: [{...workLevel, editionId: 'edition'}]}),
    /summary ids do not agree/,
  );
  assert.throws(
    () => decodeCatalogSearchResponse({results: [{...workLevel, edition, editionId: null}]}),
    /summary ids do not agree/,
  );
});
