import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import type { RulesTestContext, RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  arrayUnion,
  collection,
  deleteField,
  deleteDoc,
  disableNetwork,
  doc,
  enableNetwork,
  getDoc,
  getDocFromCache,
  getDocs,
  increment,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import { togglQueueId } from '../src/lib/utils/toggl.ts';
import {
  queueReadingSessionDelete,
  queueReadingSessionUpdate,
} from '../src/lib/firebase/readingSessionWrites.ts';

let environment: RulesTestEnvironment;

const profile = (uid: string, overrides: Record<string, unknown> = {}) => ({
  uid,
  public: true,
  givenName: 'Ada',
  familyName: 'Lovelace',
  links: [{ type: 'github', value: 'ada' }],
  stats: {
    totalBooks: 12,
    finishedBooks: 10,
    readingBooks: 2,
    totalTimeReadHours: 80,
    totalPagesRead: 3200,
    booksPerYear: 8.5,
    avgTimePerBook: 480,
    authors: 9,
  },
  records: {
    momentum: { recentPagesPerDay: 14, lifetimePagesPerDay: 10, ratio: 1.4 },
    superlatives: {
      biggestDay: { day: '2026-08-20', pages: 120 },
      longestSession: { minutes: 95 },
      medianSessionMinutes: 24,
      fastestFinish: { days: 3, pageCount: 320 },
    },
  },
  years: [{ year: 2026, count: 10, hours: 80, pages: 3200 }],
  days: [{ day: '2026-08-20', pagesRead: 120, timeRead: 95, sessions: 1 }],
  updatedAt: serverTimestamp(),
  ...overrides,
});

const readingBook = (overrides: Record<string, unknown> = {}) => ({
  title: 'Reading book',
  activeTimer: null,
  currentPage: 20,
  currentPageUpdateId: 'session',
  pageCount: 100,
  finished: false,
  pagesRead: 20,
  timeRead: 60,
  updatedAt: Timestamp.now(),
  ...overrides,
});

const legacyReadingBook = (overrides: Record<string, unknown> = {}) => {
  const { currentPageUpdateId: _source, ...book } = readingBook(overrides);
  return book;
};

const readingEntry = (
  db: ReturnType<RulesTestContext['firestore']>,
  uid: string,
  bookId: string,
  overrides: Record<string, unknown> = {},
) => ({
  owner: doc(db, 'users', uid),
  book: doc(db, 'users', uid, 'books', bookId),
  type: 'reading',
  timeRead: 30,
  fromPage: 10,
  toPage: 20,
  pagesRead: 10,
  updatedAt: Timestamp.now(),
  createdAt: Timestamp.now(),
  ...overrides,
});

const pageCorrectionEntry = (
  db: ReturnType<RulesTestContext['firestore']>,
  uid: string,
  bookId: string,
  overrides: Record<string, unknown> = {},
) => {
  const { timeRead: _timeRead, ...entry } = readingEntry(db, uid, bookId);
  return { ...entry, type: 'update', ...overrides };
};

before(async () => {
  environment = await initializeTestEnvironment({
    projectId: 'book-tracker-rules-test',
    firestore: { rules: await readFile('firestore.rules', 'utf8') },
  });
});

after(async () => environment.cleanup());

test('the owner can create and update a valid profile', async () => {
  const db = environment.authenticatedContext('owner').firestore();
  const ref = doc(db, 'profiles', 'ada-lovelace');
  await assertSucceeds(setDoc(ref, profile('owner')));
  await assertSucceeds(setDoc(ref, profile('owner', { familyName: 'Byron' })));
});

test('profile links support targeted, deduplicated arrayUnion writes up to the cap', async () => {
  const db = environment.authenticatedContext('profile-link-owner').firestore();
  const ref = doc(db, 'profiles', 'targeted-links');
  const link = { type: 'homepage', value: 'https://example.com' };
  await assertSucceeds(setDoc(ref, profile('profile-link-owner')));
  await assertSucceeds(updateDoc(ref, { links: arrayUnion(link), updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(ref, { links: arrayUnion(link), updatedAt: serverTimestamp() }));
  const saved = await getDoc(ref);
  assert.deepEqual(saved.data()?.links, [
    { type: 'github', value: 'ada' },
    link,
  ]);

  const fullRef = doc(db, 'profiles', 'targeted-links-full');
  const tenLinks = Array.from(
    { length: 10 },
    (_, index) => ({ type: 'other', value: `example.com/${index}` }),
  );
  await assertSucceeds(setDoc(fullRef, profile('profile-link-owner', { links: tenLinks })));
  await assertFails(updateDoc(fullRef, {
    links: arrayUnion({ type: 'other', value: 'example.com/overflow' }),
    updatedAt: serverTimestamp(),
  }));
});

test('public profiles are readable but private profiles are not', async () => {
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'profiles', 'public-reader'), profile('owner'));
    await setDoc(doc(context.firestore(), 'profiles', 'private-reader'), profile('owner', { public: false }));
  });
  const anonymous = environment.unauthenticatedContext().firestore();
  await assertSucceeds(getDoc(doc(anonymous, 'profiles', 'public-reader')));
  await assertFails(getDoc(doc(anonymous, 'profiles', 'private-reader')));
});

test('only the owner can write or list their profiles', async () => {
  const stranger = environment.authenticatedContext('stranger').firestore();
  await assertFails(setDoc(doc(stranger, 'profiles', 'stolen-profile'), profile('owner')));
  await assertFails(getDocs(collection(stranger, 'profiles')));

  const owner = environment.authenticatedContext('owner').firestore();
  const ownProfiles = query(collection(owner, 'profiles'), where('uid', '==', 'owner'));
  await assertSucceeds(getDocs(ownProfiles));
});

test('profile records cannot contain titles or arbitrary fields', async () => {
  const db = environment.authenticatedContext('owner').firestore();
  const withTitle = profile('owner');
  (withTitle.records.superlatives.longestSession as Record<string, unknown>).title = 'Private book';
  await assertFails(setDoc(doc(db, 'profiles', 'leaky-record'), withTitle));

  const extraStat = profile('owner');
  (extraStat.stats as Record<string, unknown>).favoriteBook = 1;
  await assertFails(setDoc(doc(db, 'profiles', 'extra-stat'), extraStat));
});

test('profile field limits reject oversized and malformed data', async () => {
  const db = environment.authenticatedContext('owner').firestore();
  const tooManyLinks = profile('owner', {
    links: Array.from({ length: 11 }, (_, index) => ({ type: 'other', value: `example.com/${index}` })),
  });
  await assertFails(setDoc(doc(db, 'profiles', 'too-many-links'), tooManyLinks));
  await assertFails(setDoc(doc(db, 'profiles', 'Bad Slug'), profile('owner')));
});

