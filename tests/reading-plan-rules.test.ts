// Rules for the to-read plan (docs/to-read-plan.md): private queue rows
// and the daily-minutes scenario are the owner's alone, shaped and capped,
// and a planned row becomes a book row only in the batch that creates the
// book. Runs under the Firestore emulator (npm run test:rules).
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import type { RulesTestContext, RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  setDoc,
  Timestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';

let environment: RulesTestEnvironment;

const verified = (uid: string) =>
  environment.authenticatedContext(uid, { email_verified: true }).firestore();
const seedAccount = (uid: string) =>
  environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid), { uid, email: `${uid}@example.test` });
  });

const plannedEntry = (overrides: Record<string, unknown> = {}) => ({
  kind: 'planned',
  rank: 1000,
  manualMinutesPerPage: null,
  title: 'A book I mean to read',
  authors: [],
  pageCount: null,
  isbn: '',
  coverUrl: '',
  publisher: '',
  publishedDate: '',
  subjects: [],
  fiction: null,
  language: '',
  workId: null,
  editionId: null,
  matchMethod: null,
  createdAt: Timestamp.now(),
  updatedAt: Timestamp.now(),
  ...overrides,
});

const bookEntry = (overrides: Record<string, unknown> = {}) => ({
  kind: 'book',
  rank: 1000,
  manualMinutesPerPage: null,
  createdAt: Timestamp.now(),
  updatedAt: Timestamp.now(),
  ...overrides,
});

// The book Start reading creates, the shape Database.startPlannedEntry writes.
const startedBook = (db: ReturnType<RulesTestContext['firestore']>, uid: string, overrides: Record<string, unknown> = {}) => ({
  authorIds: [],
  currentPage: 0,
  currentPageUpdateId: null,
  finished: false,
  finishedAt: null,
  lastReadAt: null,
  owner: doc(db, 'users', uid),
  pageCount: 320,
  pagesRead: 0,
  timeRead: 0,
  title: 'A book I mean to read',
  isbn: '',
  workId: null,
  editionId: null,
  matchMethod: null,
  linkedAt: null,
  coverUrl: '',
  publisher: '',
  publishedDate: '',
  subjects: [],
  fiction: null,
  language: '',
  activeTimer: null,
  updatedAt: Timestamp.now(),
  createdAt: Timestamp.now(),
  ...overrides,
});

const entryRef = (db: ReturnType<RulesTestContext['firestore']>, uid: string, id: string) =>
  doc(db, 'users', uid, 'readingPlanEntries', id);
const bookRef = (db: ReturnType<RulesTestContext['firestore']>, uid: string, id: string) =>
  doc(db, 'users', uid, 'books', id);
const settingsRef = (db: ReturnType<RulesTestContext['firestore']>, uid: string, id = 'default') =>
  doc(db, 'users', uid, 'readingPlans', id);

before(async () => {
  // Own project id: the rules files run concurrently against one emulator,
  // and clearFirestore below must not wipe another file's seeded accounts.
  environment = await initializeTestEnvironment({
    projectId: 'book-tracker-plan-rules-test',
    firestore: { rules: await readFile('firestore.rules', 'utf8') },
  });
});

after(async () => environment.cleanup());

beforeEach(async () => {
  await environment.clearFirestore();
});

test('only the owner reads and writes plan entries', async () => {
  await seedAccount('owner');
  await seedAccount('stranger');
  const db = verified('owner');
  await assertSucceeds(setDoc(entryRef(db, 'owner', 'wish'), plannedEntry()));
  await assertSucceeds(getDoc(entryRef(db, 'owner', 'wish')));
  const listed = await assertSucceeds(getDocs(collection(db, 'users', 'owner', 'readingPlanEntries')));
  assert.equal(listed.size, 1);
  const stranger = verified('stranger');
  await assertFails(getDoc(entryRef(stranger, 'owner', 'wish')));
  await assertFails(getDocs(collection(stranger, 'users', 'owner', 'readingPlanEntries')));
  await assertFails(setDoc(entryRef(stranger, 'owner', 'other'), plannedEntry()));
  await assertFails(updateDoc(entryRef(stranger, 'owner', 'wish'), { rank: 5 }));
  await assertFails(deleteDoc(entryRef(stranger, 'owner', 'wish')));
  const anonymous = environment.unauthenticatedContext().firestore();
  await assertFails(getDoc(entryRef(anonymous, 'owner', 'wish')));
  await assertSucceeds(deleteDoc(entryRef(db, 'owner', 'wish')));
});

