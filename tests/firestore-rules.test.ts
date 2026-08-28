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

const creatableBook = (overrides: Record<string, unknown> = {}) => readingBook({
  currentPage: 0,
  currentPageUpdateId: null,
  pagesRead: 0,
  timeRead: 0,
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

test('profile documents are readable only by their owner, public or not', async () => {
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'profiles', 'public-reader'), profile('owner'));
    await setDoc(doc(context.firestore(), 'profiles', 'private-reader'), profile('owner', { public: false }));
  });
  // Public profiles are served by the publicweb function, never read from
  // the document by anonymous or third-party clients (SEC-019).
  const anonymous = environment.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(anonymous, 'profiles', 'public-reader')));
  await assertFails(getDoc(doc(anonymous, 'profiles', 'private-reader')));
  await assertFails(getDoc(doc(anonymous, 'profiles', 'no-such-reader')));
  const stranger = environment.authenticatedContext('stranger').firestore();
  await assertFails(getDoc(doc(stranger, 'profiles', 'public-reader')));
  await assertFails(getDoc(doc(stranger, 'profiles', 'private-reader')));
  const owner = environment.authenticatedContext('owner').firestore();
  await assertSucceeds(getDoc(doc(owner, 'profiles', 'public-reader')));
  await assertSucceeds(getDoc(doc(owner, 'profiles', 'private-reader')));
});

test('owners can opt public profiles into search without making markers listable', async () => {
  const owner = environment.authenticatedContext('discovery-owner').firestore();
  const profileRef = doc(owner, 'profiles', 'searchable-reader');
  const discoveryRef = doc(owner, 'profileDiscovery', 'searchable-reader');
  await assertSucceeds(setDoc(profileRef, profile('discovery-owner')));
  const missingDiscovery = await assertSucceeds(getDoc(discoveryRef));
  assert.equal(missingDiscovery.exists(), false);
  await assertSucceeds(setDoc(discoveryRef, {
    uid: 'discovery-owner',
    createdAt: serverTimestamp(),
  }));
  await assertSucceeds(getDoc(discoveryRef));

  const anonymous = environment.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(anonymous, 'profileDiscovery', 'searchable-reader')));
  await assertFails(getDocs(collection(anonymous, 'profileDiscovery')));

  const stranger = environment.authenticatedContext('discovery-stranger').firestore();
  await assertFails(getDoc(doc(stranger, 'profileDiscovery', 'searchable-reader')));
  await assertFails(deleteDoc(doc(stranger, 'profileDiscovery', 'searchable-reader')));
  await assertSucceeds(deleteDoc(discoveryRef));
  // Profile owners may safely include a marker delete in every rename or
  // profile delete batch, even when no marker exists.
  await assertSucceeds(deleteDoc(discoveryRef));
});

test('profile discovery requires an owned public profile and an exact marker', async () => {
  const owner = environment.authenticatedContext('private-discovery-owner').firestore();
  await assertSucceeds(setDoc(
    doc(owner, 'profiles', 'private-discovery'),
    profile('private-discovery-owner', { public: false }),
  ));
  await assertFails(setDoc(doc(owner, 'profileDiscovery', 'private-discovery'), {
    uid: 'private-discovery-owner',
    createdAt: serverTimestamp(),
  }));

  await assertSucceeds(setDoc(
    doc(owner, 'profiles', 'public-discovery'),
    profile('private-discovery-owner'),
  ));
  await assertFails(setDoc(doc(owner, 'profileDiscovery', 'public-discovery'), {
    uid: 'someone-else',
    createdAt: serverTimestamp(),
  }));
  await assertFails(setDoc(doc(owner, 'profileDiscovery', 'public-discovery'), {
    uid: 'private-discovery-owner',
    createdAt: serverTimestamp(),
    extra: true,
  }));
});