test('reading and page-correction creates move the correlated book atomically', async () => {
  const uid = 'reading-create';
  const bookId = 'book';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', bookId);
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(
      doc(context.firestore(), 'users', uid, 'books', bookId),
      readingBook({ currentPage: 10, currentPageUpdateId: null, pagesRead: 10, timeRead: 30 }),
    );
  });

  const readingRef = doc(db, 'users', uid, 'books', bookId, 'updates', 'reading');
  const reading = writeBatch(db);
  reading.set(readingRef, readingEntry(db, uid, bookId));
  reading.update(bookRef, {
    currentPage: 20,
    currentPageUpdateId: readingRef.id,
    finished: false,
    pagesRead: increment(10),
    timeRead: increment(30),
    updatedAt: Timestamp.now(),
  });
  await assertSucceeds(reading.commit());

  const correctionRef = doc(db, 'users', uid, 'books', bookId, 'updates', 'correction');
  const correction = writeBatch(db);
  correction.set(correctionRef, pageCorrectionEntry(db, uid, bookId, {
    fromPage: 20,
    toPage: 15,
    pagesRead: -5,
  }));
  correction.update(bookRef, {
    currentPage: 15,
    currentPageUpdateId: correctionRef.id,
    finished: false,
    updatedAt: Timestamp.now(),
  });
  await assertSucceeds(correction.commit());

  const saved = (await getDoc(bookRef)).data();
  assert.equal(saved?.currentPage, 15);
  assert.equal(saved?.currentPageUpdateId, 'correction');
  assert.equal(saved?.pagesRead, 20);
  assert.equal(saved?.timeRead, 60);

  const staleRef = doc(db, 'users', uid, 'books', bookId, 'updates', 'stale-reading');
  const stale = writeBatch(db);
  stale.set(staleRef, readingEntry(db, uid, bookId, { fromPage: 10, toPage: 25, pagesRead: 15 }));
  stale.update(bookRef, {
    currentPage: 25,
    currentPageUpdateId: staleRef.id,
    finished: false,
    pagesRead: increment(15),
    timeRead: increment(30),
    updatedAt: Timestamp.now(),
  });
  await assertFails(stale.commit());
});

test('session mutations pin the row and correlated aggregate invariants', async () => {
  const uid = 'reading-invariants';
  const bookId = 'book';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', bookId);
  const sessionRef = doc(db, 'users', uid, 'books', bookId, 'updates', 'session');
  const correctionRef = doc(db, 'users', uid, 'books', bookId, 'updates', 'correction');
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    await setDoc(doc(seed, 'users', uid, 'books', bookId), readingBook());
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'session'),
      readingEntry(seed, uid, bookId),
    );
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'correction'),
      pageCorrectionEntry(seed, uid, bookId, {
        fromPage: 5,
        toPage: 10,
        pagesRead: 5,
      }),
    );
  });

  const invalidUpdate = async (
    sessionPatch: Record<string, unknown>,
    bookPatch: Record<string, unknown> = {},
  ) => {
    const batch = writeBatch(db);
    batch.update(sessionRef, {
      timeRead: 45,
      toPage: 25,
      pagesRead: 15,
      updatedAt: Timestamp.now(),
      ...sessionPatch,
    });
    batch.update(bookRef, {
      currentPage: 25,
      finished: false,
      pagesRead: increment(5),
      timeRead: increment(15),
      updatedAt: Timestamp.now(),
      ...bookPatch,
    });
    await assertFails(batch.commit());
  };

  await invalidUpdate({ owner: doc(db, 'users', 'someone-else') });
  await invalidUpdate({ book: doc(db, 'users', uid, 'books', 'other') });
  await invalidUpdate({ type: 'update' });
  await invalidUpdate({ createdAt: Timestamp.now() });
  await invalidUpdate({ fromPage: 11, pagesRead: 14 });
  await invalidUpdate({ note: 'extra field' });
  await invalidUpdate({ timeRead: 0 }, { timeRead: increment(-30) });
  await invalidUpdate({ toPage: 10, pagesRead: 0 }, { currentPage: 10, pagesRead: increment(-10) });
  await invalidUpdate({}, { title: 'Unrelated rewrite' });
  await invalidUpdate({}, { updatedAt: 'not a timestamp' });
  await invalidUpdate({}, { finished: true });
  await assertFails(updateDoc(bookRef, {
    currentPage: 10,
    currentPageUpdateId: 'correction',
    finished: false,
    updatedAt: Timestamp.now(),
  }));

  const correctionDelete = writeBatch(db);
  correctionDelete.delete(correctionRef);
  correctionDelete.update(bookRef, { currentPage: 10, finished: false, updatedAt: Timestamp.now() });
  await assertFails(correctionDelete.commit());

  const correctionUpdate = writeBatch(db);
  correctionUpdate.update(correctionRef, { toPage: 25, pagesRead: 15, updatedAt: Timestamp.now() });
  correctionUpdate.update(bookRef, { currentPage: 25, finished: false, updatedAt: Timestamp.now() });
  await assertFails(correctionUpdate.commit());

  const wrongDelete = writeBatch(db);
  wrongDelete.delete(sessionRef);
  wrongDelete.update(bookRef, {
    currentPage: 10,
    finished: false,
    pagesRead: increment(-9),
    timeRead: increment(-30),
    updatedAt: Timestamp.now(),
  });
  await assertFails(wrongDelete.commit());
});

test('stale and missing session batches fail without double-applying aggregates', async () => {
  const uid = 'reading-stale';
  const bookId = 'book';
  const db = environment.authenticatedContext(uid).firestore();
  const writerDb = db as unknown as Firestore;
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    await setDoc(doc(seed, 'users', uid, 'books', bookId), readingBook());
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'session'),
      readingEntry(seed, uid, bookId),
    );
    await setDoc(
      doc(seed, 'users', uid, 'books', 'missing-book', 'updates', 'orphan'),
      readingEntry(seed, uid, 'missing-book'),
    );
  });
  const previous = { fromPage: 10, toPage: 20, pagesRead: 10, timeRead: 30 };
  await assertSucceeds(queueReadingSessionUpdate({
    firestore: writerDb,
    userId: uid,
    bookId,
    sessionId: 'session',
    previous,
    book: { currentPage: 20, currentPageUpdateId: 'session', pageCount: 100 },
    next: { fromPage: 10, toPage: 25, timeRead: 45 },
  }));
  await assertFails(queueReadingSessionUpdate({
    firestore: writerDb,
    userId: uid,
    bookId,
    sessionId: 'session',
    previous,
    book: { currentPage: 20, currentPageUpdateId: 'session', pageCount: 100 },
    next: { fromPage: 10, toPage: 30, timeRead: 60 },
  }));
  await assertFails(queueReadingSessionUpdate({
    firestore: writerDb,
    userId: uid,
    bookId,
    sessionId: 'missing-session',
    previous,
    book: { currentPage: 25, currentPageUpdateId: 'session', pageCount: 100 },
    next: { fromPage: 10, toPage: 30, timeRead: 60 },
  }));
  await assertFails(queueReadingSessionUpdate({
    firestore: writerDb,
    userId: uid,
    bookId: 'missing-book',
    sessionId: 'orphan',
    previous,
    book: { currentPage: 20, currentPageUpdateId: 'orphan', pageCount: 100 },
    next: { fromPage: 10, toPage: 25, timeRead: 45 },
  }));

  const savedBook = (await getDoc(doc(db, 'users', uid, 'books', bookId))).data();
  assert.equal(savedBook?.pagesRead, 25);
  assert.equal(savedBook?.timeRead, 75);
  assert.equal(savedBook?.currentPage, 25);
});

