import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import type { RulesTestContext, RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
  collection,
  deleteField,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';

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

const queueItem = (overrides = {}) => ({
  type: 'create',
  bookTitle: 'The Book',
  start: '2026-08-24T12:00:00.000Z',
  stop: '2026-08-24T12:20:00.000Z',
  status: 'pending',
  createdAt: serverTimestamp(),
  ...overrides,
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
  const db = environment.authenticatedContext('queue-shape').firestore();
  const queue = collection(db, 'users', 'queue-shape', 'togglQueue');
  const cases = [
    queueItem({type: 'other'}),
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
  const docs = {
    error: queueItem({
      status: 'error',
      createdAt: oldCreate,
      attempts: 1,
      claimedAt: oldClaim,
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
  await environment.withSecurityRulesDisabled(async (context: RulesTestContext) => {
    await setDoc(
      doc(context.firestore(), 'users', 'queue-immutable', 'togglQueue', 'error'),
      queueItem({
        status: 'error',
        createdAt: oldClaim,
        attempts: 1,
        claimedAt: oldClaim,
        error: 'network failed',
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
    status: 'synced',
    retryRequestedAt: serverTimestamp(),
  }));
  await assertFails(updateDoc(ref, {status: 'pending'}));
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

test('function quota documents are inaccessible to their owner', async () => {
  const uid = 'quota-owner';
  const db = environment.authenticatedContext(uid).firestore();
  const ref = doc(db, 'users', uid, 'functionQuotas', 'booksApi');
  await assertFails(getDoc(ref));
  await assertFails(setDoc(ref, {windowStartedAt: Timestamp.now(), calls: 1}));
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
  const seedRemoteTimer = async () => environment.withSecurityRulesDisabled(
    async (context: RulesTestContext) => setDoc(
      doc(context.firestore(), 'users', uid, 'books', 'book'),
      {
        title: 'Book',
        activeTimer: {entryId: 42, start: '2026-08-24T12:00:00.000Z'},
      },
    ),
  );
  await seedRemoteTimer();

  const valid = writeBatch(db);
  valid.update(bookRef, {activeTimer: null});
  valid.set(doc(db, 'users', uid, 'togglQueue', 'valid'), queueItem({
    type: 'stop',
    entryId: 42,
  }));
  await assertSucceeds(valid.commit());
  assert.equal((await getDoc(bookRef)).data()?.activeTimer, null);

  await seedRemoteTimer();
  const invalid = writeBatch(db);
  invalid.update(bookRef, {activeTimer: null});
  invalid.set(doc(db, 'users', uid, 'togglQueue', 'invalid'), queueItem({
    type: 'stop',
    entryId: 42,
    bookTitle: 'x'.repeat(501),
  }));
  await assertFails(invalid.commit());
  assert.equal((await getDoc(bookRef)).data()?.activeTimer.entryId, 42);
});