test('profile rename can move its discovery marker atomically', async () => {
  const db = environment.authenticatedContext('rename-discovery-owner').firestore();
  const oldProfile = doc(db, 'profiles', 'old-search-name');
  const oldDiscovery = doc(db, 'profileDiscovery', 'old-search-name');
  await assertSucceeds(setDoc(oldProfile, profile('rename-discovery-owner')));
  await assertSucceeds(setDoc(oldDiscovery, {
    uid: 'rename-discovery-owner',
    createdAt: serverTimestamp(),
  }));

  const batch = writeBatch(db);
  batch.set(doc(db, 'profiles', 'new-search-name'), profile('rename-discovery-owner'));
  batch.delete(oldProfile);
  batch.set(doc(db, 'profileDiscovery', 'new-search-name'), {
    uid: 'rename-discovery-owner',
    createdAt: serverTimestamp(),
  });
  batch.delete(oldDiscovery);
  await assertSucceeds(batch.commit());
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

test('book creation requires complete, consistent, JS-safe page state', async () => {
  const uid = 'book-create-page-state';
  const db = environment.authenticatedContext(uid).firestore();
  const books = collection(db, 'users', uid, 'books');
  await assertSucceeds(setDoc(doc(books, 'valid'), creatableBook()));

  const invalidBooks: Record<string, Record<string, unknown>> = {
    missing: { title: 'Missing state', activeTimer: null },
    fractional: creatableBook({ pageCount: 100.5 }),
    nonPositive: creatableBook({ pageCount: 0, currentPage: 0, finished: true }),
    unsafe: creatableBook({ pageCount: Number.MAX_SAFE_INTEGER + 1 }),
    beyondCount: creatableBook({ currentPage: 101 }),
    wrongFinished: creatableBook({ currentPage: 100, finished: false }),
  };
  for (const [id, book] of Object.entries(invalidBooks)) {
    await assertFails(setDoc(doc(books, id), book));
  }
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

test('an offline page-count shrink writes a correlated correction and clamps atomically', async () => {
  const uid = 'page-count-clamp';
  const bookId = 'book';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', bookId);
  const priorRef = doc(db, 'users', uid, 'books', bookId, 'updates', 'prior-reading');
  const correctionRef = doc(db, 'users', uid, 'books', bookId, 'updates', 'page-count-clamp');
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    await setDoc(doc(seed, 'users', uid, 'books', bookId), readingBook({
      authorIds: ['author'],
      currentPage: 350,
      currentPageUpdateId: 'prior-reading',
      pageCount: 400,
      finished: false,
      isbn: '',
      coverUrl: '',
      publisher: '',
      publishedDate: '',
      subjects: [],
      fiction: null,
    }));
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'prior-reading'),
      pageCorrectionEntry(seed, uid, bookId, {
        fromPage: 300,
        toPage: 350,
        pagesRead: 50,
      }),
    );
  });
  await getDoc(bookRef);
  await disableNetwork(db);

  const batch = writeBatch(db);
  batch.set(correctionRef, pageCorrectionEntry(db, uid, bookId, {
    fromPage: 350,
    toPage: 320,
    pagesRead: -30,
  }));
  batch.update(bookRef, {
    authorIds: ['author'],
    title: 'Corrected edition',
    pageCount: 320,
    currentPage: 320,
    currentPageUpdateId: correctionRef.id,
    finished: true,
    isbn: '',
    coverUrl: '',
    publisher: '',
    publishedDate: '',
    subjects: [],
    fiction: null,
    updatedAt: Timestamp.now(),
  });
  const completion = batch.commit();
  const [localBook, localCorrection] = await Promise.all([
    getDocFromCache(bookRef),
    getDocFromCache(correctionRef),
  ]);
  assert.equal(localBook.metadata.hasPendingWrites, true);
  assert.equal(localBook.data()?.pageCount, 320);
  assert.equal(localBook.data()?.currentPage, 320);
  assert.equal(localBook.data()?.currentPageUpdateId, 'page-count-clamp');
  assert.equal(localBook.data()?.finished, true);
  assert.equal(localCorrection.data()?.pagesRead, -30);

  await enableNetwork(db);
  await completion;
  const saved = (await getDoc(bookRef)).data();
  assert.equal(saved?.pageCount, 320);
  assert.equal(saved?.currentPage, 320);
  assert.equal(saved?.currentPageUpdateId, 'page-count-clamp');
  assert.equal((await getDoc(priorRef)).exists(), true);

  await assertSucceeds(updateDoc(bookRef, {
    pageCount: 500,
    finished: false,
    updatedAt: Timestamp.now(),
  }));
  assert.equal((await getDoc(bookRef)).data()?.currentPageUpdateId, 'page-count-clamp');
  await assertSucceeds(updateDoc(bookRef, {
    pageCount: 320,
    finished: true,
    updatedAt: Timestamp.now(),
  }));
  assert.equal((await getDoc(bookRef)).data()?.currentPageUpdateId, 'page-count-clamp');

  await assertFails(updateDoc(bookRef, {
    pageCount: 300,
    finished: false,
    updatedAt: Timestamp.now(),
  }));
  await assertFails(updateDoc(bookRef, {
    pageCount: 500,
    finished: true,
    updatedAt: Timestamp.now(),
  }));
  await assertFails(updateDoc(bookRef, {
    pageCount: 0,
    currentPage: 0,
    currentPageUpdateId: null,
    finished: true,
    updatedAt: Timestamp.now(),
  }));

  await assertSucceeds(updateDoc(bookRef, {
    pageCount: 500,
    finished: false,
    updatedAt: Timestamp.now(),
  }));
  const extraRef = doc(db, 'users', uid, 'books', bookId, 'updates', 'extra-field-clamp');
  const extra = writeBatch(db);
  extra.set(extraRef, pageCorrectionEntry(db, uid, bookId, {
    fromPage: 320,
    toPage: 300,
    pagesRead: -20,
  }));
  extra.update(bookRef, {
    pageCount: 300,
    currentPage: 300,
    currentPageUpdateId: extraRef.id,
    finished: true,
    unexpectedField: 'not editable metadata',
    updatedAt: Timestamp.now(),
  });
  await assertFails(extra.commit());
});

test('a page-count clamp establishes progress provenance on a legacy book', async () => {
  const uid = 'page-count-clamp-legacy';
  const bookId = 'book';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', bookId);
  const correctionRef = doc(
    db,
    'users',
    uid,
    'books',
    bookId,
    'updates',
    'legacy-clamp',
  );
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(
      doc(context.firestore(), 'users', uid, 'books', bookId),
      legacyReadingBook({ currentPage: 350, pageCount: 400, finished: false }),
    );
  });

  const batch = writeBatch(db);
  batch.set(correctionRef, pageCorrectionEntry(db, uid, bookId, {
    fromPage: 350,
    toPage: 320,
    pagesRead: -30,
  }));
  batch.update(bookRef, {
    pageCount: 320,
    currentPage: 320,
    currentPageUpdateId: correctionRef.id,
    finished: true,
    updatedAt: Timestamp.now(),
  });
  await assertSucceeds(batch.commit());
  const saved = (await getDoc(bookRef)).data();
  assert.equal(saved?.currentPage, 320);
  assert.equal(saved?.currentPageUpdateId, 'legacy-clamp');
});