test('session deletion cannot drive aggregate totals negative', async () => {
  const uid = 'reading-nonnegative';
  const bookId = 'book';
  const db = environment.authenticatedContext(uid).firestore();
  const writerDb = db as unknown as Firestore;
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId),
      readingBook({ pagesRead: 5, timeRead: 20 }),
    );
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'session'),
      readingEntry(seed, uid, bookId),
    );
  });
  await assertFails(queueReadingSessionDelete({
    firestore: writerDb,
    userId: uid,
    bookId,
    sessionId: 'session',
    previous: { fromPage: 10, toPage: 20, pagesRead: 10, timeRead: 30 },
    book: { currentPage: 20, currentPageUpdateId: 'session', pageCount: 100 },
  }));
});

test('session update and delete enter the local cache while Firestore is offline', async () => {
  const uid = 'reading-offline';
  const bookId = 'book';
  const db = environment.authenticatedContext(uid).firestore();
  const writerDb = db as unknown as Firestore;
  const bookRef = doc(db, 'users', uid, 'books', bookId);
  const sessionRef = doc(db, 'users', uid, 'books', bookId, 'updates', 'session');
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    await setDoc(doc(seed, 'users', uid, 'books', bookId), readingBook());
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'session'),
      readingEntry(seed, uid, bookId),
    );
  });
  await Promise.all([getDoc(bookRef), getDoc(sessionRef)]);

  await disableNetwork(db);
  const updateCompletion = queueReadingSessionUpdate({
    firestore: writerDb,
    userId: uid,
    bookId,
    sessionId: 'session',
    previous: { fromPage: 10, toPage: 20, pagesRead: 10, timeRead: 30 },
    book: { currentPage: 20, currentPageUpdateId: 'session', pageCount: 100 },
    next: { fromPage: 10, toPage: 25, timeRead: 45 },
  });
  const [localSession, localBook] = await Promise.all([
    getDocFromCache(sessionRef),
    getDocFromCache(bookRef),
  ]);
  assert.equal(localSession.metadata.hasPendingWrites, true);
  assert.equal(localSession.data()?.toPage, 25);
  assert.equal(localBook.metadata.hasPendingWrites, true);
  assert.equal(localBook.data()?.pagesRead, 25);
  assert.equal(localBook.data()?.timeRead, 75);
  assert.equal(localBook.data()?.currentPage, 25);
  assert.equal(localBook.data()?.currentPageUpdateId, 'session');
  await enableNetwork(db);
  await updateCompletion;

  await disableNetwork(db);
  const deleteCompletion = queueReadingSessionDelete({
    firestore: writerDb,
    userId: uid,
    bookId,
    sessionId: 'session',
    previous: { fromPage: 10, toPage: 25, pagesRead: 15, timeRead: 45 },
    book: { currentPage: 25, currentPageUpdateId: 'session', pageCount: 100 },
  });
  const [deletedSession, deletedBook] = await Promise.all([
    getDocFromCache(sessionRef),
    getDocFromCache(bookRef),
  ]);
  assert.equal(deletedSession.exists(), false);
  assert.equal(deletedBook.metadata.hasPendingWrites, true);
  assert.equal(deletedBook.data()?.pagesRead, 10);
  assert.equal(deletedBook.data()?.timeRead, 30);
  assert.equal(deletedBook.data()?.currentPage, 10);
  assert.equal(deletedBook.data()?.currentPageUpdateId, null);
  await enableNetwork(db);
  await deleteCompletion;
});

test('zero-page timed reading and legacy aggregate defaults correlate safely', async () => {
  const uid = 'reading-zero-legacy';
  const db = environment.authenticatedContext(uid).firestore();
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    await setDoc(
      doc(seed, 'users', uid, 'books', 'zero'),
      readingBook({
        currentPage: 10,
        currentPageUpdateId: null,
        pagesRead: 10,
        timeRead: 30,
      }),
    );
    const { pagesRead: _pagesRead, timeRead: _timeRead, ...legacy } = legacyReadingBook({
      currentPage: 10,
    });
    await setDoc(doc(seed, 'users', uid, 'books', 'legacy'), legacy);
    await setDoc(doc(seed, 'users', uid, 'books', 'old-client'), legacy);
    await setDoc(
      doc(seed, 'users', uid, 'books', 'new-old-client'),
      readingBook({ currentPage: 10, currentPageUpdateId: null }),
    );
  });

  const zeroBookRef = doc(db, 'users', uid, 'books', 'zero');
  const zeroRef = doc(db, 'users', uid, 'books', 'zero', 'updates', 'zero-reading');
  const zero = writeBatch(db);
  zero.set(zeroRef, readingEntry(db, uid, 'zero', {
    timeRead: 5,
    fromPage: 10,
    toPage: 10,
    pagesRead: 0,
  }));
  zero.update(zeroBookRef, {
    currentPage: 10,
    currentPageUpdateId: zeroRef.id,
    finished: false,
    pagesRead: increment(0),
    timeRead: increment(5),
    updatedAt: Timestamp.now(),
  });
  await assertSucceeds(zero.commit());
  const zeroSaved = (await getDoc(zeroBookRef)).data();
  assert.equal(zeroSaved?.pagesRead, 10);
  assert.equal(zeroSaved?.timeRead, 35);
  assert.equal(zeroSaved?.currentPageUpdateId, 'zero-reading');

  const legacyBookRef = doc(db, 'users', uid, 'books', 'legacy');
  const legacyRef = doc(db, 'users', uid, 'books', 'legacy', 'updates', 'new-reading');
  const legacy = writeBatch(db);
  legacy.set(legacyRef, readingEntry(db, uid, 'legacy', {
    timeRead: 5,
    fromPage: 10,
    toPage: 12,
    pagesRead: 2,
  }));
  legacy.update(legacyBookRef, {
    currentPage: 12,
    currentPageUpdateId: legacyRef.id,
    finished: false,
    pagesRead: increment(2),
    timeRead: increment(5),
    updatedAt: Timestamp.now(),
  });
  await assertSucceeds(legacy.commit());
  const legacySaved = (await getDoc(legacyBookRef)).data();
  assert.equal(legacySaved?.pagesRead, 2);
  assert.equal(legacySaved?.timeRead, 5);
  assert.equal(legacySaved?.currentPageUpdateId, 'new-reading');

  // A cached pre-migration client omits the source field. Permit that only
  // while the server book itself genuinely lacks the field.
  const oldBookRef = doc(db, 'users', uid, 'books', 'old-client');
  const oldRef = doc(db, 'users', uid, 'books', 'old-client', 'updates', 'old-reading');
  const oldClient = writeBatch(db);
  oldClient.set(oldRef, readingEntry(db, uid, 'old-client', {
    timeRead: 5,
    fromPage: 10,
    toPage: 11,
    pagesRead: 1,
  }));
  oldClient.update(oldBookRef, {
    currentPage: 11,
    finished: false,
    pagesRead: increment(1),
    timeRead: increment(5),
    updatedAt: Timestamp.now(),
  });
  await assertSucceeds(oldClient.commit());
  assert.equal((await getDoc(oldBookRef)).data()?.currentPageUpdateId, undefined);

  const incompatibleBookRef = doc(db, 'users', uid, 'books', 'new-old-client');
  const incompatibleRef = doc(
    db,
    'users',
    uid,
    'books',
    'new-old-client',
    'updates',
    'old-reading',
  );
  const incompatible = writeBatch(db);
  incompatible.set(incompatibleRef, readingEntry(db, uid, 'new-old-client', {
    timeRead: 5,
    fromPage: 10,
    toPage: 11,
    pagesRead: 1,
  }));
  incompatible.update(incompatibleBookRef, {
    currentPage: 11,
    finished: false,
    pagesRead: increment(1),
    timeRead: increment(5),
    updatedAt: Timestamp.now(),
  });
  await assertFails(incompatible.commit());
});

