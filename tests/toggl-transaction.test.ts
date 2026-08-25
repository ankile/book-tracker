import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test, { after } from 'node:test';

process.env.GCLOUD_PROJECT = 'book-tracker-rules-test';

const functionsRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const { getFirestore, Timestamp } = functionsRequire('firebase-admin/firestore') as {
  getFirestore: () => import('firebase-admin/firestore').Firestore;
  Timestamp: typeof import('firebase-admin/firestore').Timestamp;
};
const deployed = functionsRequire('./lib') as {
  toggl: {
    start: {
      run: (
        data: { bookId: string },
        context: { auth: { uid: string; token: Record<string, unknown> } },
      ) => Promise<{ entryId: number; start: string }>;
    };
    syncqueue: {
      run: (event: unknown) => Promise<void>;
    };
    clearstopping: {
      run: (
        data: { bookId: string },
        context: { auth: { uid: string; token: Record<string, unknown> } },
      ) => Promise<{ cleared: true }>;
    };
  };
};
const { markCorrelatedStopFailure } = functionsRequire('./lib/toggl-recovery') as {
  markCorrelatedStopFailure: (
    queueRef: import('firebase-admin/firestore').DocumentReference,
    token: { attempts: number; claimedAt: import('firebase-admin/firestore').Timestamp },
    entryId: number,
    message: string,
  ) => Promise<boolean>;
};

const db = getFirestore();
const uid = `toggl-transaction-${Date.now()}`;
const userRef = db.doc(`users/${uid}`);
const lifecycleRef = userRef.collection('timerLifecycle').doc('current');

after(() => db.recursiveDelete(userRef));

test('Firestore serializes simultaneous starts on different books', async (t) => {
  await userRef.set({
    uid,
    email: 'timer@example.com',
    toggl: {apiToken: 'token', workspaceId: 3, projectId: 4},
  });
  const books = userRef.collection('books');
  await Promise.all([
    books.doc('first').set({title: 'First', activeTimer: null}),
    books.doc('second').set({title: 'Second', activeTimer: null}),
    books.doc('unrelated-corrupt').set({title: 42, activeTimer: {broken: true}}),
    lifecycleRef.set({version: 1, state: 'idle', cleared: null}),
  ]);

  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({
      id: 100 + fetchCalls,
      start: '2026-08-24T12:00:00.000Z',
    }), {status: 200});
  });

  const context = {auth: {uid, token: {}}};
  const results = await Promise.allSettled([
    deployed.toggl.start.run({bookId: 'first'}, context),
    deployed.toggl.start.run({bookId: 'second'}, context),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  const reason: unknown = rejected.reason;
  assert.ok(reason instanceof Error && 'code' in reason);
  assert.equal(reason.code, 'failed-precondition');
  assert.equal(fetchCalls, 1);

  const [first, second] = await Promise.all([
    books.doc('first').get(),
    books.doc('second').get(),
  ]);
  assert.equal(
    [first, second].filter((book) => book.data()?.activeTimer !== null).length,
    1,
  );
});

test('missing or malformed lifecycle state fails before a Toggl request', async (t) => {
  const brokenUid = `${uid}-broken`;
  const brokenUser = db.doc(`users/${brokenUid}`);
  const bookRef = brokenUser.collection('books').doc('book');
  await brokenUser.set({
    uid: brokenUid,
    email: 'broken@example.test',
    toggl: {apiToken: 'token', workspaceId: 3, projectId: 4},
  });
  await bookRef.set({title: 'Book', activeTimer: null});
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1;
    return new Response('{}', {status: 200});
  });
  const context = {auth: {uid: brokenUid, token: {}}};
  await assert.rejects(
    deployed.toggl.start.run({bookId: 'book'}, context),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'failed-precondition',
  );
  assert.equal(fetchCalls, 0);

  await brokenUser.collection('timerLifecycle').doc('current').set({
    version: 1, state: 'remote', bookId: 'book', entryId: 'broken',
    start: '2026-08-24T12:00:00.000Z',
  });
  await assert.rejects(
    deployed.toggl.start.run({bookId: 'book'}, context),
    /entry id/,
  );
  assert.equal(fetchCalls, 0);
  await db.recursiveDelete(brokenUser);
});