test('a title-only edit repairs legacy progress beyond an unchanged page count', async () => {
  const uid = 'page-count-clamp-inflated-legacy';
  const bookId = 'book';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', bookId);
  const correctionRef = doc(
    db,
    'users',
    uid,
    'books',
    bookId,
    'updates',
    'title-edit-repair',
  );
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(
      doc(context.firestore(), 'users', uid, 'books', bookId),
      readingBook({
        title: 'Old title',
        currentPage: 350,
        currentPageUpdateId: 'prior-reading',
        pageCount: 320,
        finished: false,
      }),
    );
  });

  const batch = writeBatch(db);
  batch.set(correctionRef, pageCorrectionEntry(db, uid, bookId, {
    fromPage: 350,
    toPage: 320,
    pagesRead: -30,
  }));
  batch.update(bookRef, {
    title: 'New title',
    currentPage: 320,
    currentPageUpdateId: correctionRef.id,
    finished: true,
    updatedAt: Timestamp.now(),
  });
  await assertSucceeds(batch.commit());

  const saved = (await getDoc(bookRef)).data();
  assert.equal(saved?.title, 'New title');
  assert.equal(saved?.pageCount, 320);
  assert.equal(saved?.currentPage, 320);
  assert.equal(saved?.currentPageUpdateId, correctionRef.id);
});

test('a stale offline page-count clamp rejects and rolls back after a newer reading', async () => {
  const uid = 'page-count-clamp-stale';
  const bookId = 'book';
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    await setDoc(doc(seed, 'users', uid, 'books', bookId), readingBook({
      currentPage: 350,
      currentPageUpdateId: 'prior-reading',
      pageCount: 400,
      finished: false,
      pagesRead: 350,
      timeRead: 60,
    }));
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'prior-reading'),
      pageCorrectionEntry(seed, uid, bookId, {
        fromPage: 300,
        toPage: 350,
        pagesRead: 50,
      }),
    );
  });

  const staleDb = environment.authenticatedContext(uid).firestore();
  const staleBookRef = doc(staleDb, 'users', uid, 'books', bookId);
  const staleCorrectionRef = doc(
    staleDb,
    'users',
    uid,
    'books',
    bookId,
    'updates',
    'stale-clamp',
  );
  await getDoc(staleBookRef);
  await disableNetwork(staleDb);

  const stale = writeBatch(staleDb);
  stale.set(staleCorrectionRef, pageCorrectionEntry(staleDb, uid, bookId, {
    fromPage: 350,
    toPage: 320,
    pagesRead: -30,
  }));
  stale.update(staleBookRef, {
    title: 'Stale metadata title',
    pageCount: 320,
    currentPage: 320,
    currentPageUpdateId: staleCorrectionRef.id,
    finished: true,
    updatedAt: Timestamp.now(),
  });
  const staleCompletion = stale.commit();
  assert.equal((await getDocFromCache(staleBookRef)).data()?.currentPage, 320);
  assert.equal((await getDocFromCache(staleCorrectionRef)).exists(), true);

  const winnerDb = environment.authenticatedContext(uid).firestore();
  const winnerBookRef = doc(winnerDb, 'users', uid, 'books', bookId);
  const winnerRef = doc(winnerDb, 'users', uid, 'books', bookId, 'updates', 'winner-reading');
  const winner = writeBatch(winnerDb);
  winner.set(winnerRef, readingEntry(winnerDb, uid, bookId, {
    fromPage: 350,
    toPage: 360,
    pagesRead: 10,
  }));
  winner.update(winnerBookRef, {
    currentPage: 360,
    currentPageUpdateId: winnerRef.id,
    finished: false,
    pagesRead: increment(10),
    timeRead: increment(30),
    updatedAt: Timestamp.now(),
  });
  await assertSucceeds(winner.commit());

  await enableNetwork(staleDb);
  await assert.rejects(staleCompletion);
  const [rolledBackBook, rolledBackCorrection] = await Promise.all([
    getDoc(staleBookRef),
    getDoc(staleCorrectionRef),
  ]);
  assert.equal(rolledBackBook.data()?.title, 'Reading book');
  assert.equal(rolledBackBook.data()?.pageCount, 400);
  assert.equal(rolledBackBook.data()?.currentPage, 360);
  assert.equal(rolledBackBook.data()?.currentPageUpdateId, 'winner-reading');
  assert.equal(rolledBackBook.data()?.pagesRead, 360);
  assert.equal(rolledBackCorrection.exists(), false);
});