test('same-endpoint later correction prevents an older session from owning progress', async () => {
  const uid = 'reading-source-identity';
  const bookId = 'book';
  const db = environment.authenticatedContext(uid).firestore();
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId),
      readingBook({ currentPageUpdateId: 'correction' }),
    );
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'session'),
      readingEntry(seed, uid, bookId),
    );
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'correction'),
      pageCorrectionEntry(seed, uid, bookId, {
        fromPage: 15,
        toPage: 20,
        pagesRead: 5,
      }),
    );
  });

  await assertSucceeds(queueReadingSessionUpdate({
    firestore: db as unknown as Firestore,
    userId: uid,
    bookId,
    sessionId: 'session',
    previous: { fromPage: 10, toPage: 20, pagesRead: 10, timeRead: 30 },
    book: { currentPage: 20, currentPageUpdateId: 'correction', pageCount: 100 },
    next: { fromPage: 10, toPage: 18, timeRead: 25 },
  }));
  let saved = (await getDoc(doc(db, 'users', uid, 'books', bookId))).data();
  assert.equal(saved?.currentPage, 20);
  assert.equal(saved?.currentPageUpdateId, 'correction');

  await assertSucceeds(queueReadingSessionDelete({
    firestore: db as unknown as Firestore,
    userId: uid,
    bookId,
    sessionId: 'session',
    previous: { fromPage: 10, toPage: 18, pagesRead: 8, timeRead: 25 },
    book: { currentPage: 20, currentPageUpdateId: 'correction', pageCount: 100 },
  }));
  saved = (await getDoc(doc(db, 'users', uid, 'books', bookId))).data();
  assert.equal(saved?.currentPage, 20);
  assert.equal(saved?.currentPageUpdateId, 'correction');
});

test('session edit/delete races reject in either order and a delete cannot repeat', async () => {
  const uid = 'reading-ordering';
  const db = environment.authenticatedContext(uid).firestore();
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    for (const bookId of ['edit-first', 'delete-first']) {
      await setDoc(doc(seed, 'users', uid, 'books', bookId), readingBook());
      await setDoc(
        doc(seed, 'users', uid, 'books', bookId, 'updates', 'session'),
        readingEntry(seed, uid, bookId),
      );
    }
  });
  const previous = { fromPage: 10, toPage: 20, pagesRead: 10, timeRead: 30 };
  const sourceBook = { currentPage: 20, currentPageUpdateId: 'session', pageCount: 100 };

  await assertSucceeds(queueReadingSessionUpdate({
    firestore: db as unknown as Firestore,
    userId: uid,
    bookId: 'edit-first',
    sessionId: 'session',
    previous,
    book: sourceBook,
    next: { fromPage: 10, toPage: 25, timeRead: 45 },
  }));
  await assertFails(queueReadingSessionDelete({
    firestore: db as unknown as Firestore,
    userId: uid,
    bookId: 'edit-first',
    sessionId: 'session',
    previous,
    book: sourceBook,
  }));

  await assertSucceeds(queueReadingSessionDelete({
    firestore: db as unknown as Firestore,
    userId: uid,
    bookId: 'delete-first',
    sessionId: 'session',
    previous,
    book: sourceBook,
  }));
  await assertFails(queueReadingSessionUpdate({
    firestore: db as unknown as Firestore,
    userId: uid,
    bookId: 'delete-first',
    sessionId: 'session',
    previous,
    book: sourceBook,
    next: { fromPage: 10, toPage: 25, timeRead: 45 },
  }));
  await assertFails(queueReadingSessionDelete({
    firestore: db as unknown as Firestore,
    userId: uid,
    bookId: 'delete-first',
    sessionId: 'session',
    previous,
    book: sourceBook,
  }));

  const deletedBook = (await getDoc(doc(db, 'users', uid, 'books', 'delete-first'))).data();
  assert.equal(deletedBook?.pagesRead, 10);
  assert.equal(deletedBook?.timeRead, 30);
  assert.equal(deletedBook?.currentPage, 10);
  assert.equal(deletedBook?.currentPageUpdateId, null);
});

test('an offline session batch flushes successfully without priming the local cache', async () => {
  const uid = 'reading-cache-miss';
  const bookId = 'book';
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    await setDoc(doc(seed, 'users', uid, 'books', bookId), readingBook());
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'session'),
      readingEntry(seed, uid, bookId),
    );
  });
  const offlineDb = environment.authenticatedContext(uid).firestore();
  await assert.rejects(
    getDocFromCache(doc(offlineDb, 'users', uid, 'books', bookId)),
    /cache/i,
  );
  await disableNetwork(offlineDb);
  const completion = queueReadingSessionUpdate({
    firestore: offlineDb as unknown as Firestore,
    userId: uid,
    bookId,
    sessionId: 'session',
    previous: { fromPage: 10, toPage: 20, pagesRead: 10, timeRead: 30 },
    book: { currentPage: 20, currentPageUpdateId: 'session', pageCount: 100 },
    next: { fromPage: 10, toPage: 25, timeRead: 45 },
  });
  await enableNetwork(offlineDb);
  await completion;

  const verifier = environment.authenticatedContext(uid).firestore();
  const saved = (await getDoc(doc(verifier, 'users', uid, 'books', bookId))).data();
  assert.equal(saved?.currentPage, 25);
  assert.equal(saved?.currentPageUpdateId, 'session');
  assert.equal(saved?.pagesRead, 25);
  assert.equal(saved?.timeRead, 75);
});

