import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { deleteApp, initializeApp } from 'firebase/app';
import { doc, getFirestore, Timestamp } from 'firebase/firestore';

import {
  decodeAuthor,
  decodeBook,
  decodeBookUpdate,
  decodeProfile,
  decodeQueueSweepItem,
  decodeUser,
} from '../src/lib/firebase/decoders.ts';

const app = initializeApp({ projectId: 'decoder-tests' }, 'decoder-tests');
const db = getFirestore(app);
const owner = doc(db, 'users', 'owner');
const bookRef = doc(db, 'users', 'owner', 'books', 'book');
const createdAt = Timestamp.fromMillis(1_700_000_000_000);
const updatedAt = Timestamp.fromMillis(1_700_000_100_000);

after(() => deleteApp(app));

const bookData = (activeTimer: unknown = null) => ({
  authorIds: ['author'],
  currentPage: 20,
  pageCount: 200,
  pagesRead: 20,
  timeRead: 40,
  title: 'Typed Boundaries',
  finished: false,
  isbn: '',
  owner,
  createdAt,
  updatedAt,
  activeTimer,
  coverUrl: '',
  publisher: '',
  publishedDate: '',
  subjects: [],
  fiction: null,
});

test('book decoder distinguishes current and documented legacy authorship', () => {
  const { authorIds: _authorIds, ...shared } = bookData();
  const legacyString = decodeBook('legacy-string', {
    ...shared,
    author: 'Legacy Author',
  }, 'users/owner/books/legacy-string');
  assert.equal(legacyString.author, 'Legacy Author');
  const legacyEmbedded = decodeBook('legacy-embedded', {
    ...shared,
    authors: [{id: 'legacy', name: 'Legacy Author'}],
  }, 'users/owner/books/legacy-embedded');
  assert.deepEqual(legacyEmbedded.authors, [{id: 'legacy', name: 'Legacy Author'}]);
  assert.throws(
    () => decodeBook('missing-author', shared, 'users/owner/books/missing-author'),
    /authorIds or a documented legacy author field/,
  );
});

test('author and user decoders reject malformed nested data', () => {
  const merged = decodeAuthor('old', {
    name: 'Old Author',
    nameLower: 'old author',
    kind: 'person',
    givenName: 'Old',
    familyName: 'Author',
    retirement: {reason: 'merged', targetId: 'new'},
  }, 'users/owner/authors/old');
  assert.deepEqual(merged.retirement, {reason: 'merged', targetId: 'new'});
  assert.throws(
    () => decodeAuthor('bad', {
      name: 'Bad Author',
      nameLower: 'bad author',
      kind: 'person',
      givenName: 'Wrong',
      familyName: 'Parts',
    }, 'users/owner/authors/bad'),
    /matching its explicit name parts/,
  );
  assert.throws(
    () => decodeUser({
      uid: 'owner',
      email: 'owner@example.com',
      toggl: {apiToken: 'token', workspaceId: 1.5, projectId: 2},
    }, 'users/owner'),
    /workspaceId.*integer/,
  );
});

test('profile decoder validates exact nested public payloads', () => {
  const profile = {
    uid: 'owner',
    public: true,
    givenName: 'Ada',
    familyName: 'Lovelace',
    links: [{type: 'github', value: 'ada'}],
    stats: {
      totalBooks: 1,
      finishedBooks: 1,
      readingBooks: 0,
      totalTimeReadHours: 2,
      totalPagesRead: 100,
      booksPerYear: 1,
      avgTimePerBook: 120,
      authors: 1,
    },
    records: {
      momentum: null,
      superlatives: {
        biggestDay: null,
        longestSession: null,
        medianSessionMinutes: 30,
        fastestFinish: null,
      },
    },
    years: [{year: 2026, count: 1, hours: 2, pages: 100}],
    days: [{day: '2026-08-24', pagesRead: 100, timeRead: 120, sessions: 1}],
    updatedAt,
  };
  assert.equal(decodeProfile('ada', profile, 'profiles/ada').username, 'ada');
  assert.throws(
    () => decodeProfile('ada', {
      ...profile,
      links: [{type: 'github', value: 'ada', secret: true}],
    }, 'profiles/ada'),
    /only keys/,
  );
  assert.throws(
    () => decodeProfile('ada', {
      ...profile,
      years: [{year: 2026, count: 'one', hours: 2, pages: 100}],
    }, 'profiles/ada'),
    /count.*finite number/,
  );
});