test('a stale ordinary metadata edit preserves concurrent reading progress', async () => {
  const uid = 'page-count-metadata-race';
  const bookId = 'book';
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(
      doc(context.firestore(), 'users', uid, 'books', bookId),
      readingBook({
        currentPage: 350,
        currentPageUpdateId: 'prior-reading',
        pageCount: 400,
        pagesRead: 350,
      }),
    );
  });

  const staleDb = environment.authenticatedContext(uid).firestore();
  const staleBookRef = doc(staleDb, 'users', uid, 'books', bookId);
  await getDoc(staleBookRef);
  await disableNetwork(staleDb);
  const staleCompletion = updateDoc(staleBookRef, {
    title: 'Offline metadata title',
    pageCount: 390,
    finished: false,
    updatedAt: Timestamp.now(),
  });
  assert.equal((await getDocFromCache(staleBookRef)).data()?.pageCount, 390);

  const winnerDb = environment.authenticatedContext(uid).firestore();
  const winnerBookRef = doc(winnerDb, 'users', uid, 'books', bookId);
  const winnerRef = doc(winnerDb, 'users', uid, 'books', bookId, 'updates', 'winner-reading');
  const winner = writeBatch(winnerDb);
  winner.set(winnerRef, readingEntry(winnerDb, uid, bookId, {
    fromPage: 350,
    toPage: 360,
    pagesRead: 10,
  }));
  winner.update(winnerBookRef, {
    currentPage: 360,
    currentPageUpdateId: winnerRef.id,
    finished: false,
    pagesRead: increment(10),
    timeRead: increment(30),
    updatedAt: Timestamp.now(),
  });
  await assertSucceeds(winner.commit());

  await enableNetwork(staleDb);
  await staleCompletion;
  const saved = (await getDoc(staleBookRef)).data();
  assert.equal(saved?.title, 'Offline metadata title');
  assert.equal(saved?.pageCount, 390);
  assert.equal(saved?.currentPage, 360);
  assert.equal(saved?.currentPageUpdateId, 'winner-reading');
  assert.equal(saved?.pagesRead, 360);
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
    previousProgressUpdate: null,
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
    await setDoc(
      doc(seed, 'users', uid, 'books', bookId, 'updates', 'prior'),
      readingEntry(seed, uid, bookId, {
        fromPage: 0, toPage: 10, pagesRead: 10,
        createdAt: Timestamp.fromMillis(Date.now() - 1_000),
      }),
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
    previousProgressUpdate: {id: 'prior', toPage: 10},
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
  assert.equal(deletedBook.data()?.currentPageUpdateId, 'prior');
  await enableNetwork(db);
  await deleteCompletion;
});

test('deleting progress owners hands off to surviving reading and correction rows', async () => {
  const uid = 'reading-delete-handoff';
  const db = environment.authenticatedContext(uid).firestore();
  const writerDb = db as unknown as Firestore;
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    for (const [bookId, priorType] of [['reading-prior', 'reading'], ['correction-prior', 'update']] as const) {
      await setDoc(
        doc(seed, 'users', uid, 'books', bookId),
        readingBook({currentPageUpdateId: 'latest'}),
      );
      const prior = priorType === 'reading'
        ? readingEntry(seed, uid, bookId, {fromPage: 0, toPage: 10, pagesRead: 10})
        : pageCorrectionEntry(seed, uid, bookId, {fromPage: 5, toPage: 10, pagesRead: 5});
      await setDoc(doc(seed, 'users', uid, 'books', bookId, 'updates', 'prior'), prior);
      await setDoc(
        doc(seed, 'users', uid, 'books', bookId, 'updates', 'latest'),
        readingEntry(seed, uid, bookId),
      );
    }
  });

  for (const bookId of ['reading-prior', 'correction-prior']) {
    await assertSucceeds(queueReadingSessionDelete({
      firestore: writerDb,
      userId: uid,
      bookId,
      sessionId: 'latest',
      previous: {fromPage: 10, toPage: 20, pagesRead: 10, timeRead: 30},
      book: {currentPage: 20, currentPageUpdateId: 'latest', pageCount: 100},
      previousProgressUpdate: {id: 'prior', toPage: 10},
    }));
    const saved = (await getDoc(doc(db, 'users', uid, 'books', bookId))).data();
    assert.equal(saved?.currentPage, 10);
    assert.equal(saved?.currentPageUpdateId, 'prior');
    assert.equal(saved?.pagesRead, 10);
    assert.equal(saved?.timeRead, 30);
  }

  await assertSucceeds(queueReadingSessionDelete({
    firestore: writerDb,
    userId: uid,
    bookId: 'reading-prior',
    sessionId: 'prior',
    previous: {fromPage: 0, toPage: 10, pagesRead: 10, timeRead: 30},
    book: {currentPage: 10, currentPageUpdateId: 'prior', pageCount: 100},
    previousProgressUpdate: null,
  }));
  const emptied = (await getDoc(doc(db, 'users', uid, 'books', 'reading-prior'))).data();
  assert.equal(emptied?.currentPage, 0);
  assert.equal(emptied?.currentPageUpdateId, null);
  assert.equal(emptied?.pagesRead, 0);
  assert.equal(emptied?.timeRead, 0);
});