test('a stale offline session write rolls its optimistic cache back after reconnect', async () => {
  const uid = 'reading-offline-stale';
  const bookId = 'book';
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    await setDoc(doc(seed, 'users', uid, 'books', bookId), readingBook());
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'session'),
      readingEntry(seed, uid, bookId),
    );
  });
  const staleDb = environment.authenticatedContext(uid).firestore();
  const staleBookRef = doc(staleDb, 'users', uid, 'books', bookId);
  const staleSessionRef = doc(staleDb, 'users', uid, 'books', bookId, 'updates', 'session');
  await Promise.all([getDoc(staleBookRef), getDoc(staleSessionRef)]);
  await disableNetwork(staleDb);

  const winnerDb = environment.authenticatedContext(uid).firestore();
  await assertSucceeds(queueReadingSessionUpdate({
    firestore: winnerDb as unknown as Firestore,
    userId: uid,
    bookId,
    sessionId: 'session',
    previous: { fromPage: 10, toPage: 20, pagesRead: 10, timeRead: 30 },
    book: { currentPage: 20, currentPageUpdateId: 'session', pageCount: 100 },
    next: { fromPage: 10, toPage: 25, timeRead: 45 },
  }));

  const staleCompletion = queueReadingSessionUpdate({
    firestore: staleDb as unknown as Firestore,
    userId: uid,
    bookId,
    sessionId: 'session',
    previous: { fromPage: 10, toPage: 20, pagesRead: 10, timeRead: 30 },
    book: { currentPage: 20, currentPageUpdateId: 'session', pageCount: 100 },
    next: { fromPage: 10, toPage: 30, timeRead: 60 },
  });
  const optimistic = await getDocFromCache(staleBookRef);
  assert.equal(optimistic.metadata.hasPendingWrites, true);
  assert.equal(optimistic.data()?.currentPage, 30);
  assert.equal(optimistic.data()?.pagesRead, 30);

  await enableNetwork(staleDb);
  await assert.rejects(staleCompletion);
  const [rolledBackBook, rolledBackSession] = await Promise.all([
    getDoc(staleBookRef),
    getDoc(staleSessionRef),
  ]);
  assert.equal(rolledBackBook.metadata.hasPendingWrites, false);
  assert.equal(rolledBackBook.data()?.currentPage, 25);
  assert.equal(rolledBackBook.data()?.currentPageUpdateId, 'session');
  assert.equal(rolledBackBook.data()?.pagesRead, 25);
  assert.equal(rolledBackBook.data()?.timeRead, 75);
  assert.equal(rolledBackSession.data()?.toPage, 25);
  assert.equal(rolledBackSession.data()?.timeRead, 45);
});

const queueItem = (overrides = {}) => ({
  type: 'create',
  bookTitle: 'The Book',
  start: '2026-08-24T12:00:00.000Z',
  stop: '2026-08-24T12:20:00.000Z',
  status: 'pending',
  createdAt: serverTimestamp(),
  ...overrides,
});

const seedToggl = async (
  uid: string,
  quota?: { windowStartedAt: Timestamp; count: number },
) => environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
  const db = context.firestore();
  await setDoc(doc(db, 'users', uid), {
    uid,
    email: `${uid}@example.test`,
    toggl: { apiToken: 'server-validated', workspaceId: 1, projectId: 2 },
  });
  if (quota !== undefined) {
    await setDoc(doc(db, 'users', uid, 'functionQuotas', 'togglQueue'), quota);
  }
});

const issue = (uid: string | null, event: string) => ({
  level: 'error',
  event,
  message: 'Stored data failed runtime validation',
  code: 'TypeError',
  uid,
  detail: null,
  createdAt: serverTimestamp(),
  expiresAt: Timestamp.fromMillis(Date.now() + 90 * 24 * 60 * 60 * 1000),
});

test('authenticated clients can report decode failures without opening anonymous telemetry', async () => {
  const owner = environment.authenticatedContext('issue-owner').firestore();
  await assertSucceeds(setDoc(
    doc(owner, 'logEvents', 'decode-failure'),
    issue('issue-owner', 'firestore.decode_failed'),
  ));
  await assertFails(setDoc(
    doc(owner, 'logEvents', 'forged-decode-failure'),
    issue('another-owner', 'firestore.decode_failed'),
  ));

  const anonymous = environment.unauthenticatedContext().firestore();
  await assertFails(setDoc(
    doc(anonymous, 'logEvents', 'anonymous-decode-failure'),
    issue(null, 'firestore.decode_failed'),
  ));
});

test('owners can create and read only exact pending Toggl queue payloads', async () => {
  await seedToggl('queue-owner');
  const owner = environment.authenticatedContext('queue-owner').firestore();
  const createRef = doc(owner, 'users', 'queue-owner', 'togglQueue', 'create');
  const stopRef = doc(owner, 'users', 'queue-owner', 'togglQueue', 'stop');
  await assertSucceeds(setDoc(createRef, queueItem()));
  await assertSucceeds(setDoc(stopRef, queueItem({type: 'stop', entryId: 42})));
  await assertSucceeds(getDoc(createRef));

  const stranger = environment.authenticatedContext('queue-stranger').firestore();
  await assertFails(getDoc(doc(stranger, 'users', 'queue-owner', 'togglQueue', 'create')));
  await assertFails(setDoc(
    doc(stranger, 'users', 'queue-owner', 'togglQueue', 'forged'),
    queueItem(),
  ));
});

test('Toggl queue creates reject malformed payloads and lifecycle fields', async () => {
  await seedToggl('queue-shape');
  const db = environment.authenticatedContext('queue-shape').firestore();
  const queue = collection(db, 'users', 'queue-shape', 'togglQueue');
  const cases = [
    queueItem({type: 'other'}),
    queueItem({bookId: 'books/123'}),
    queueItem({bookId: '.'}),
    queueItem({bookTitle: ''}),
    queueItem({start: 'August 24, 2026'}),
    queueItem({stop: '2026-08-24'}),
    queueItem({type: 'create', entryId: 42}),
    queueItem({type: 'stop'}),
    queueItem({type: 'stop', entryId: '42'}),
    queueItem({status: 'processing'}),
    queueItem({attempts: 0}),
    queueItem({claimedAt: serverTimestamp()}),
    queueItem({retryRequestedAt: serverTimestamp()}),
    queueItem({expiresAt: serverTimestamp()}),
    queueItem({unexpected: true}),
    queueItem({createdAt: 'today'}),
  ];
  for (const [index, item] of cases.entries()) {
    await assertFails(setDoc(doc(queue, String(index)), item));
  }
});

test('owners can retry only stale or failed queue states below the cap', async () => {
  const now = Date.now();
  const oldClaim = Timestamp.fromMillis(now - 7 * 60 * 60 * 1000);
  const freshClaim = Timestamp.fromMillis(now - 60 * 1000);
  const oldCreate = Timestamp.fromMillis(now - 20 * 60 * 1000);
  const expiresAt = Timestamp.fromMillis(now + 90 * 24 * 60 * 60 * 1000);
  const docs = {
    error: queueItem({
      status: 'error',
      createdAt: oldCreate,
      attempts: 1,
      claimedAt: oldClaim,
      expiresAt,
      error: 'network failed',
    }),
    staleProcessing: queueItem({
      status: 'processing',
      createdAt: oldCreate,
      attempts: 1,
      claimedAt: oldClaim,
    }),
    freshProcessing: queueItem({
      status: 'processing',
      createdAt: oldCreate,
      attempts: 1,
      claimedAt: freshClaim,
    }),
    stalePending: queueItem({createdAt: oldCreate}),
    cappedError: queueItem({
      status: 'error',
      createdAt: oldCreate,
      attempts: 5,
      claimedAt: oldClaim,
      error: 'still failing',
    }),
    synced: queueItem({
      status: 'synced',
      createdAt: oldCreate,
      attempts: 1,
      claimedAt: oldClaim,
      entryId: 42,
    }),
    outcomeUnknown: queueItem({
      status: 'outcome-unknown',
      createdAt: oldCreate,
      attempts: 1,
      claimedAt: oldClaim,
      error: 'check Toggl before retrying',
    }),
  };
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', 'queue-retry'), {
      uid: 'queue-retry',
      email: 'queue-retry@example.test',
      toggl: { apiToken: 'server-validated', workspaceId: 1, projectId: 2 },
    });
    for (const [id, item] of Object.entries(docs)) {
      await setDoc(
        doc(context.firestore(), 'users', 'queue-retry', 'togglQueue', id),
        item,
      );
    }
  });

  const db = environment.authenticatedContext('queue-retry').firestore();
  const ref = (id: string) => doc(db, 'users', 'queue-retry', 'togglQueue', id);
  const retry = () => ({status: 'pending', retryRequestedAt: serverTimestamp()});
  await assertSucceeds(updateDoc(ref('error'), retry()));
  await assertSucceeds(updateDoc(ref('staleProcessing'), retry()));
  await assertSucceeds(updateDoc(ref('stalePending'), retry()));
  await assertFails(updateDoc(ref('freshProcessing'), retry()));
  await assertFails(updateDoc(ref('cappedError'), retry()));
  await assertFails(updateDoc(ref('synced'), retry()));
  await assertFails(updateDoc(ref('outcomeUnknown'), retry()));
  await assertFails(updateDoc(ref('error'), {
    status: 'pending',
    retryRequestedAt: oldClaim,
  }));
});