test('one remaining queue slot defers and later recovers the other claim', async (t) => {
  await userRef.set({
    uid,
    email: 'timer@example.com',
    toggl: {apiToken: 'token', workspaceId: 3, projectId: 4},
  }, {merge: true});
  const quotaRef = userRef.collection('functionQuotas').doc('togglQueue');
  await quotaRef.set({windowStartedAt: new Date(), count: 9});
  const queue = userRef.collection('togglQueue');
  const item = (title: string) => ({
    type: 'create',
    bookTitle: title,
    start: '2026-08-24T12:00:00.000Z',
    stop: '2026-08-24T12:20:00.000Z',
    status: 'pending',
    createdAt: new Date(),
  });
  await Promise.all([
    queue.doc('first').set(item('First')),
    queue.doc('second').set(item('Second')),
  ]);
  const [first, second] = await Promise.all([
    queue.doc('first').get(),
    queue.doc('second').get(),
  ]);

  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({id: 200 + fetchCalls}), {status: 200});
  });
  const firstResults = await Promise.allSettled([
    deployed.toggl.syncqueue.run({
      data: {after: first},
      params: {uid, queueId: 'first'},
    }),
    deployed.toggl.syncqueue.run({
      data: {after: second},
      params: {uid, queueId: 'second'},
    }),
  ]);

  assert.equal(firstResults.filter((result) => result.status === 'fulfilled').length, 1);
  const deferred = firstResults.find((result) => result.status === 'rejected');
  assert.ok(deferred && deferred.status === 'rejected');
  assert.match(String(deferred.reason), /Eventarc will retry/);
  assert.equal(fetchCalls, 1);
  assert.equal((await quotaRef.get()).data()?.count, 10);
  let remaining = await queue.get();
  assert.equal(remaining.size, 1);
  assert.equal(remaining.docs[0].data().status, 'pending');
  assert.equal(remaining.docs[0].data().attempts, undefined);

  await quotaRef.set({
    windowStartedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    count: 10,
  });
  const retried = await remaining.docs[0].ref.get();
  await Promise.all([
    deployed.toggl.syncqueue.run({
      data: {after: retried},
      params: {uid, queueId: retried.id},
    }),
    deployed.toggl.syncqueue.run({
      data: {after: retried},
      params: {uid, queueId: retried.id},
    }),
  ]);

  assert.equal(fetchCalls, 2);
  assert.equal((await quotaRef.get()).data()?.count, 1);
  remaining = await queue.get();
  assert.equal(remaining.empty, true);
});

test('a correlated queued stop clears its exact book and lifecycle atomically', async (t) => {
  const bookId = 'queued-stop';
  const start = '2026-08-24T15:30:00.000Z';
  const queueId = `${bookId}_${start}`;
  const timer = {state: 'stopping', entryId: 401, start, queueId};
  const bookRef = userRef.collection('books').doc(bookId);
  const queueRef = userRef.collection('togglQueue').doc(queueId);
  await Promise.all([
    bookRef.set({title: 'Queued stop', activeTimer: timer}),
    lifecycleRef.set({version: 1, bookId, ...timer}),
    queueRef.set({
      type: 'stop', bookId, timerClaimVersion: 1, bookTitle: 'Queued stop',
      entryId: 401, start, stop: '2026-08-24T15:50:00.000Z',
      status: 'pending', createdAt: Timestamp.now(),
    }),
  ]);
  t.mock.method(globalThis, 'fetch', async () => new Response('', {status: 200}));
  const after = await queueRef.get();
  await deployed.toggl.syncqueue.run({
    data: {after},
    params: {uid, queueId},
  });
  assert.equal((await bookRef.get()).data()?.activeTimer, null);
  assert.equal((await lifecycleRef.get()).data()?.state, 'idle');
  assert.equal((await queueRef.get()).exists, false);
});

test('a stale queue worker cannot clear a newer timer lifecycle', async (t) => {
  const bookId = 'stale-queued-stop';
  const start = '2026-08-24T15:45:00.000Z';
  const queueId = `${bookId}_${start}`;
  const timer = {state: 'stopping', entryId: 451, start, queueId};
  const bookRef = userRef.collection('books').doc(bookId);
  const queueRef = userRef.collection('togglQueue').doc(queueId);
  await Promise.all([
    bookRef.set({title: 'Queued stop', activeTimer: timer}),
    lifecycleRef.set({version: 1, state: 'remote', bookId, entryId: 999, start}),
    queueRef.set({
      type: 'stop', bookId, timerClaimVersion: 1, bookTitle: 'Queued stop',
      entryId: 451, start, stop: '2026-08-24T16:05:00.000Z',
      status: 'pending', createdAt: Timestamp.now(),
    }),
  ]);
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1;
    return new Response('', {status: 200});
  });
  const after = await queueRef.get();
  await assert.rejects(deployed.toggl.syncqueue.run({
    data: {after},
    params: {uid, queueId},
  }), /no longer matches/);
  assert.equal((await bookRef.get()).data()?.activeTimer.state, 'stopping');
  assert.equal((await lifecycleRef.get()).data()?.entryId, 999);
  const failedQueue = (await queueRef.get()).data();
  assert.equal(failedQueue?.status, 'error');
  assert.equal(failedQueue?.entryId, 451);
  assert.match(failedQueue?.error, /no longer matches/);
  await deployed.toggl.syncqueue.run({
    data: {after},
    params: {uid, queueId},
  });
  assert.equal(fetchCalls, 1);
});