test('session deletion rejects missing, wrong-page, and cross-book progress predecessors', async () => {
  const uid = 'reading-delete-invalid-predecessor';
  const db = environment.authenticatedContext(uid).firestore();
  const writerDb = db as unknown as Firestore;
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    for (const bookId of ['missing', 'wrong-page', 'cross-book', 'other']) {
      await setDoc(
        doc(seed, 'users', uid, 'books', bookId),
        readingBook({currentPageUpdateId: bookId === 'other' ? 'predecessor' : 'latest'}),
      );
      if (bookId !== 'other') {
        await setDoc(
          doc(seed, 'users', uid, 'books', bookId, 'updates', 'latest'),
          readingEntry(seed, uid, bookId),
        );
      }
    }
    await setDoc(
      doc(seed, 'users', uid, 'books', 'wrong-page', 'updates', 'predecessor'),
      readingEntry(seed, uid, 'wrong-page', {fromPage: 0, toPage: 9, pagesRead: 9}),
    );
    await setDoc(
      doc(seed, 'users', uid, 'books', 'other', 'updates', 'predecessor'),
      readingEntry(seed, uid, 'other', {fromPage: 0, toPage: 10, pagesRead: 10}),
    );
  });

  for (const bookId of ['missing', 'wrong-page', 'cross-book']) {
    await assertFails(queueReadingSessionDelete({
      firestore: writerDb,
      userId: uid,
      bookId,
      sessionId: 'latest',
      previous: {fromPage: 10, toPage: 20, pagesRead: 10, timeRead: 30},
      book: {currentPage: 20, currentPageUpdateId: 'latest', pageCount: 100},
      // The local candidate claims the right endpoint; rules verify the
      // actual same-book row exists and agrees.
      previousProgressUpdate: {id: 'predecessor', toPage: 10},
    }));
    assert.equal(
      (await getDoc(doc(db, 'users', uid, 'books', bookId))).data()?.currentPageUpdateId,
      'latest',
    );
  }
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
    previousProgressUpdate: null,
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
    previousProgressUpdate: null,
  }));

  await assertSucceeds(queueReadingSessionDelete({
    firestore: db as unknown as Firestore,
    userId: uid,
    bookId: 'delete-first',
    sessionId: 'session',
    previous,
    book: sourceBook,
    previousProgressUpdate: null,
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
    previousProgressUpdate: null,
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

const idleLifecycle = (cleared: unknown = null) => ({version: 1, state: 'idle', cleared});
const localLifecycle = (bookId: string, start: string, operationId: string) => ({
  version: 1, state: 'local', bookId, start, operationId,
});
const remoteLifecycle = (bookId: string, start: string, entryId: number) => ({
  version: 1, state: 'remote', bookId, start, entryId,
});
const stoppingLifecycle = (
  bookId: string, start: string, entryId: number, queueId: string,
) => ({version: 1, state: 'stopping', bookId, start, entryId, queueId});

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

test('logEvents has no client path at all: telemetry goes through the callable', async () => {
  const owner = environment.authenticatedContext('issue-owner').firestore();
  // The exact row the old rules accepted from a signed-in client.
  await assertFails(setDoc(
    doc(owner, 'logEvents', 'decode-failure'),
    issue('issue-owner', 'firestore.decode_failed'),
  ));
  await assertFails(getDoc(doc(owner, 'logEvents', 'decode-failure')));
  await assertFails(getDocs(collection(owner, 'logEvents')));

  const anonymous = environment.unauthenticatedContext().firestore();
  // The exact row the old rules accepted from a signed-out client.
  await assertFails(setDoc(
    doc(anonymous, 'logEvents', 'sign-in-failure'),
    issue(null, 'auth.sign_in_failed'),
  ));
  await assertFails(setDoc(
    doc(anonymous, 'logEvents', 'sign-up-failure'),
    issue(null, 'auth.sign_up_failed'),
  ));
  await assertFails(getDocs(collection(anonymous, 'logEvents')));
});

test('the issue-report quota document is inaccessible to its owner', async () => {
  const uid = 'issue-quota-owner';
  const db = environment.authenticatedContext(uid).firestore();
  const ref = doc(db, 'users', uid, 'functionQuotas', 'issueReports');
  await assertFails(getDoc(ref));
  await assertFails(setDoc(ref, {windowStartedAt: Timestamp.now(), count: 0}));
  await assertFails(deleteDoc(ref));
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
  const staleRetryRequest = Timestamp.fromMillis(now - 11 * 60 * 1000);
  const freshRetryRequest = Timestamp.fromMillis(now - 60 * 1000);
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
    staleRetryMarker: queueItem({
      createdAt: oldCreate,
      retryRequestedAt: staleRetryRequest,
    }),
    freshRetryMarker: queueItem({
      createdAt: oldCreate,
      retryRequestedAt: freshRetryRequest,
    }),
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
  await assertSucceeds(updateDoc(ref('staleRetryMarker'), retry()));
  await assertFails(updateDoc(ref('freshRetryMarker'), retry()));
  await assertFails(updateDoc(ref('freshProcessing'), retry()));
  await assertFails(updateDoc(ref('cappedError'), retry()));
  await assertFails(updateDoc(ref('synced'), retry()));
  await assertFails(updateDoc(ref('outcomeUnknown'), retry()));
  await assertFails(updateDoc(ref('error'), {
    status: 'pending',
    retryRequestedAt: oldClaim,
  }));
});

test('an owner can request a valid queue retry while the server quota is full', async () => {
  const uid = 'queue-retry-full-quota';
  const oldClaim = Timestamp.fromMillis(Date.now() - 7 * 60 * 60 * 1000);
  await seedToggl(uid, {windowStartedAt: Timestamp.now(), count: 10});
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(
      doc(context.firestore(), 'users', uid, 'togglQueue', 'failed-stop'),
      queueItem({
        status: 'error',
        createdAt: oldClaim,
        attempts: 1,
        claimedAt: oldClaim,
        error: 'confirmed failure',
      }),
    );
  });

  const db = environment.authenticatedContext(uid).firestore();
  await assertSucceeds(updateDoc(
    doc(db, 'users', uid, 'togglQueue', 'failed-stop'),
    {status: 'pending', retryRequestedAt: serverTimestamp()},
  ));
  await assertFails(updateDoc(
    doc(db, 'users', uid, 'togglQueue', 'failed-stop'),
    {status: 'pending', retryRequestedAt: serverTimestamp()},
  ));
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

test('local timer books and lifecycle claims must change in one exact batch', async () => {
  const uid = 'timer-owner';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', 'book');
  const lifecycleRef = doc(db, 'users', uid, 'timerLifecycle', 'current');
  const start = '2026-08-24T12:00:00.000Z';
  const first = {start, operationId: 'first-operation'};
  const firstClaim = localLifecycle('book', start, first.operationId);
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), creatableBook());
    await setDoc(doc(context.firestore(), 'users', uid, 'timerLifecycle', 'current'), idleLifecycle());
  });

  await assertFails(updateDoc(bookRef, {activeTimer: first}));
  await assertFails(updateDoc(lifecycleRef, firstClaim));
  const startBatch = writeBatch(db);
  startBatch.update(bookRef, {activeTimer: first});
  startBatch.set(lifecycleRef, firstClaim);
  await assertSucceeds(startBatch.commit());

  const forged = writeBatch(db);
  forged.update(bookRef, {activeTimer: {entryId: 42, start}});
  forged.set(lifecycleRef, remoteLifecycle('book', start, 42));
  await assertFails(forged.commit());

  const stopBatch = writeBatch(db);
  stopBatch.update(bookRef, {activeTimer: null});
  stopBatch.set(lifecycleRef, idleLifecycle(firstClaim));
  await assertSucceeds(stopBatch.commit());

  const second = {start, operationId: 'second-operation'};
  const secondClaim = localLifecycle('book', start, second.operationId);
  const restart = writeBatch(db);
  restart.update(bookRef, {activeTimer: second});
  restart.set(lifecycleRef, secondClaim);
  await assertSucceeds(restart.commit());

  const staleClear = writeBatch(db);
  staleClear.update(bookRef, {activeTimer: null});
  staleClear.set(lifecycleRef, idleLifecycle(firstClaim));
  await assertFails(staleClear.commit());
  assert.equal((await getDoc(bookRef)).data()?.activeTimer.operationId, second.operationId);
});