test('queue retries cannot change payload or server lifecycle fields', async () => {
  const oldClaim = Timestamp.fromMillis(Date.now() - 7 * 60 * 60 * 1000);
  const expiresAt = Timestamp.fromMillis(Date.now() + 90 * 24 * 60 * 60 * 1000);
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', 'queue-immutable'), {
      uid: 'queue-immutable',
      email: 'queue-immutable@example.test',
      toggl: { apiToken: 'server-validated', workspaceId: 1, projectId: 2 },
    });
    await setDoc(
      doc(context.firestore(), 'users', 'queue-immutable', 'togglQueue', 'error'),
      queueItem({
        bookId: 'book',
        status: 'error',
        createdAt: oldClaim,
        attempts: 1,
        claimedAt: oldClaim,
        expiresAt,
        error: 'x'.repeat(2_000),
      }),
    );
    await setDoc(
      doc(context.firestore(), 'users', 'queue-immutable', 'togglQueue', 'legacy-pending'),
      queueItem({
        status: 'pending',
        createdAt: oldClaim,
        attempts: 1,
        claimedAt: oldClaim,
        error: 'legacy failure',
      }),
    );
  });
  const db = environment.authenticatedContext('queue-immutable').firestore();
  const ref = doc(db, 'users', 'queue-immutable', 'togglQueue', 'error');
  await assertFails(updateDoc(ref, {
    status: 'pending',
    retryRequestedAt: serverTimestamp(),
    attempts: 0,
  }));
  await assertFails(updateDoc(ref, {
    status: 'pending',
    retryRequestedAt: serverTimestamp(),
    bookTitle: 'Other',
  }));
  await assertFails(updateDoc(ref, {
    status: 'pending',
    retryRequestedAt: serverTimestamp(),
    error: 'changed',
  }));
  await assertFails(updateDoc(ref, {
    status: 'pending',
    retryRequestedAt: serverTimestamp(),
    error: deleteField(),
  }));
  await assertFails(updateDoc(ref, {
    status: 'pending',
    retryRequestedAt: serverTimestamp(),
    bookId: deleteField(),
  }));
  await assertFails(updateDoc(ref, {
    status: 'synced',
    retryRequestedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(ref, {status: 'pending'}));
  await assertFails(updateDoc(ref, {
    status: 'pending',
    retryRequestedAt: serverTimestamp(),
    expiresAt: Timestamp.fromMillis(expiresAt.toMillis() + 1),
  }));
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(
      doc(context.firestore(), 'users', 'queue-immutable', 'functionQuotas', 'togglQueue'),
      {windowStartedAt: Timestamp.now(), count: 10},
    );
  });
  await assertFails(updateDoc(ref, {
    status: 'pending',
    retryRequestedAt: serverTimestamp(),
  }));
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(
      doc(context.firestore(), 'users', 'queue-immutable', 'functionQuotas', 'togglQueue'),
      {windowStartedAt: Timestamp.fromMillis(Date.now() - 2 * 60 * 60 * 1000), count: 10},
    );
  });
  await assertSucceeds(updateDoc(ref, {
    status: 'pending',
    retryRequestedAt: serverTimestamp(),
  }));
  const repaired = (await getDoc(ref)).data();
  assert.equal(repaired?.error, 'x'.repeat(2_000));
  assert.equal(repaired?.attempts, 1);
  assert.ok(repaired?.retryRequestedAt instanceof Timestamp);
  const legacyPendingRef = doc(
    db, 'users', 'queue-immutable', 'togglQueue', 'legacy-pending',
  );
  await assertSucceeds(updateDoc(legacyPendingRef, {
    status: 'pending',
    retryRequestedAt: serverTimestamp(),
  }));
  const legacyPending = (await getDoc(legacyPendingRef)).data();
  assert.equal(legacyPending?.attempts, 1);
  assert.equal(legacyPending?.error, 'legacy failure');
  assert.ok(legacyPending?.retryRequestedAt instanceof Timestamp);
});

test('ordinary Toggl queue creates require configuration and an available server quota', async () => {
  const uid = 'queue-quota';
  const db = environment.authenticatedContext(uid).firestore();
  const queue = collection(db, 'users', uid, 'togglQueue');
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid), {
      uid,
      email: `${uid}@example.test`,
    });
  });
  await assertFails(setDoc(doc(queue, 'unconfigured'), queueItem()));

  await seedToggl(uid, { windowStartedAt: Timestamp.now(), count: 10 });
  await assertFails(setDoc(doc(queue, 'exhausted'), queueItem()));
  await assertFails(setDoc(doc(queue, 'book_2026-08-24T12:00:00.000Z'), queueItem({
    bookId: 'book',
  })));

  await seedToggl(uid, {
    windowStartedAt: Timestamp.fromMillis(Date.now() - 2 * 60 * 60 * 1000),
    count: 10,
  });
  await assertSucceeds(setDoc(doc(queue, 'expired-window'), queueItem()));
});

test('book owners cannot forge or erase server-owned Toggl start claims', async () => {
  const uid = 'timer-owner';
  const db = environment.authenticatedContext(uid).firestore();
  const ref = doc(db, 'users', uid, 'books', 'book');
  await assertSucceeds(setDoc(ref, {title: 'Book', activeTimer: null}));
  await assertSucceeds(updateDoc(ref, {
    activeTimer: {start: '2026-08-24T12:00:00.000Z'},
  }));
  await assertSucceeds(updateDoc(ref, {activeTimer: null}));
  await assertFails(updateDoc(ref, {
    activeTimer: {
      state: 'starting',
      operationId: 'forged',
      start: '2026-08-24T12:00:00.000Z',
      claimedAt: Timestamp.now(),
    },
  }));

  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await updateDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
      activeTimer: {
        state: 'starting',
        operationId: 'server-claim',
        start: '2026-08-24T12:00:00.000Z',
        claimedAt: Timestamp.now(),
      },
    });
  });
  await assertSucceeds(updateDoc(ref, {title: 'Renamed'}));
  await assertFails(deleteDoc(ref));
  await assertFails(updateDoc(ref, {
    activeTimer: {entryId: 42, start: '2026-08-24T12:00:00.000Z'},
  }));
  await assertFails(updateDoc(ref, {
    activeTimer: {
      state: 'starting',
      operationId: 'changed',
      start: '2026-08-24T12:00:00.000Z',
      claimedAt: Timestamp.now(),
    },
  }));
  await assertFails(updateDoc(ref, {activeTimer: null}));
});

