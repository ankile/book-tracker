import test, { after, before } from 'node:test';
import { readFile } from 'node:fs/promises';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';

let environment;

const profile = (uid, overrides = {}) => ({
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

test('public profiles are readable but private profiles are not', async () => {
  await environment.withSecurityRulesDisabled(async (context) => {
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
  withTitle.records.superlatives.longestSession.title = 'Private book';
  await assertFails(setDoc(doc(db, 'profiles', 'leaky-record'), withTitle));

  const extraStat = profile('owner');
  extraStat.stats.favoriteBook = 1;
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