test('plan rows share the books posture: no email verification or tombstone gate', async () => {
  await seedAccount('unverified');
  const db = environment.authenticatedContext('unverified').firestore();
  await assertSucceeds(setDoc(entryRef(db, 'unverified', 'wish'), plannedEntry()));
  await seedAccount('tombstoned');
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await updateDoc(doc(context.firestore(), 'users', 'tombstoned'), { deletedAt: Timestamp.now() });
  });
  const tombstoned = verified('tombstoned');
  await assertSucceeds(setDoc(entryRef(tombstoned, 'tombstoned', 'wish'), plannedEntry()));
  await assertSucceeds(getDoc(entryRef(tombstoned, 'tombstoned', 'wish')));
});

test('a planned row is shaped and capped', async () => {
  await seedAccount('owner');
  const db = verified('owner');
  const admitted: Record<string, unknown>[] = [
    plannedEntry({ pageCount: 320 }),
    plannedEntry({ authors: [{ id: null, name: 'Typed Name' }, { id: 'author-id', name: 'Known Author' }] }),
    plannedEntry({ workId: 'work', editionId: null, matchMethod: 'catalog-choice' }),
    plannedEntry({ workId: 'work', editionId: 'edition', matchMethod: 'isbn', isbn: '9780306406157' }),
    plannedEntry({ manualMinutesPerPage: 2.5, rank: -3.25 }),
    plannedEntry({ fiction: true, subjects: ['one', 'two'], language: 'en', coverUrl: 'https://covers.example/a.jpg' }),
  ];
  for (const [index, entry] of admitted.entries()) {
    await assertSucceeds(setDoc(entryRef(db, 'owner', `ok-${index}`), entry));
  }
  const refused: [string, Record<string, unknown>][] = [
    ['unknown kind', plannedEntry({ kind: 'wish' })],
    ['empty title', plannedEntry({ title: '' })],
    ['overlong title', plannedEntry({ title: 'x'.repeat(501) })],
    ['missing title', (({ title: _title, ...rest }) => rest)(plannedEntry())],
    ['string rank', plannedEntry({ rank: '1000' })],
    ['zero manual pace', plannedEntry({ manualMinutesPerPage: 0 })],
    ['negative manual pace', plannedEntry({ manualMinutesPerPage: -1 })],
    ['huge manual pace', plannedEntry({ manualMinutesPerPage: 1001 })],
    ['string manual pace', plannedEntry({ manualMinutesPerPage: '2' })],
    ['zero page count', plannedEntry({ pageCount: 0 })],
    ['fractional page count', plannedEntry({ pageCount: 1.5 })],
    ['string page count', plannedEntry({ pageCount: '320' })],
    ['seven authors', plannedEntry({ authors: Array.from({ length: 7 }, (_, i) => ({ id: null, name: `Author ${i}` })) })],
    ['author without a name', plannedEntry({ authors: [{ id: null, name: '' }] })],
    ['author with an extra key', plannedEntry({ authors: [{ id: null, name: 'A', kind: 'person' }] })],
    ['author id with a slash', plannedEntry({ authors: [{ id: 'a/b', name: 'A' }] })],
    ['extra top-level key', plannedEntry({ finishedAt: null })],
    ['work without a match method', plannedEntry({ workId: 'work', matchMethod: null })],
    ['migration match method', plannedEntry({ workId: 'work', matchMethod: 'migration' })],
    ['edition without a work', plannedEntry({ editionId: 'edition' })],
    ['too many subjects', plannedEntry({ subjects: Array.from({ length: 26 }, (_, i) => `s${i}`) })],
    ['string fiction', plannedEntry({ fiction: 'yes' })],
    ['overlong isbn', plannedEntry({ isbn: '9'.repeat(33) })],
    ['missing createdAt', (({ createdAt: _createdAt, ...rest }) => rest)(plannedEntry())],
    ['planned row with book-only keys', bookEntry({ kind: 'planned' })],
  ];
  for (const [label, entry] of refused) {
    await assert.rejects(
      assertSucceeds(setDoc(entryRef(db, 'owner', label.replaceAll(' ', '-')), entry)),
      () => true,
      `${label} was admitted`,
    );
  }
});

