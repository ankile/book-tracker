import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { deleteApp, initializeApp } from 'firebase/app';
import { doc, getFirestore, Timestamp } from 'firebase/firestore';

import {
  decodeAuthor,
  decodeBook,
  decodeBookUpdate,
  decodeLiveQueueSweepItem,
  decodeProfile,
  decodeProfileDiscovery,
  decodeProfileView,
  profileView,
  decodeQueueSweepBatch,
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

test('book decoder normalizes legacy progress-source state and validates new ids', () => {
  assert.equal(
    decodeBook('legacy', bookData(), 'users/owner/books/legacy').currentPageUpdateId,
    null,
  );
  assert.equal(
    decodeBook('null', {
      ...bookData(),
      currentPageUpdateId: null,
    }, 'users/owner/books/null').currentPageUpdateId,
    null,
  );
  assert.equal(
    decodeBook('current', {
      ...bookData(),
      currentPageUpdateId: 'reading-session',
    }, 'users/owner/books/current').currentPageUpdateId,
    'reading-session',
  );
  assert.throws(
    () => decodeBook('empty', {
      ...bookData(),
      currentPageUpdateId: '',
    }, 'users/owner/books/empty'),
    /currentPageUpdateId.*non-empty string/,
  );
  assert.throws(
    () => decodeBook('invalid', {
      ...bookData(),
      currentPageUpdateId: 42,
    }, 'users/owner/books/invalid'),
    /currentPageUpdateId.*string/,
  );
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

test('profile view decoder accepts the publicweb JSON projection and nothing more', () => {
  const view = {
    username: 'ada',
    givenName: 'Ada',
    familyName: 'Lovelace',
    links: [{ type: 'github', value: 'ada' }],
    stats: {
      totalBooks: 1, finishedBooks: 1, readingBooks: 0, totalTimeReadHours: 2,
      totalPagesRead: 100, booksPerYear: 1, avgTimePerBook: 120, authors: 1,
    },
    records: {
      momentum: { recentPagesPerDay: 10, lifetimePagesPerDay: 5, ratio: 2 },
      superlatives: {
        biggestDay: { day: '2026-08-24', pages: 100 },
        longestSession: { minutes: 120 },
        medianSessionMinutes: 60,
        fastestFinish: null,
      },
    },
    years: [{ year: 2026, count: 1, hours: 2, pages: 100 }],
    days: [{ day: '2026-08-24', pagesRead: 100, timeRead: 120, sessions: 1 }],
    updatedAt: '2026-08-24T12:00:00.000Z',
  };
  const decoded = decodeProfileView(view, 'profiles/ada.json');
  assert.equal(decoded.username, 'ada');
  assert.equal(decoded.public, true);
  assert.equal(decoded.updatedAt, '2026-08-24T12:00:00.000Z');
  assert.deepEqual(decoded.records, view.records);
  // The projection never carries the owner's uid; a payload that does is
  // not the endpoint this decoder is for.
  assert.throws(
    () => decodeProfileView({ ...view, uid: 'owner' }, 'profiles/ada.json'),
    /only keys/,
  );
  assert.throws(
    () => decodeProfileView({ ...view, updatedAt: 'yesterday' }, 'profiles/ada.json'),
    /ISO timestamp/,
  );
  assert.throws(
    () => decodeProfileView({ ...view, days: [{ day: '2026-08-24', pagesRead: 'many', timeRead: 1, sessions: 1 }] }, 'profiles/ada.json'),
    /pagesRead.*finite number/,
  );
});

test('an owner-read Firestore profile projects onto the same view shape', () => {
  const stored = {
    uid: 'owner',
    public: false,
    givenName: 'Ada',
    familyName: 'Lovelace',
    links: [],
    stats: {
      totalBooks: 1, finishedBooks: 1, readingBooks: 0, totalTimeReadHours: 2,
      totalPagesRead: 100, booksPerYear: 1, avgTimePerBook: 120, authors: 1,
    },
    records: null,
    years: [],
    days: [],
    updatedAt,
  };
  const view = profileView(decodeProfile('ada', stored, 'profiles/ada'));
  assert.equal('uid' in view, false);
  assert.equal(view.public, false);
  assert.equal(view.updatedAt, updatedAt.toDate().toISOString());
  // Minus the visibility flag, the owner projection is exactly the wire shape.
  const wire = Object.fromEntries(Object.entries(view).filter(([key]) => key !== 'public'));
  assert.deepEqual(decodeProfileView(wire, 'profiles/ada.json'), { ...view, public: true });
});

test('profile discovery decoder accepts only the owner marker shape', () => {
  assert.deepEqual(
    decodeProfileDiscovery(
      { uid: 'owner', createdAt: updatedAt },
      'profileDiscovery/ada',
    ),
    { uid: 'owner', createdAt: updatedAt },
  );
  assert.throws(
    () => decodeProfileDiscovery(
      { uid: 'owner', createdAt: updatedAt, searchable: true },
      'profileDiscovery/ada',
    ),
    /only keys/,
  );
  assert.throws(
    () => decodeProfileDiscovery(
      { uid: '', createdAt: updatedAt },
      'profileDiscovery/ada',
    ),
    /non-empty string/,
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

  const stopping = decodeBook('book', bookData({
    state: 'stopping',
    entryId: 42,
    start: '2026-08-24T12:00:00.000Z',
    queueId: 'book_2026-08-24T12:00:00.000Z',
  }), 'users/owner/books/book');
  assert.deepEqual(stopping.activeTimer, {
    state: 'stopping',
    entryId: 42,
    start: '2026-08-24T12:00:00.000Z',
    queueId: 'book_2026-08-24T12:00:00.000Z',
  });
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
  assert.throws(
    () => decodeBook('book', bookData({
      start: '2026-08-24T12:00:00.000Z',
      operationId: 'x'.repeat(101),
    }), 'users/owner/books/book'),
    /operationId/,
  );
  assert.throws(
    () => decodeBook('book', bookData({
      state: 'stopping',
      entryId: 42,
      start: '2026-08-24T12:00:00.000Z',
      queueId: 'x'.repeat(601),
    }), 'users/owner/books/book'),
    /queueId/,
  );
  for (const start of [
    '2026-02-30T12:00:00.000Z',
    '2025-02-29T12:00:00Z',
    '2026-04-31T12:00:00Z',
    '2026-01-01T24:00:00Z',
  ]) {
    assert.throws(
      () => decodeBook('book', bookData({start}), 'users/owner/books/book'),
      /ISO timestamp/,
    );
  }
  const precise = '2024-02-29T23:59:59.123456789+05:30';
  assert.deepEqual(
    decodeBook('book', bookData({start: precise}), 'users/owner/books/book').activeTimer,
    {start: precise},
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
  assert.equal(uncertain.deferredUntil, null);
  // A server-deferred pending row carries the end of its quota window; the
  // claim clears it, so any other status with the stamp is corrupt.
  const deferredUntil = Timestamp.fromMillis(Date.now() + 60 * 60 * 1000);
  const deferred = decodeQueueSweepItem('deferred', queueData({
    deferredUntil,
    expiresAt,
  }), 'users/owner/togglQueue/deferred');
  assert.equal(deferred.deferredUntil, deferredUntil);
  assert.throws(
    () => decodeQueueSweepItem('deferred-error', queueData({
      status: 'error',
      attempts: 1,
      claimedAt: createdAt,
      error: 'transient',
      deferredUntil,
    }), 'users/owner/togglQueue/deferred-error'),
    /a deferral only on a pending queue item/,
  );
  assert.throws(
    () => decodeQueueSweepItem('deferred-bad', queueData({
      deferredUntil: 'soon',
    }), 'users/owner/togglQueue/deferred-bad'),
    /deferredUntil.*Firestore Timestamp/,
  );
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

test('queue decoder accepts pre-migration retry metadata and oversized errors', () => {
  const legacyPending = decodeQueueSweepItem('legacy-pending', queueData({
    attempts: 1,
    claimedAt: createdAt,
    error: 'legacy failure',
  }), 'users/owner/togglQueue/legacy-pending');
  assert.equal(legacyPending.retryRequestedAt, null);

  const oversized = 'x'.repeat(2_000);
  const legacyError = decodeQueueSweepItem('legacy-error', queueData({
    status: 'error',
    attempts: 1,
    claimedAt: createdAt,
    error: oversized,
  }), 'users/owner/togglQueue/legacy-error');
  assert.equal(legacyError.error, oversized.slice(0, 1000));

  const staleProcessing = decodeQueueSweepItem('legacy-processing', queueData({
    status: 'processing',
    attempts: 1,
    claimedAt: createdAt,
    error: 'retained by an old claim',
  }), 'users/owner/togglQueue/legacy-processing');
  assert.equal(staleProcessing.status, 'processing');
});

test('queue batch decoding isolates a malformed row from repairable rows', () => {
  const decoded = decodeQueueSweepBatch([
    {id: 'healthy', value: queueData(), path: 'users/owner/togglQueue/healthy'},
    {
      id: 'malformed',
      value: queueData({type: 'invalid'}),
      path: 'users/owner/togglQueue/malformed',
    },
    {
      id: 'legacy',
      value: queueData({attempts: 1, claimedAt: createdAt}),
      path: 'users/owner/togglQueue/legacy',
    },
  ]);
  assert.deepEqual(decoded.items.map((item) => item.id), ['healthy', 'legacy']);
  assert.deepEqual(decoded.invalidIds, ['malformed']);
});

test('live queue decoding skips terminal races and fresh corruption', () => {
  assert.equal(decodeLiveQueueSweepItem('synced', queueData({
    status: 'synced',
    attempts: 1,
    claimedAt: createdAt,
    entryId: 42,
  }), 'users/owner/togglQueue/synced'), null);
  assert.equal(decodeLiveQueueSweepItem(
    'malformed',
    queueData({type: 'invalid'}),
    'users/owner/togglQueue/malformed',
  ), null);
  assert.equal(decodeLiveQueueSweepItem(
    'healthy',
    queueData(),
    'users/owner/togglQueue/healthy',
  )?.id, 'healthy');
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
  const correction = decodeBookUpdate('page-count-clamp', {
    owner,
    book: bookRef,
    type: 'update',
    fromPage: 350,
    toPage: 320,
    pagesRead: -30,
    createdAt,
    updatedAt,
  }, 'users/owner/books/book/updates/page-count-clamp');
  assert.equal(correction.pagesRead, -30);
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
