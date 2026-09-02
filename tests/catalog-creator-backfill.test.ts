import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';

import { planCatalogCreators, type CreatorBook, type CreatorInput } from '../catalog-creator-backfill.ts';

const book = (uid: string, bookId: string, at: number, data: Record<string, unknown>): CreatorBook => ({
  uid, bookId, data: { createdAt: Timestamp.fromMillis(at), workId: null, editionId: null, ...data },
});

const input = (overrides: Partial<CreatorInput> = {}): CreatorInput => ({
  works: new Map([['sheep', { status: 'active', authorIds: ['murakami'] }]]),
  editions: new Map([['sheep-ace', { workId: 'sheep' }]]),
  authors: new Map([['murakami', { status: 'active' }]]),
  books: [],
  ...overrides,
});

const stamps = (plan: ReturnType<typeof planCatalogCreators>) =>
  plan.creators.map(({ collection, id, uid, bookPath, readers }) => [collection, id, uid, bookPath, readers]);

test('the earliest book standing on a record names its creator; ties fall to the first path', () => {
  const plan = planCatalogCreators(input({
    books: [
      book('bob', 'later', 2000, { workId: 'sheep', editionId: 'sheep-ace' }),
      book('ann', 'first', 1000, { workId: 'sheep' }),
      book('ann', 'tie-b', 1000, { workId: 'sheep', editionId: 'sheep-ace' }),
      book('amy', 'tie-a', 1000, { editionId: 'sheep-ace' }),
      book('zed', 'unlinked', 1, {}),
    ],
  }));
  assert.deepEqual(plan.review, []);
  assert.deepEqual(stamps(plan), [
    ['works', 'sheep', 'ann', 'users/ann/books/first', 2],
    ['editions', 'sheep-ace', 'amy', 'users/amy/books/tie-a', 3],
    ['catalogAuthors', 'murakami', 'ann', 'users/ann/books/first', 2],
  ]);
});

test('a record that carries a creator is left alone, so a rerun plans nothing', () => {
  const carrying = input({
    works: new Map([['sheep', { status: 'active', authorIds: ['murakami'], createdBy: 'ann' }]]),
    editions: new Map([['sheep-ace', { workId: 'sheep', createdBy: 'ann' }]]),
    authors: new Map([['murakami', { status: 'active', createdBy: 'ann' }]]),
    books: [book('bob', 'b', 1, { workId: 'sheep', editionId: 'sheep-ace' })],
  });
  assert.deepEqual(planCatalogCreators(carrying), { creators: [], review: [] });
  assert.throws(() => planCatalogCreators(input({
    works: new Map([['sheep', { status: 'active', authorIds: [], createdBy: 7 }]]),
  })), /works\/sheep has a non-string createdBy/u);
});

test('books on a merged alias count for the survivor; a merged author gets the works naming its survivor', () => {
  const plan = planCatalogCreators(input({
    works: new Map([
      ['sheep', { status: 'active', authorIds: ['haruki'], mergedFrom: ['old-sheep'] }],
      ['old-sheep', { status: 'merged', mergedInto: 'sheep', authorIds: ['murakami'] }],
    ]),
    editions: new Map(),
    authors: new Map([
      ['haruki', { status: 'active' }],
      ['murakami', { status: 'merged', mergedInto: 'haruki' }],
    ]),
    books: [
      book('bob', 'on-survivor', 2000, { workId: 'sheep' }),
      book('ann', 'on-alias', 1000, { workId: 'old-sheep' }),
    ],
  }));
  assert.deepEqual(plan.review, []);
  assert.deepEqual(stamps(plan), [
    ['works', 'old-sheep', 'ann', 'users/ann/books/on-alias', 1],
    ['works', 'sheep', 'ann', 'users/ann/books/on-alias', 2],
    ['catalogAuthors', 'haruki', 'ann', 'users/ann/books/on-alias', 2],
    ['catalogAuthors', 'murakami', 'ann', 'users/ann/books/on-alias', 1],
  ]);
});

test('a record no personal book stands on is reviewed, never guessed', () => {
  const plan = planCatalogCreators(input({
    works: new Map([
      ['sheep', { status: 'active', authorIds: ['murakami'] }],
      ['lonely', { status: 'hidden', authorIds: ['nobody'] }],
    ]),
    authors: new Map([['murakami', { status: 'active' }], ['nobody', { status: 'active' }]]),
    books: [book('ann', 'b', 1, { workId: 'sheep' })],
  }));
  assert.deepEqual(stamps(plan), [
    ['works', 'sheep', 'ann', 'users/ann/books/b', 1],
    ['catalogAuthors', 'murakami', 'ann', 'users/ann/books/b', 1],
  ]);
  assert.deepEqual(plan.review, [
    { collection: 'works', id: 'lonely', reason: 'no personal book stands on it' },
    { collection: 'editions', id: 'sheep-ace', reason: 'no personal book stands on it' },
    { collection: 'catalogAuthors', id: 'nobody', reason: 'no personal book stands on it' },
  ]);
});

test('a book without a createdAt timestamp is a crash, not a silent last place', () => {
  assert.throws(() => planCatalogCreators(input({
    books: [{ uid: 'ann', bookId: 'b', data: { workId: 'sheep', createdAt: 'yesterday' } }],
  })), /users\/ann\/books\/b has no createdAt timestamp/u);
});