test('a book row needs the personal book it positions, created before or in the same batch', async () => {
  await seedAccount('owner');
  const db = verified('owner');
  await assertFails(setDoc(entryRef(db, 'owner', 'missing-book'), bookEntry()));
  await assertSucceeds(setDoc(bookRef(db, 'owner', 'existing'), startedBook(db, 'owner')));
  await assertSucceeds(setDoc(entryRef(db, 'owner', 'existing'), bookEntry()));
  const batch = writeBatch(db);
  batch.set(bookRef(db, 'owner', 'together'), startedBook(db, 'owner'));
  batch.set(entryRef(db, 'owner', 'together'), bookEntry());
  await assertSucceeds(batch.commit());
  await assertFails(setDoc(entryRef(db, 'owner', 'existing-extra'), bookEntry({ title: 'not allowed here' })));
});

test('updates keep createdAt and kind, and a rank-only patch is enough', async () => {
  await seedAccount('owner');
  const db = verified('owner');
  await setDoc(entryRef(db, 'owner', 'wish'), plannedEntry());
  await assertSucceeds(updateDoc(entryRef(db, 'owner', 'wish'), { rank: 1500, updatedAt: Timestamp.now() }));
  await assertSucceeds(updateDoc(entryRef(db, 'owner', 'wish'), { manualMinutesPerPage: 3, updatedAt: Timestamp.now() }));
  await assertSucceeds(updateDoc(entryRef(db, 'owner', 'wish'), { pageCount: 200, title: 'Renamed', updatedAt: Timestamp.now() }));
  await assertFails(updateDoc(entryRef(db, 'owner', 'wish'), { createdAt: Timestamp.now() }));
  await assertFails(updateDoc(entryRef(db, 'owner', 'wish'), { manualMinutesPerPage: 0 }));
  await assertFails(updateDoc(entryRef(db, 'owner', 'wish'), { title: deleteField() }));
  await setDoc(bookRef(db, 'owner', 'started'), startedBook(db, 'owner'));
  await setDoc(entryRef(db, 'owner', 'started'), bookEntry());
  await assertSucceeds(updateDoc(entryRef(db, 'owner', 'started'), { rank: 7, updatedAt: Timestamp.now() }));
  await assertFails(updateDoc(entryRef(db, 'owner', 'started'), { kind: 'planned' }));
  await assertFails(updateDoc(entryRef(db, 'owner', 'started'), { title: 'Books rows carry no title' }));
});

test('Start reading converts a planned row only in the batch that creates its book', async () => {
  await seedAccount('owner');
  const db = verified('owner');
  const conversion = {
    kind: 'book',
    updatedAt: Timestamp.now(),
    ...Object.fromEntries([
      'title', 'authors', 'pageCount', 'isbn', 'coverUrl', 'publisher', 'publishedDate',
      'subjects', 'fiction', 'language', 'workId', 'editionId', 'matchMethod',
    ].map((field) => [field, deleteField()])),
  };
  await setDoc(entryRef(db, 'owner', 'wish'), plannedEntry({ rank: 2500 }));
  // Without the book: refused.
  await assertFails(updateDoc(entryRef(db, 'owner', 'wish'), conversion));
  // Leaving a planned field behind: refused.
  const partial = writeBatch(db);
  partial.set(bookRef(db, 'owner', 'wish'), startedBook(db, 'owner'));
  partial.update(entryRef(db, 'owner', 'wish'), { ...conversion, title: 'kept' });
  await assertFails(partial.commit());
  // Book and conversion together: admitted, and the row keeps its rank.
  const batch = writeBatch(db);
  batch.set(bookRef(db, 'owner', 'wish'), startedBook(db, 'owner'));
  batch.update(entryRef(db, 'owner', 'wish'), conversion);
  await assertSucceeds(batch.commit());
  const converted = (await getDoc(entryRef(db, 'owner', 'wish'))).data();
  assert.deepEqual(Object.keys(converted ?? {}).sort(), ['createdAt', 'kind', 'manualMinutesPerPage', 'rank', 'updatedAt']);
  assert.equal(converted?.rank, 2500);
  // A replay against the existing book: refused, so no second book and no
  // progress reset.
  await setDoc(entryRef(db, 'owner', 'again'), plannedEntry());
  await setDoc(bookRef(db, 'owner', 'again'), startedBook(db, 'owner'));
  const replay = writeBatch(db);
  replay.set(bookRef(db, 'owner', 'again'), startedBook(db, 'owner'));
  replay.update(entryRef(db, 'owner', 'again'), conversion);
  await assertFails(replay.commit());
  await assertFails(updateDoc(entryRef(db, 'owner', 'again'), conversion));
  // The real replay: a second tab resubmits after the conversion landed and
  // the book was edited. The row is already a book row, so the stale set
  // over the book is what must fail, leaving the edit in place.
  await assertSucceeds(updateDoc(bookRef(db, 'owner', 'wish'), { title: 'Edited since', pageCount: 500, updatedAt: Timestamp.now() }));
  const stale = writeBatch(db);
  stale.set(bookRef(db, 'owner', 'wish'), startedBook(db, 'owner', { createdAt: Timestamp.fromMillis(Date.now() + 1000) }));
  stale.update(entryRef(db, 'owner', 'wish'), conversion);
  await assertFails(stale.commit());
  assert.equal((await getDoc(bookRef(db, 'owner', 'wish'))).data()?.title, 'Edited since');
});