test('server-owned timer states cannot be forged and unknown clear is exactly correlated', async () => {
  const uid = 'timer-server-state';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', 'book');
  const lifecycleRef = doc(db, 'users', uid, 'timerLifecycle', 'current');
  const start = '2026-08-24T12:00:00.000Z';
  const claimedAt = Timestamp.now();
  const timer = {
    state: 'outcome-unknown', operationId: 'server-operation', start,
    claimedAt, error: 'Check Toggl first.',
  };
  const claim = {version: 1, bookId: 'book', ...timer};
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
      ...creatableBook(), activeTimer: timer,
    });
    await setDoc(doc(context.firestore(), 'users', uid, 'timerLifecycle', 'current'), claim);
  });
  await assertSucceeds(updateDoc(bookRef, {title: 'Metadata still works'}));
  await assertFails(updateDoc(bookRef, {activeTimer: null}));
  await assertFails(updateDoc(lifecycleRef, idleLifecycle(claim)));
  const clear = writeBatch(db);
  clear.update(bookRef, {activeTimer: null});
  clear.set(lifecycleRef, idleLifecycle(claim));
  await assertSucceeds(clear.commit());
});

test('book deletion discards only an exactly claimed local timer', async () => {
  const uid = 'timer-delete';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', 'book');
  const lifecycleRef = doc(db, 'users', uid, 'timerLifecycle', 'current');
  const timer = {start: '2026-08-24T12:00:00.000Z', operationId: 'delete-local'};
  const claim = localLifecycle('book', timer.start, timer.operationId);
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
      ...creatableBook(), activeTimer: timer,
    });
    await setDoc(doc(context.firestore(), 'users', uid, 'timerLifecycle', 'current'), claim);
  });
  await assertFails(deleteDoc(bookRef));
  const deletion = writeBatch(db);
  deletion.delete(bookRef);
  deletion.set(lifecycleRef, idleLifecycle(claim));
  await assertSucceeds(deletion.commit());
  assert.equal((await getDoc(bookRef)).exists(), false);
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

test('remote offline stop atomically creates one exact queue row and stopping lock', async () => {
  const uid = 'atomic-remote-stop';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', 'book');
  const lifecycleRef = doc(db, 'users', uid, 'timerLifecycle', 'current');
  const start = '2026-08-24T12:00:00.000Z';
  const queueId = togglQueueId('book', start);
  const queueRef = doc(db, 'users', uid, 'togglQueue', queueId);
  const remote = remoteLifecycle('book', start, 42);
  const stopping = stoppingLifecycle('book', start, 42, queueId);
  const stoppingTimer = {state: 'stopping', entryId: 42, start, queueId};
  await seedToggl(uid, {windowStartedAt: Timestamp.now(), count: 0});
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
      title: 'Book', activeTimer: {entryId: 42, start},
    });
    await setDoc(doc(context.firestore(), 'users', uid, 'timerLifecycle', 'current'), remote);
  });

  const queue = queueItem({
    type: 'stop', bookId: 'book', bookTitle: 'Cached title', entryId: 42,
    start, timerClaimVersion: 1,
  });
  await assertFails(setDoc(queueRef, queue));
  const half = writeBatch(db);
  half.update(bookRef, {activeTimer: stoppingTimer});
  half.set(queueRef, queue);
  await assertFails(half.commit());

  const legacyQueue = queueItem({
    type: 'stop', bookId: 'book', bookTitle: 'Cached title', entryId: 42,
    start,
  });
  for (const [id, item] of [
    ['forged', queue],
    [queueId, {...queue, entryId: 99}],
    [queueId, {...queue, start: '2026-08-24T12:00:01.000Z'}],
    [queueId, legacyQueue],
  ] as const) {
    const forged = writeBatch(db);
    forged.update(bookRef, {activeTimer: {...stoppingTimer, queueId: id}});
    forged.set(lifecycleRef, {...stopping, queueId: id});
    forged.set(doc(db, 'users', uid, 'togglQueue', id), item);
    await assertFails(forged.commit());
  }

  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(
      doc(context.firestore(), 'users', uid, 'functionQuotas', 'togglQueue'),
      {windowStartedAt: Timestamp.now(), count: 10},
    );
  });

  const valid = writeBatch(db);
  valid.update(bookRef, {activeTimer: stoppingTimer});
  valid.set(lifecycleRef, stopping);
  valid.set(queueRef, queue);
  await assertSucceeds(valid.commit());
  assert.deepEqual((await getDoc(bookRef)).data()?.activeTimer, stoppingTimer);
  assert.deepEqual((await getDoc(lifecycleRef)).data(), stopping);
  assert.equal((await getDoc(queueRef)).data()?.bookTitle, 'Cached title');
});