test('book owners can clear server timers only in explicit terminal paths', async () => {
  const uid = 'timer-clear';
  const db = environment.authenticatedContext(uid).firestore();
  const ref = doc(db, 'users', uid, 'books', 'book');
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
      title: 'Book',
      activeTimer: {entryId: 42, start: '2026-08-24T12:00:00.000Z'},
    });
  });
  await assertSucceeds(updateDoc(ref, {activeTimer: null}));

  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await updateDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
      activeTimer: {
        state: 'outcome-unknown',
        operationId: 'server-claim',
        start: '2026-08-24T12:00:00.000Z',
        claimedAt: Timestamp.now(),
        error: 'Check Toggl first.',
      },
    });
  });
  await assertSucceeds(updateDoc(ref, {activeTimer: null}));
  await assertSucceeds(deleteDoc(ref));
});

test('book deletion allows no timer or a local timer but denies every remote lifecycle', async () => {
  const uid = 'timer-delete';
  const db = environment.authenticatedContext(uid).firestore();
  const ref = doc(db, 'users', uid, 'books', 'book');
  const claimedAt = Timestamp.now();
  const states: Array<{name: string; timer: unknown; allowed: boolean}> = [
    {name: 'none', timer: null, allowed: true},
    {
      name: 'local',
      timer: {start: '2026-08-24T12:00:00.000Z'},
      allowed: true,
    },
    {
      name: 'remote',
      timer: {entryId: 42, start: '2026-08-24T12:00:00.000Z'},
      allowed: false,
    },
    {
      name: 'starting',
      timer: {
        state: 'starting',
        operationId: 'operation',
        start: '2026-08-24T12:00:00.000Z',
        claimedAt,
      },
      allowed: false,
    },
    {
      name: 'outcome-unknown',
      timer: {
        state: 'outcome-unknown',
        operationId: 'operation',
        start: '2026-08-24T12:00:00.000Z',
        claimedAt,
        error: 'Check Toggl.',
      },
      allowed: false,
    },
    {
      name: 'malformed',
      timer: {start: 42},
      allowed: false,
    },
  ];

  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
      title: 'Owner only',
      activeTimer: null,
    });
  });
  const stranger = environment.authenticatedContext('timer-delete-stranger').firestore();
  await assertFails(deleteDoc(doc(stranger, 'users', uid, 'books', 'book')));
  assert.equal((await getDoc(ref)).exists(), true);

  for (const state of states) {
    await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
      await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
        title: `Book ${state.name}`,
        activeTimer: state.timer,
      });
    });
    if (state.allowed) {
      await assertSucceeds(deleteDoc(ref));
      assert.equal((await getDoc(ref)).exists(), false);
    } else {
      await assertFails(deleteDoc(ref));
      assert.equal((await getDoc(ref)).exists(), true);
    }
  }
});

test('function quota documents are inaccessible to their owner', async () => {
  const uid = 'quota-owner';
  const db = environment.authenticatedContext(uid).firestore();
  for (const quotaName of ['booksApi', 'togglQueue']) {
    const ref = doc(db, 'users', uid, 'functionQuotas', quotaName);
    await assertFails(getDoc(ref));
    await assertFails(setDoc(ref, {windowStartedAt: Timestamp.now(), count: 1}));
  }
});

test('author retirement rules prevent deletes, rewrites, and merge cycles', async () => {
  const uid = 'author-retirement';
  const db = environment.authenticatedContext(uid).firestore();
  const first = doc(db, 'users', uid, 'authors', 'first');
  const second = doc(db, 'users', uid, 'authors', 'second');
  const deleted = doc(db, 'users', uid, 'authors', 'deleted');
  const author = (name: string) => ({
    name,
    nameLower: name.toLowerCase(),
    kind: 'person',
    familyName: name,
  });
  await assertSucceeds(setDoc(first, author('First')));
  await assertSucceeds(setDoc(second, author('Second')));
  await assertSucceeds(setDoc(deleted, author('Deleted')));
  await assertSucceeds(updateDoc(deleted, {
    retirement: {reason: 'deleted'},
  }));
  await assertSucceeds(updateDoc(deleted, {
    ...author('Deleted'),
    retirement: deleteField(),
  }));
  await assertSucceeds(updateDoc(first, {
    retirement: {reason: 'merged', targetId: 'second'},
  }));
  await assertFails(updateDoc(second, {
    retirement: {reason: 'merged', targetId: 'first'},
  }));
  await assertFails(updateDoc(first, {
    retirement: {reason: 'deleted'},
  }));
  await assertFails(deleteDoc(first));
});