test('only an intention can be removed: a row that became a book keeps its rank and estimate', async () => {
  await seedAccount('owner');
  const db = verified('owner');
  await setDoc(entryRef(db, 'owner', 'wish'), plannedEntry());
  await setDoc(entryRef(db, 'owner', 'started'), plannedEntry({ manualMinutesPerPage: 2 }));
  const batch = writeBatch(db);
  batch.set(bookRef(db, 'owner', 'started'), startedBook(db, 'owner'));
  batch.update(entryRef(db, 'owner', 'started'), {
    kind: 'book',
    updatedAt: Timestamp.now(),
    ...Object.fromEntries([
      'title', 'authors', 'pageCount', 'isbn', 'coverUrl', 'publisher', 'publishedDate',
      'subjects', 'fiction', 'language', 'workId', 'editionId', 'matchMethod',
    ].map((field) => [field, deleteField()])),
  });
  await assertSucceeds(batch.commit());
  // A Remove confirmed in a tab that still saw the intention: refused.
  await assertFails(deleteDoc(entryRef(db, 'owner', 'started')));
  assert.equal((await getDoc(entryRef(db, 'owner', 'started'))).data()?.manualMinutesPerPage, 2);
  await assertSucceeds(deleteDoc(entryRef(db, 'owner', 'wish')));
  // Once the book itself is gone the leftover row may go too.
  await assertSucceeds(deleteDoc(bookRef(db, 'owner', 'started')));
  await assertSucceeds(deleteDoc(entryRef(db, 'owner', 'started')));
});

test('one batch may position 20 books and no more, which the client splits on', async () => {
  await seedAccount('owner');
  const db = verified('owner');
  for (let index = 0; index < 21; index += 1) await setDoc(bookRef(db, 'owner', `b${index}`), startedBook(db, 'owner'));
  const position = (count: number) => {
    const batch = writeBatch(db);
    for (let index = 0; index < count; index += 1) batch.set(entryRef(db, 'owner', `b${index}`), bookEntry({ rank: (index + 1) * 1000 }));
    return batch.commit();
  };
  await assertFails(position(21));
  await assertSucceeds(position(20));
});

test('the daily-minutes scenario is one owner-only document with a bounded override', async () => {
  await seedAccount('owner');
  await seedAccount('stranger');
  const db = verified('owner');
  await assertSucceeds(setDoc(settingsRef(db, 'owner'), { dailyMinutesOverride: 45, updatedAt: Timestamp.now() }));
  await assertSucceeds(setDoc(settingsRef(db, 'owner'), { dailyMinutesOverride: null, updatedAt: Timestamp.now() }));
  await assertSucceeds(updateDoc(settingsRef(db, 'owner'), { dailyMinutesOverride: 0.5, updatedAt: Timestamp.now() }));
  await assertSucceeds(getDoc(settingsRef(db, 'owner')));
  await assertFails(setDoc(settingsRef(db, 'owner', 'other'), { dailyMinutesOverride: 45, updatedAt: Timestamp.now() }));
  await assertFails(setDoc(settingsRef(db, 'owner'), { dailyMinutesOverride: 0, updatedAt: Timestamp.now() }));
  await assertFails(setDoc(settingsRef(db, 'owner'), { dailyMinutesOverride: 1441, updatedAt: Timestamp.now() }));
  await assertFails(setDoc(settingsRef(db, 'owner'), { dailyMinutesOverride: '45', updatedAt: Timestamp.now() }));
  await assertFails(setDoc(settingsRef(db, 'owner'), { dailyMinutesOverride: 45 }));
  await assertFails(setDoc(settingsRef(db, 'owner'), { dailyMinutesOverride: 45, updatedAt: Timestamp.now(), note: 'x' }));
  const stranger = verified('stranger');
  await assertFails(getDoc(settingsRef(stranger, 'owner')));
  await assertFails(setDoc(settingsRef(stranger, 'owner'), { dailyMinutesOverride: 45, updatedAt: Timestamp.now() }));
  await assertSucceeds(deleteDoc(settingsRef(db, 'owner')));
});
