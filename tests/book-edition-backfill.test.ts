import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  backfillEditionId,
  editionFromBook,
  planBookEditions,
  type BackfillBook,
  type BackfillInput,
} from '../book-edition-backfill.ts';

const book = (uid: string, bookId: string, data: Record<string, unknown>): BackfillBook => ({
  uid,
  bookId,
  data: {
    title: 'A Wild Sheep Chase', isbn: '', publisher: '', publishedDate: '', pageCount: 300,
    coverUrl: '', workId: 'sheep', editionId: null, ...data,
  },
});

const input = (overrides: Partial<BackfillInput> = {}): BackfillInput => ({
  works: new Map([['sheep', { status: 'active' }], ['old', { status: 'merged', mergedInto: 'sheep' }]]),
  editions: new Map(),
  isbnIndex: new Map(),
  books: [],
  liveUserIds: new Set(['ann', 'bob']),
  ...overrides,
});

// The admin link path derives the same id for the same book and work
// (functions/src/adminCatalog.ts mintedEditionFor), so a relink after the
// backfill lands on the backfilled document.
test('backfill edition ids are the admin link formula', () => {
  const expected = `edition_${createHash('sha256').update('edition\0sheep\0ann/b1').digest('hex').slice(0, 24)}`;
  assert.equal(backfillEditionId('sheep', book('ann', 'b1', {})), expected);
});

test('an edition is minted from the book alone, with the owner as creator', () => {
  assert.deepEqual(editionFromBook('sheep', book('ann', 'b1', {
    isbn: '0-441-47812-3', publisher: 'Ace', publishedDate: '1987', pageCount: 304,
    coverUrl: 'https://covers.test/a.jpg',
  })), {
    workId: 'sheep', isbn13: '9780441478125', title: 'A Wild Sheep Chase', publisher: 'Ace',
    publishedDate: '1987', language: '', translatorNames: [], format: 'unknown',
    suggestedPageCount: 304, coverUrl: 'https://covers.test/a.jpg', externalIds: {}, createdBy: 'ann',
  });
  // Junk does not leak: an invalid ISBN, a non-https cover and a zero page
  // count become null and blank rather than stored.
  const junk = editionFromBook('sheep', book('ann', 'b1', {isbn: '11412', coverUrl: 'http://x', pageCount: 0}));
  assert.equal(junk.isbn13, null);
  assert.equal(junk.coverUrl, '');
  assert.equal(junk.suggestedPageCount, null);
});

test('one edition per reader per book identity; rereads share, readers and editions do not', () => {
  const plan = planBookEditions(input({
    books: [
      book('ann', 'b2', {}),
      book('ann', 'b1', {}),
      book('bob', 'b3', {}),
      book('ann', 'b4', {title: 'Vilda fårjakten', publisher: 'Norstedts'}),
      book('ann', 'b5', {editionId: 'already'}),
      book('ann', 'b6', {workId: null}),
    ],
  }));
  assert.deepEqual(plan.review, []);
  assert.deepEqual(plan.editions.map(({editionId, uid, create, indexIsbn, bookPaths}) => [editionId, uid, create, indexIsbn, bookPaths]), [
    [backfillEditionId('sheep', book('ann', 'b1', {})), 'ann', true, false, ['users/ann/books/b1', 'users/ann/books/b2']],
    [backfillEditionId('sheep', book('ann', 'b4', {})), 'ann', true, false, ['users/ann/books/b4']],
    [backfillEditionId('sheep', book('bob', 'b3', {})), 'bob', true, false, ['users/bob/books/b3']],
  ]);
  assert.equal(plan.editions[1].data.title, 'Vilda fårjakten');
  assert.equal(plan.editions[2].data.createdBy, 'bob');
});

test('an ISBN already indexed to the work is joined, elsewhere it is reviewed, otherwise it is indexed', () => {
  const isbn = '9780441478125';
  const joined = planBookEditions(input({
    isbnIndex: new Map([[isbn, {workId: 'sheep', editionId: 'seeded'}]]),
    books: [book('ann', 'b1', {isbn})],
  }));
  assert.deepEqual(joined.editions.map(({editionId, create, indexIsbn}) => [editionId, create, indexIsbn]), [['seeded', false, false]]);

  const elsewhere = planBookEditions(input({
    isbnIndex: new Map([[isbn, {workId: 'other', editionId: 'seeded'}]]),
    books: [book('ann', 'b1', {isbn})],
  }));
  assert.deepEqual(elsewhere.editions, []);
  assert.deepEqual(elsewhere.review, [{path: 'users/ann/books/b1', reason: `ISBN ${isbn} is indexed to another work`}]);

  const fresh = planBookEditions(input({books: [book('ann', 'b1', {isbn})]}));
  assert.deepEqual(fresh.editions.map(({create, indexIsbn, data}) => [create, indexIsbn, data.isbn13]), [[true, true, isbn]]);
});

test('a rerun joins the edition it minted and writes nothing new', () => {
  const first = planBookEditions(input({books: [book('ann', 'b1', {})]}));
  const minted = first.editions[0];
  const rerun = planBookEditions(input({
    editions: new Map([[minted.editionId, {...minted.data}]]),
    books: [book('ann', 'b1', {})],
  }));
  assert.deepEqual(rerun.editions.map(({editionId, create}) => [editionId, create]), [[minted.editionId, false]]);
  // Once the book carries the edition there is nothing left to plan.
  const done = planBookEditions(input({
    editions: new Map([[minted.editionId, {...minted.data}]]),
    books: [book('ann', 'b1', {editionId: minted.editionId})],
  }));
  assert.deepEqual(done, {editions: [], review: []});
  // The same id under another work is a conflict, never silently joined.
  const conflict = planBookEditions(input({
    editions: new Map([[minted.editionId, {...minted.data, workId: 'other'}]]),
    books: [book('ann', 'b1', {})],
  }));
  assert.deepEqual(conflict.editions, []);
  assert.equal(conflict.review[0].reason, `edition ${minted.editionId} exists under another work`);
});

test('merged works, missing works, tombstoned owners and untitled books are reviewed, not guessed', () => {
  const plan = planBookEditions(input({
    books: [
      book('ann', 'b1', {workId: 'old'}),
      book('ann', 'b2', {workId: 'nowhere'}),
      book('zed', 'b3', {}),
      book('bob', 'b4', {title: '  '}),
    ],
  }));
  assert.deepEqual(plan.editions, []);
  assert.deepEqual(plan.review.map(({path, reason}) => [path, reason]), [
    ['users/ann/books/b1', 'work old is merged; relink through the console'],
    ['users/ann/books/b2', 'work nowhere missing'],
    ['users/bob/books/b4', 'book has no title'],
    ['users/zed/books/b3', 'owner account missing or tombstoned'],
  ]);
});