test('local offline stop atomically clears its exact claim even at full quota', async () => {
  const uid = 'atomic-local-stop';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', 'book');
  const lifecycleRef = doc(db, 'users', uid, 'timerLifecycle', 'current');
  const start = '2026-08-24T13:00:00.000Z';
  const operationId = 'local-operation';
  const claim = localLifecycle('book', start, operationId);
  const queueId = togglQueueId('book', start);
  const queueRef = doc(db, 'users', uid, 'togglQueue', queueId);
  await seedToggl(uid, {windowStartedAt: Timestamp.now(), count: 10});
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
      title: 'Book', activeTimer: {start, operationId},
    });
    await setDoc(doc(context.firestore(), 'users', uid, 'timerLifecycle', 'current'), claim);
  });
  const queue = queueItem({
    bookId: 'book', bookTitle: 'Book', start, timerClaimVersion: 1,
  });
  const wrong = writeBatch(db);
  wrong.update(bookRef, {activeTimer: null});
  wrong.set(lifecycleRef, idleLifecycle({...claim, operationId: 'wrong'}));
  wrong.set(queueRef, queue);
  await assertFails(wrong.commit());

  const valid = writeBatch(db);
  valid.update(bookRef, {activeTimer: null});
  valid.set(lifecycleRef, idleLifecycle(claim));
  valid.set(queueRef, queue);
  await assertSucceeds(valid.commit());
  assert.equal((await getDoc(bookRef)).data()?.activeTimer, null);
  assert.deepEqual((await getDoc(lifecycleRef)).data()?.cleared, claim);
  assert.equal((await getDoc(queueRef)).data()?.timerClaimVersion, 1);
});

test('timer mutation validation fails closed without blocking unmigrated metadata edits', async () => {
  const uid = 'unmigrated-timer';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', 'book');
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
      title: 'Before', activeTimer: null,
    });
  });
  await assertSucceeds(updateDoc(bookRef, {title: 'After'}));
  await assertFails(updateDoc(bookRef, {
    activeTimer: {start: '2026-08-24T12:00:00.000Z', operationId: 'new'},
  }));
  assert.equal((await getDoc(bookRef)).data()?.title, 'After');
});

test('local timer client writes reject malformed and oversized identity fields', async () => {
  const uid = 'malformed-local-timer';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', 'book');
  const lifecycleRef = doc(db, 'users', uid, 'timerLifecycle', 'current');
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), creatableBook());
    await setDoc(doc(context.firestore(), 'users', uid, 'timerLifecycle', 'current'), idleLifecycle());
  });
  for (const timer of [
    {start: 'not-a-time', operationId: 'operation'},
    {start: '2026-08-24T12:00:00.000Z', operationId: 'x'.repeat(101)},
    {start: `${'2'.repeat(65)}Z`, operationId: 'operation'},
  ]) {
    const batch = writeBatch(db);
    batch.update(bookRef, {activeTimer: timer});
    batch.set(lifecycleRef, localLifecycle('book', timer.start, timer.operationId));
    await assertFails(batch.commit());
  }
});

test('local timer start and stop remain optimistic while Firestore is offline', async () => {
  const uid = 'offline-local-timer';
  const db = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(db, 'users', uid, 'books', 'book');
  const lifecycleRef = doc(db, 'users', uid, 'timerLifecycle', 'current');
  const start = '2026-08-24T14:00:00.000Z';
  const operationId = 'offline-operation';
  const claim = localLifecycle('book', start, operationId);
  await seedToggl(uid);
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), creatableBook());
    await setDoc(doc(context.firestore(), 'users', uid, 'timerLifecycle', 'current'), idleLifecycle());
  });
  await Promise.all([getDoc(bookRef), getDoc(lifecycleRef)]);
  await disableNetwork(db);

  const startBatch = writeBatch(db);
  startBatch.update(bookRef, {activeTimer: {start, operationId}});
  startBatch.set(lifecycleRef, claim);
  const started = startBatch.commit();
  assert.equal((await getDocFromCache(bookRef)).metadata.hasPendingWrites, true);
  assert.equal((await getDocFromCache(lifecycleRef)).data()?.state, 'local');
  await enableNetwork(db);
  await started;

  await disableNetwork(db);
  const queueId = togglQueueId('book', start);
  const stopBatch = writeBatch(db);
  stopBatch.update(bookRef, {activeTimer: null});
  stopBatch.set(lifecycleRef, idleLifecycle(claim));
  stopBatch.set(doc(db, 'users', uid, 'togglQueue', queueId), queueItem({
    bookId: 'book', bookTitle: 'Book', start, timerClaimVersion: 1,
  }));
  const stopped = stopBatch.commit();
  assert.equal((await getDocFromCache(bookRef)).data()?.activeTimer, null);
  assert.equal((await getDocFromCache(lifecycleRef)).data()?.state, 'idle');
  await enableNetwork(db);
  await stopped;
  assert.equal((await getDoc(bookRef)).data()?.activeTimer, null);
});