test('book decoder accepts every explicit activeTimer lifecycle state', () => {
  const starting = decodeBook('book', bookData({
    state: 'starting',
    operationId: 'operation',
    start: '2026-08-24T12:00:00.000Z',
    claimedAt: createdAt,
  }), 'users/owner/books/book');
  assert.deepEqual(starting.activeTimer, {
    state: 'starting',
    operationId: 'operation',
    start: '2026-08-24T12:00:00.000Z',
    claimedAt: createdAt,
  });

  const uncertain = decodeBook('book', bookData({
    state: 'outcome-unknown',
    operationId: 'operation',
    start: '2026-08-24T12:00:00.000Z',
    claimedAt: createdAt,
    error: 'Check Toggl.',
  }), 'users/owner/books/book');
  assert.equal(
    uncertain.activeTimer !== null && 'state' in uncertain.activeTimer
      ? uncertain.activeTimer.state
      : null,
    'outcome-unknown',
  );
});

test('book decoder rejects malformed timer lifecycle data', () => {
  assert.throws(
    () => decodeBook('book', bookData({
      state: 'starting',
      operationId: '',
      start: '2026-08-24T12:00:00.000Z',
      claimedAt: createdAt,
    }), 'users/owner/books/book'),
    /operationId/,
  );
  assert.throws(
    () => decodeBook('book', bookData({
      state: 'starting',
      operationId: 'operation',
      start: '2026-08-24T12:00:00.000Z',
      claimedAt: createdAt,
      entryId: 42,
    }), 'users/owner/books/book'),
    /only keys/,
  );
});

const queueData = (overrides: Record<string, unknown> = {}) => ({
  type: 'create',
  bookTitle: 'Typed Boundaries',
  start: '2026-08-24T12:00:00.000Z',
  stop: '2026-08-24T12:20:00.000Z',
  status: 'pending',
  createdAt,
  ...overrides,
});

test('queue decoder accepts changed retries and terminal uncertain creates', () => {
  const expiresAt = Timestamp.fromMillis(Date.now() + 90 * 24 * 60 * 60 * 1000);
  const retried = decodeQueueSweepItem('retry', queueData({
    retryRequestedAt: updatedAt,
    attempts: 1,
    claimedAt: createdAt,
    expiresAt,
    error: 'transient',
  }), 'users/owner/togglQueue/retry');
  assert.equal(retried.retryRequestedAt, updatedAt);

  const uncertain = decodeQueueSweepItem('uncertain', queueData({
    status: 'outcome-unknown',
    attempts: 1,
    claimedAt: createdAt,
    error: 'POST outcome unknown',
  }), 'users/owner/togglQueue/uncertain');
  assert.equal(uncertain.status, 'outcome-unknown');
  assert.throws(
    () => decodeQueueSweepItem('bad-expiry', queueData({
      retryRequestedAt: updatedAt,
      attempts: 1,
      claimedAt: createdAt,
      expiresAt: 'later',
      error: 'transient',
    }), 'users/owner/togglQueue/bad-expiry'),
    /expiresAt.*Firestore Timestamp/,
  );
});

test('queue decoder accepts correlated book ids and rejects invalid document ids', () => {
  const correlated = decodeQueueSweepItem('correlated', queueData({
    bookId: 'book-123',
  }), 'users/owner/togglQueue/correlated');
  assert.equal(correlated.bookId, 'book-123');
  assert.throws(
    () => decodeQueueSweepItem('invalid-book', queueData({
      bookId: 'books/123',
    }), 'users/owner/togglQueue/invalid-book'),
    /one Firestore document id/,
  );
});

test('queue decoder rejects outcome-unknown stop operations', () => {
  assert.throws(
    () => decodeQueueSweepItem('stop', queueData({
      type: 'stop',
      entryId: 42,
      status: 'outcome-unknown',
      attempts: 1,
      claimedAt: createdAt,
      error: 'invalid lifecycle',
    }), 'users/owner/togglQueue/stop'),
    /only for a create operation/,
  );
});

test('queue decoder rejects malformed lifecycle metadata', () => {
  assert.throws(
    () => decodeQueueSweepItem('negative', queueData({
      status: 'processing',
      attempts: -1,
      claimedAt: createdAt,
    }), 'users/owner/togglQueue/negative'),
    /non-negative/,
  );
  assert.throws(
    () => decodeQueueSweepItem('unclaimed', queueData({
      status: 'processing',
      attempts: 1,
    }), 'users/owner/togglQueue/unclaimed'),
    /claim metadata/,
  );
  assert.throws(
    () => decodeQueueSweepItem('invalid-time', queueData({
      start: 'today',
    }), 'users/owner/togglQueue/invalid-time'),
    /ISO timestamp/,
  );
});

test('update decoder enforces the pagesRead arithmetic invariant', () => {
  assert.throws(
    () => decodeBookUpdate('update', {
      owner,
      book: bookRef,
      type: 'reading',
      timeRead: 20,
      fromPage: 10,
      toPage: 20,
      pagesRead: 11,
      createdAt,
      updatedAt,
    }, 'users/owner/books/book/updates/update'),
    /toPage - fromPage/,
  );
});