test('offline timer stop and queue creation are accepted or rejected atomically', async () => {
  const uid = 'atomic-stop';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', 'book');
  const remoteStart = '2026-08-24T12:00:00.000Z';
  const remoteQueueId = togglQueueId('book', remoteStart);
  const seedRemoteTimer = async () => environment.withSecurityRulesDisabled(
    async (context: RulesTestContext) => {
      await setDoc(doc(context.firestore(), 'users', uid), {
        uid,
        email: `${uid}@example.test`,
        toggl: { apiToken: 'server-validated', workspaceId: 1, projectId: 2 },
      });
      await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
        title: 'Book',
        activeTimer: {entryId: 42, start: remoteStart},
      });
    },
  );
  await seedRemoteTimer();

  const valid = writeBatch(db);
  valid.update(bookRef, {activeTimer: null});
  valid.set(doc(db, 'users', uid, 'togglQueue', remoteQueueId), queueItem({
    type: 'stop',
    bookId: 'book',
    bookTitle: 'Book',
    entryId: 42,
  }));
  await assertSucceeds(valid.commit());
  assert.equal((await getDoc(bookRef)).data()?.activeTimer, null);
  await assertSucceeds(deleteDoc(bookRef));
  assert.equal((await getDoc(bookRef)).exists(), false);
  assert.equal(
    (await getDoc(doc(db, 'users', uid, 'togglQueue', remoteQueueId))).exists(),
    true,
  );
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await deleteDoc(doc(
      context.firestore(),
      'users', uid, 'togglQueue', remoteQueueId,
    ));
  });

  await seedRemoteTimer();
  const invalid = writeBatch(db);
  invalid.update(bookRef, {activeTimer: null});
  invalid.set(doc(db, 'users', uid, 'togglQueue', remoteQueueId), queueItem({
    type: 'stop',
    bookId: 'book',
    bookTitle: 'Book',
    entryId: 42,
    stop: 'not-a-time',
  }));
  await assertFails(invalid.commit());
  assert.equal((await getDoc(bookRef)).data()?.activeTimer.entryId, 42);
  assert.equal(
    (await getDoc(doc(db, 'users', uid, 'togglQueue', remoteQueueId))).exists(),
    false,
  );

  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await updateDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
      activeTimer: {start: '2026-08-24T12:30:00.000Z'},
    });
  });
  const invalidLocal = writeBatch(db);
  invalidLocal.update(bookRef, {activeTimer: null});
  invalidLocal.set(doc(db, 'users', uid, 'togglQueue', 'book_2026-08-24T12:30:00.000Z'), queueItem({
    type: 'create',
    bookId: 'book',
    start: '2026-08-24T12:30:00.000Z',
    bookTitle: 'x'.repeat(501),
  }));
  await assertFails(invalidLocal.commit());
  assert.equal(
    (await getDoc(bookRef)).data()?.activeTimer.start,
    '2026-08-24T12:30:00.000Z',
  );
  assert.equal(
    (await getDoc(doc(db, 'users', uid, 'togglQueue', 'book_2026-08-24T12:30:00.000Z'))).exists(),
    false,
  );

  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid), {
      uid,
      email: `${uid}@example.test`,
    });
    await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
      title: 'Book',
      activeTimer: {entryId: 42, start: remoteStart},
    });
  });
  const unconfigured = writeBatch(db);
  unconfigured.update(bookRef, {activeTimer: null});
  unconfigured.set(doc(db, 'users', uid, 'togglQueue', remoteQueueId), queueItem({
    type: 'stop',
    bookId: 'book',
    bookTitle: 'Book',
    entryId: 42,
  }));
  await assertFails(unconfigured.commit());
  assert.equal((await getDoc(bookRef)).data()?.activeTimer.entryId, 42);
  assert.equal(
    (await getDoc(doc(db, 'users', uid, 'togglQueue', remoteQueueId))).exists(),
    false,
  );

  const fullWindow = Timestamp.now();
  await seedToggl(uid, {windowStartedAt: fullWindow, count: 10});

  const wrongQueueId = writeBatch(db);
  wrongQueueId.update(bookRef, {activeTimer: null});
  wrongQueueId.set(doc(db, 'users', uid, 'togglQueue', 'forged'), queueItem({
    type: 'stop',
    bookId: 'book',
    bookTitle: 'Book',
    entryId: 42,
  }));
  await assertFails(wrongQueueId.commit());
  assert.equal((await getDoc(bookRef)).data()?.activeTimer.entryId, 42);

  const wrongEntry = writeBatch(db);
  wrongEntry.update(bookRef, {activeTimer: null});
  wrongEntry.set(doc(db, 'users', uid, 'togglQueue', remoteQueueId), queueItem({
    type: 'stop',
    bookId: 'book',
    bookTitle: 'Book',
    entryId: 99,
  }));
  await assertFails(wrongEntry.commit());
  assert.equal((await getDoc(bookRef)).data()?.activeTimer.entryId, 42);

  const wrongRemoteStartValue = '2026-08-24T12:00:01.000Z';
  const wrongRemoteStart = writeBatch(db);
  wrongRemoteStart.update(bookRef, {activeTimer: null});
  wrongRemoteStart.set(
    doc(db, 'users', uid, 'togglQueue', togglQueueId('book', wrongRemoteStartValue)),
    queueItem({
      type: 'stop',
      bookId: 'book',
      bookTitle: 'Book',
      start: wrongRemoteStartValue,
      entryId: 42,
    }),
  );
  await assertFails(wrongRemoteStart.commit());
  assert.equal((await getDoc(bookRef)).data()?.activeTimer.start, remoteStart);

  await assertFails(setDoc(
    doc(db, 'users', uid, 'togglQueue', remoteQueueId),
    queueItem({
      type: 'stop',
      bookId: 'book',
      bookTitle: 'Book',
      entryId: 42,
    }),
  ));
  assert.equal((await getDoc(bookRef)).data()?.activeTimer.entryId, 42);

  // The stopping device may have an older cached title than another device.
  // Timer identity is bookId + start (+ entryId for remote timers), not title.
  const staleTitle = writeBatch(db);
  staleTitle.update(bookRef, {activeTimer: null});
  staleTitle.set(doc(db, 'users', uid, 'togglQueue', remoteQueueId), queueItem({
    type: 'stop',
    bookId: 'book',
    bookTitle: 'Another book',
    entryId: 42,
  }));
  await assertSucceeds(staleTitle.commit());
  assert.equal((await getDoc(bookRef)).data()?.activeTimer, null);
  const remoteQueue = (await getDoc(
    doc(db, 'users', uid, 'togglQueue', remoteQueueId),
  )).data();
  assert.equal(remoteQueue?.status, 'pending');
  assert.equal(remoteQueue?.type, 'stop');
  assert.equal(remoteQueue?.bookTitle, 'Another book');
  assert.equal(remoteQueue?.entryId, 42);
  assert.equal(remoteQueue?.attempts, undefined);
  assert.equal(remoteQueue?.claimedAt, undefined);

  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await updateDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
      activeTimer: {start: '2026-08-24T13:00:00.000Z'},
    });
  });
  const wrongLocalStart = writeBatch(db);
  wrongLocalStart.update(bookRef, {activeTimer: null});
  wrongLocalStart.set(doc(db, 'users', uid, 'togglQueue', 'book_2026-08-24T13:00:01.000Z'), queueItem({
    type: 'create',
    bookId: 'book',
    bookTitle: 'Book',
    start: '2026-08-24T13:00:01.000Z',
    stop: '2026-08-24T13:20:00.000Z',
  }));
  await assertFails(wrongLocalStart.commit());
  assert.equal(
    (await getDoc(bookRef)).data()?.activeTimer.start,
    '2026-08-24T13:00:00.000Z',
  );

  const local = writeBatch(db);
  local.update(bookRef, {activeTimer: null});
  local.set(doc(db, 'users', uid, 'togglQueue', 'book_2026-08-24T13:00:00.000Z'), queueItem({
    type: 'create',
    bookId: 'book',
    bookTitle: 'Book',
    start: '2026-08-24T13:00:00.000Z',
    stop: '2026-08-24T13:20:00.000Z',
  }));
  await assertSucceeds(local.commit());
  assert.equal((await getDoc(bookRef)).data()?.activeTimer, null);
  assert.equal(
    (await getDoc(doc(db, 'users', uid, 'togglQueue', 'book_2026-08-24T13:00:00.000Z'))).data()?.type,
    'create',
  );
  const localQueue = (await getDoc(
    doc(db, 'users', uid, 'togglQueue', 'book_2026-08-24T13:00:00.000Z'),
  )).data();
  assert.equal(localQueue?.status, 'pending');
  assert.equal(localQueue?.entryId, undefined);
  assert.equal(localQueue?.attempts, undefined);
  assert.equal(localQueue?.claimedAt, undefined);
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const quotaAfter = (
      await getDoc(doc(context.firestore(), 'users', uid, 'functionQuotas', 'togglQueue'))
    ).data();
    assert.equal(quotaAfter?.count, 10);
    assert.equal(quotaAfter?.windowStartedAt.toMillis(), fullWindow.toMillis());
  });
});