test('a stale offline timer clear rolls back after the same book restarts', async () => {
  const uid = 'stale-offline-timer-clear';
  const staleDb = environment.authenticatedContext(uid).firestore();
  const bookRef = doc(staleDb, 'users', uid, 'books', 'book');
  const lifecycleRef = doc(staleDb, 'users', uid, 'timerLifecycle', 'current');
  const start = '2026-08-24T15:00:00.000Z';
  const first = localLifecycle('book', start, 'first-operation');
  const second = localLifecycle('book', start, 'second-operation');
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
      ...creatableBook(), activeTimer: {start, operationId: first.operationId},
    });
    await setDoc(doc(context.firestore(), 'users', uid, 'timerLifecycle', 'current'), first);
  });
  await Promise.all([getDoc(bookRef), getDoc(lifecycleRef)]);
  await disableNetwork(staleDb);
  const stale = writeBatch(staleDb);
  stale.update(bookRef, {activeTimer: null});
  stale.set(lifecycleRef, idleLifecycle(first));
  const completion = stale.commit();
  assert.equal((await getDocFromCache(bookRef)).data()?.activeTimer, null);

  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await updateDoc(doc(context.firestore(), 'users', uid, 'books', 'book'), {
      activeTimer: {start, operationId: second.operationId},
    });
    await setDoc(doc(context.firestore(), 'users', uid, 'timerLifecycle', 'current'), second);
  });
  await enableNetwork(staleDb);
  await assert.rejects(completion);
  assert.equal((await getDoc(bookRef)).data()?.activeTimer.operationId, second.operationId);
  assert.equal((await getDoc(lifecycleRef)).data()?.operationId, second.operationId);
});

test('two offline local starts serialize on the user-wide lifecycle after reconnect', async () => {
  const uid = 'concurrent-offline-local-starts';
  const firstDb = environment.authenticatedContext(uid).firestore();
  const secondDb = environment.authenticatedContext(uid).firestore();
  const firstBook = doc(firstDb, 'users', uid, 'books', 'first');
  const secondBook = doc(secondDb, 'users', uid, 'books', 'second');
  const firstLifecycle = doc(firstDb, 'users', uid, 'timerLifecycle', 'current');
  const secondLifecycle = doc(secondDb, 'users', uid, 'timerLifecycle', 'current');
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    await Promise.all([
      setDoc(doc(seed, 'users', uid, 'books', 'first'), creatableBook()),
      setDoc(doc(seed, 'users', uid, 'books', 'second'), creatableBook()),
      setDoc(doc(seed, 'users', uid, 'timerLifecycle', 'current'), idleLifecycle()),
    ]);
  });
  await Promise.all([
    getDoc(firstBook), getDoc(firstLifecycle),
    getDoc(secondBook), getDoc(secondLifecycle),
  ]);
  await Promise.all([disableNetwork(firstDb), disableNetwork(secondDb)]);
  const firstClaim = localLifecycle(
    'first', '2026-08-24T18:00:00.000Z', 'first-operation',
  );
  const secondClaim = localLifecycle(
    'second', '2026-08-24T18:00:00.000Z', 'second-operation',
  );
  const firstBatch = writeBatch(firstDb);
  firstBatch.update(firstBook, {
    activeTimer: {start: firstClaim.start, operationId: firstClaim.operationId},
  });
  firstBatch.set(firstLifecycle, firstClaim);
  const secondBatch = writeBatch(secondDb);
  secondBatch.update(secondBook, {
    activeTimer: {start: secondClaim.start, operationId: secondClaim.operationId},
  });
  secondBatch.set(secondLifecycle, secondClaim);
  const firstCompletion = firstBatch.commit();
  const secondCompletion = secondBatch.commit();
  assert.equal((await getDocFromCache(firstBook)).data()?.activeTimer.operationId, 'first-operation');
  assert.equal((await getDocFromCache(secondBook)).data()?.activeTimer.operationId, 'second-operation');

  await Promise.all([enableNetwork(firstDb), enableNetwork(secondDb)]);
  const results = await Promise.allSettled([firstCompletion, secondCompletion]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    const seed = context.firestore();
    const [first, second, lifecycle] = await Promise.all([
      getDoc(doc(seed, 'users', uid, 'books', 'first')),
      getDoc(doc(seed, 'users', uid, 'books', 'second')),
      getDoc(doc(seed, 'users', uid, 'timerLifecycle', 'current')),
    ]);
    assert.equal(
      [first, second].filter((book) => book.data()?.activeTimer !== null).length,
      1,
    );
    assert.ok(['first', 'second'].includes(lifecycle.data()?.bookId));
  });
});
