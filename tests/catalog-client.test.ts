import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp } from 'firebase/firestore';

import type { Book } from '../src/lib/interfaces/book.ts';
import type { CatalogSearchResult, WorkReaderAttemptSummary } from '../src/lib/interfaces/catalog.ts';
import {
  appendDistinctReaderPage,
  automaticIsbnSelectionStillApplies,
  buildCatalogSearchRequest,
  catalogWorkHref,
  createLatestRequestGate,
  decodeCatalogSearchResponse,
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

test('only owner-selected or migrated links open a work page', () => {
  assert.equal(catalogWorkHref({workId: 'work/id', matchMethod: 'catalog-choice'}), '/books/work%2Fid');
  assert.equal(catalogWorkHref({workId: 'work', matchMethod: 'isbn'}), '/books/work');
  assert.equal(catalogWorkHref({workId: 'work', matchMethod: 'migration'}), '/books/work');
  assert.equal(catalogWorkHref({workId: 'admin-work', matchMethod: 'admin'}), null);
  assert.equal(catalogWorkHref({workId: null, matchMethod: null}), null);
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
    username,
    displayName: username === 'ada' ? 'Ada Lovelace' : 'Grace Hopper',
    status,
    pageCount: 304,
    editionIsbn13: null,
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
      attempt('ada', 'finished', '2026-02-01'),
      attempt('ada', 'reading', '2026-01-01'),
    ],
  });
  assert.equal(decoded.attempts.length, 3);
  assert.equal(decoded.incomplete, false);
  assert.equal(decoded.omittedAttempts, 0);
  assert.equal(decoded.nextCursor, null);
  const groups = groupReaderAttempts(decoded.attempts);
  assert.deepEqual(groups.map((group) => [group.username, group.attempts.length]), [
    ['ada', 2], ['grace', 1],
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
