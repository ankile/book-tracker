import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { planCatalogCreatedAt } from '../catalog-creation-dates-backfill.ts';
import type { CreatorBook } from '../catalog-creator-backfill.ts';

type Doc = Record<string, unknown>;

const BUILD = 1_000_000;
const at = (millis: number): Timestamp => Timestamp.fromMillis(millis);
const record = (createdBy: string, createdAt = BUILD, overrides: Doc = {}): Doc =>
  ({createdBy, createdAt: at(createdAt), status: 'active', mergedFrom: [], authorIds: [], ...overrides});
const book = (uid: string, bookId: string, createdAt: number, link: Doc): CreatorBook =>
  ({uid, bookId, data: {createdAt: at(createdAt), ...link}});

test('a record dated after its creator\'s first book takes that book\'s creation time', () => {
  const plan = planCatalogCreatedAt({
    works: new Map([
      ['sult', record('lars', BUILD, {authorIds: ['hamsun']})],
      // Made by the add-book flow a moment before its book: stays.
      ['fresh', record('lars', 2_000, {authorIds: ['hamsun']})],
      // Its creator has no book on it (a console creation): stays.
      ['console', record('admin', BUILD, {authorIds: ['hamsun']})],
      // No creator at all: not this planner's business.
      ['unattributed', {createdAt: at(BUILD), status: 'active', mergedFrom: [], authorIds: []}],
      // An alias merged into sult: its own creator's book dates it too.
      ['old-sult', record('magnus', BUILD, {status: 'merged', mergedInto: 'sult', authorIds: ['hamsun']})],
    ]),
    editions: new Map([
      ['sult-gyldendal', record('lars', BUILD, {workId: 'sult'})],
      ['sult-bare', record('magnus', BUILD, {workId: 'sult'})],
    ]),
    authors: new Map([
      ['hamsun', record('magnus', BUILD)],
    ]),
    books: [
      // The creator's earliest book decides, not another reader's older one.
      book('lars', 'second', 500, {workId: 'sult', editionId: 'sult-gyldendal'}),
      book('lars', 'first', 300, {workId: 'sult', editionId: 'sult-gyldendal'}),
      book('magnus', 'oldest', 100, {workId: 'old-sult', editionId: 'sult-bare'}),
      book('lars', 'fresh', 2_005, {workId: 'fresh', editionId: null}),
      book('lars', 'on-console', 50, {workId: 'console', editionId: null}),
    ],
  });
  assert.deepEqual(plan.records, [
    {collection: 'works', id: 'old-sult', createdAt: 100, was: BUILD, bookPath: 'users/magnus/books/oldest'},
    {collection: 'works', id: 'sult', createdAt: 300, was: BUILD, bookPath: 'users/lars/books/first'},
    {collection: 'editions', id: 'sult-bare', createdAt: 100, was: BUILD, bookPath: 'users/magnus/books/oldest'},
    {collection: 'editions', id: 'sult-gyldendal', createdAt: 300, was: BUILD, bookPath: 'users/lars/books/first'},
    // The author's creator is magnus; his book reaches the author through the alias work.
    {collection: 'catalogAuthors', id: 'hamsun', createdAt: 100, was: BUILD, bookPath: 'users/magnus/books/oldest'},
  ]);
});

test('a second run plans nothing', () => {
  const plan = planCatalogCreatedAt({
    works: new Map([['sult', record('lars', 300, {authorIds: ['hamsun']})]]),
    editions: new Map([['sult-gyldendal', record('lars', 300, {workId: 'sult'})]]),
    authors: new Map([['hamsun', record('lars', 300)]]),
    books: [book('lars', 'first', 300, {workId: 'sult', editionId: 'sult-gyldendal'})],
  });
  assert.deepEqual(plan, {records: []});
});

test('a record without a creation timestamp or with a non-string creator is a crash, not a guess', () => {
  assert.throws(() => planCatalogCreatedAt({
    works: new Map([['sult', {createdBy: 'lars', createdAt: 5, status: 'active', mergedFrom: [], authorIds: []}]]),
    editions: new Map(), authors: new Map(), books: [],
  }), /works\/sult has no createdAt timestamp/);
  assert.throws(() => planCatalogCreatedAt({
    works: new Map([['sult', {createdBy: 7, createdAt: at(1), status: 'active', mergedFrom: [], authorIds: []}]]),
    editions: new Map(), authors: new Map(), books: [],
  }), /works\/sult has a non-string createdBy/);
  assert.throws(() => planCatalogCreatedAt({
    works: new Map([['sult', record('lars')]]),
    editions: new Map(), authors: new Map(),
    books: [{uid: 'lars', bookId: 'undated', data: {workId: 'sult', editionId: null}}],
  }), /users\/lars\/books\/undated has no createdAt timestamp/);
});