test('post-PUT recovery never downgrades a synced row or a newer worker claim', async () => {
  const queueRef = userRef.collection('togglQueue').doc('post-put-claim-token');
  const claimedAt = Timestamp.now();
  const token = {attempts: 1, claimedAt};
  await queueRef.set({status: 'synced', attempts: 1, claimedAt, entryId: 700});
  assert.equal(
    await markCorrelatedStopFailure(queueRef, token, 700, 'lost acknowledgement'),
    false,
  );
  assert.equal((await queueRef.get()).data()?.status, 'synced');

  const newerClaimedAt = Timestamp.fromMillis(claimedAt.toMillis() + 1);
  await queueRef.set({status: 'processing', attempts: 2, claimedAt: newerClaimedAt});
  assert.equal(
    await markCorrelatedStopFailure(queueRef, token, 700, 'stale worker'),
    false,
  );
  const newer = (await queueRef.get()).data();
  assert.equal(newer?.status, 'processing');
  assert.equal(newer?.attempts, 2);
  assert.equal(newer?.claimedAt.isEqual(newerClaimedAt), true);
});

test('checked recovery clears capped failures but refuses live processing work', async () => {
  const bookId = 'recover-stopping';
  const queueId = `${bookId}_2026-08-24T16:00:00.000Z`;
  const start = '2026-08-24T16:00:00.000Z';
  const timer = {state: 'stopping', entryId: 501, start, queueId};
  const claim = {version: 1, bookId, ...timer};
  const bookRef = userRef.collection('books').doc(bookId);
  const queueRef = userRef.collection('togglQueue').doc(queueId);
  const context = {auth: {uid, token: {}}};
  const queue = (
    status: 'error' | 'processing',
    claimedAt: import('firebase-admin/firestore').Timestamp,
    attempts = 5,
  ) => ({
    type: 'stop', bookId, timerClaimVersion: 1, bookTitle: 'Book',
    entryId: 501, start, stop: '2026-08-24T16:20:00.000Z',
    status, createdAt: claimedAt, attempts, claimedAt,
    ...(status === 'error' ? {error: 'retry cap reached'} : {}),
  });
  const seed = async (
    status: 'error' | 'processing',
    claimedAt: import('firebase-admin/firestore').Timestamp,
    attempts = 5,
  ) => {
    await Promise.all([
      bookRef.set({title: 'Book', activeTimer: timer}),
      lifecycleRef.set(claim),
      queueRef.set(queue(status, claimedAt, attempts)),
    ]);
  };

  await seed('error', Timestamp.now(), 1);
  assert.deepEqual(
    await deployed.toggl.clearstopping.run({bookId}, context),
    {cleared: true},
  );
  assert.equal((await bookRef.get()).data()?.activeTimer, null);
  assert.equal((await lifecycleRef.get()).data()?.state, 'idle');
  assert.equal((await queueRef.get()).exists, false);

  await seed('processing', Timestamp.now());
  await assert.rejects(
    deployed.toggl.clearstopping.run({bookId}, context),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'failed-precondition',
  );
  assert.equal((await bookRef.get()).data()?.activeTimer.state, 'stopping');

  await queueRef.set(queue(
    'processing',
    Timestamp.fromMillis(Date.now() - 7 * 60 * 60 * 1000),
  ));
  assert.deepEqual(
    await deployed.toggl.clearstopping.run({bookId}, context),
    {cleared: true},
  );
});

test('checked recovery cannot clear a stopping book with a newer claim', async () => {
  const bookId = 'stale-recovery';
  const start = '2026-08-24T17:00:00.000Z';
  const queueId = `${bookId}_${start}`;
  const timer = {state: 'stopping', entryId: 601, start, queueId};
  await Promise.all([
    userRef.collection('books').doc(bookId).set({title: 'Book', activeTimer: timer}),
    lifecycleRef.set({
      version: 1, state: 'remote', bookId, entryId: 602, start,
    }),
    userRef.collection('togglQueue').doc(queueId).set({
      type: 'stop', bookId, timerClaimVersion: 1, bookTitle: 'Book',
      entryId: 601, start, stop: '2026-08-24T17:20:00.000Z',
      status: 'error', createdAt: Timestamp.now(), attempts: 5,
      claimedAt: Timestamp.now(), error: 'retry cap reached',
    }),
  ]);
  await assert.rejects(
    deployed.toggl.clearstopping.run({bookId}, {auth: {uid, token: {}}}),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'failed-precondition',
  );
  assert.equal(
    (await userRef.collection('books').doc(bookId).get()).data()?.activeTimer.state,
    'stopping',
  );
});
