import './setup.ts';

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test, { after } from 'node:test';

const functionsRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const { getFirestore, Timestamp } = functionsRequire('firebase-admin/firestore') as {
  getFirestore: () => import('firebase-admin/firestore').Firestore;
  Timestamp: typeof import('firebase-admin/firestore').Timestamp;
};
const deployed = functionsRequire('./lib') as {
  toggl: {
    savetoken: {
      run: (
        data: { token: string },
        context: { auth: { uid: string; token: Record<string, unknown> } },
      ) => Promise<{ workspaceId: number; projectId: number }>;
    };
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

const { logger } = functionsRequire('firebase-functions') as {
  logger: { warn: (...args: unknown[]) => void };
};
const {
  TOGGL_QUEUE_LIMIT,
  TOGGL_QUEUE_MAX_DEFERRALS,
  TOGGL_QUEUE_RETENTION_MS,
  TOGGL_QUEUE_ROW_LIMIT,
  TOGGL_QUEUE_WINDOW_MS,
  TOGGL_TOKEN_LIMIT,
} = functionsRequire('./lib/togglQueueLimits') as {
  TOGGL_QUEUE_LIMIT: number;
  TOGGL_QUEUE_MAX_DEFERRALS: number;
  TOGGL_QUEUE_RETENTION_MS: number;
  TOGGL_QUEUE_ROW_LIMIT: number;
  TOGGL_QUEUE_WINDOW_MS: number;
  TOGGL_TOKEN_LIMIT: number;
};

type AdminTimestamp = import('firebase-admin/firestore').Timestamp;

const db = getFirestore();
const uid = `toggl-transaction-${Date.now()}`;
const userRef = db.doc(`users/${uid}`);
const lifecycleRef = userRef.collection('timerLifecycle').doc('current');

after(() => db.recursiveDelete(userRef));

test('savetoken admits a verified account five times an hour and refuses the sixth before Toggl is called', async (t) => {
  const warnings = captureWarnings(t);
  await userRef.set({uid, email: 'timer@example.com'}, {merge: true});
  const quotaRef = userRef.collection('functionQuotas').doc('togglToken');
  await quotaRef.delete();
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    fetchCalls += 1;
    if (String(url).endsWith('/me')) return new Response('{}', {status: 200});
    return new Response(JSON.stringify([{id: 7, workspace_id: 6, name: 'Reading'}]), {status: 200});
  });
  const verified = {auth: {uid, token: {email_verified: true}}};
  const unverified = {auth: {uid, token: {}}};

  await assert.rejects(
    deployed.toggl.savetoken.run({token: 'secret'}, unverified),
    (error: unknown) => (error as {code: string}).code === 'failed-precondition',
  );
  assert.equal(fetchCalls, 0);
  assert.equal((await quotaRef.get()).exists, false);

  for (let attempt = 1; attempt <= TOGGL_TOKEN_LIMIT; attempt += 1) {
    assert.deepEqual(
      await deployed.toggl.savetoken.run({token: 'secret'}, verified),
      {workspaceId: 6, projectId: 7},
    );
  }
  assert.equal(fetchCalls, 2 * TOGGL_TOKEN_LIMIT);
  const stored = (await userRef.get()).data()?.toggl;
  assert.deepEqual(stored, {apiToken: 'secret', workspaceId: 6, projectId: 7});

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(
      deployed.toggl.savetoken.run({token: 'secret'}, verified),
      (error: unknown) => (error as {code: string}).code === 'resource-exhausted',
    );
  }
  assert.equal(fetchCalls, 2 * TOGGL_TOKEN_LIMIT);
  assert.equal((await quotaRef.get()).data()?.count, TOGGL_TOKEN_LIMIT + 1);
  assert.deepEqual(warnings, [['toggl.token_quota_exceeded', {uid}]]);

  await quotaRef.set({
    windowStartedAt: new Date(Date.now() - TOGGL_QUEUE_WINDOW_MS - 1000),
    count: TOGGL_TOKEN_LIMIT + 1,
  });
  await deployed.toggl.savetoken.run({token: 'secret'}, verified);
  assert.equal((await quotaRef.get()).data()?.count, 1);
  await userRef.update({toggl: {apiToken: 'token', workspaceId: 3, projectId: 4}});
});

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

function captureWarnings(t: { mock: { method: (obj: object, name: 'warn', fn: (...args: unknown[]) => void) => unknown } }): unknown[][] {
  const warnings: unknown[][] = [];
  t.mock.method(logger, 'warn', (...args: unknown[]) => {
    warnings.push(args);
  });
  return warnings;
}

const freshCreate = (title: string, createdAt = new Date()) => ({
  type: 'create',
  bookTitle: title,
  start: '2026-08-24T12:00:00.000Z',
  stop: '2026-08-24T12:20:00.000Z',
  status: 'pending',
  createdAt,
});

const runQueue = (snap: import('firebase-admin/firestore').DocumentSnapshot) =>
  deployed.toggl.syncqueue.run({data: {after: snap}, params: {uid, queueId: snap.id}});

// Concurrent deliveries for one user contend on the shared counters. In
// production a lost transaction is ABORTED (retried by the SDK) or, past the
// retry budget, a thrown handler that Eventarc redelivers; the emulator's
// pessimistic locks also surface it as INVALID_ARGUMENT "Transaction is
// invalid or closed". This models the redelivery: the same event payload
// again, which the handler must treat idempotently (the stale-redelivery
// test below pins that). Any other error is a real failure.
const isContention = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error &&
  ((error as {code: unknown}).code === 10 ||
    ((error as {code: unknown}).code === 3 && /Transaction is invalid or closed/.test(String(error))));
async function deliver(
  t: {diagnostic: (message: string) => void},
  snap: import('firebase-admin/firestore').DocumentSnapshot,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await runQueue(snap);
      return;
    } catch (error) {
      if (!isContention(error) || attempt === 5) throw error;
      t.diagnostic(`redelivering ${snap.id} after contention (attempt ${attempt})`);
    }
  }
}

test('one remaining queue slot claims one row and stamps the other until the window ends', async (t) => {
  await userRef.set({
    uid,
    email: 'timer@example.com',
    toggl: {apiToken: 'token', workspaceId: 3, projectId: 4},
  }, {merge: true});
  const quotaRef = userRef.collection('functionQuotas').doc('togglQueue');
  const rowsRef = userRef.collection('functionQuotas').doc('togglQueueRows');
  await rowsRef.delete();
  const windowStartedAt = new Date();
  await quotaRef.set({windowStartedAt, count: TOGGL_QUEUE_LIMIT - 1});
  const queue = userRef.collection('togglQueue');
  const createdAt = new Date(Date.now() - 60_000);
  await Promise.all([
    queue.doc('first').set(freshCreate('First', createdAt)),
    queue.doc('second').set(freshCreate('Second', createdAt)),
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
  // Both deliveries resolve: the over-quota one no longer throws for
  // Eventarc to redeliver (SEC-002).
  await Promise.all([deliver(t, first), deliver(t, second)]);

  assert.equal(fetchCalls, 1);
  assert.equal((await quotaRef.get()).data()?.count, TOGGL_QUEUE_LIMIT);
  let remaining = await queue.get();
  assert.equal(remaining.size, 1);
  const deferred = remaining.docs[0].data();
  assert.equal(deferred.status, 'pending');
  assert.equal(deferred.attempts, undefined);
  assert.equal(deferred.claimedAt, undefined);
  // Stamped with the server-pinned end of the quota window, given a finite
  // expiry measured from creation, and counted as a row like the claimed one.
  assert.equal(
    (deferred.deferredUntil as AdminTimestamp).toMillis(),
    windowStartedAt.getTime() + TOGGL_QUEUE_WINDOW_MS,
  );
  assert.equal(
    (deferred.expiresAt as AdminTimestamp).toMillis(),
    createdAt.getTime() + TOGGL_QUEUE_RETENTION_MS,
  );
  assert.equal(deferred.deferrals, 1);
  assert.equal((await rowsRef.get()).data()?.count, 2);

  // A second delivery inside the same window (the stamp write itself fires
  // the trigger again) writes nothing at all.
  const stamped = await remaining.docs[0].ref.get();
  await Promise.all([deliver(t, stamped), deliver(t, stamped)]);
  const untouched = await remaining.docs[0].ref.get();
  assert.equal(untouched.updateTime?.isEqual(stamped.updateTime!), true);
  assert.equal((await rowsRef.get()).data()?.count, 2);
  assert.equal(fetchCalls, 1);

  // Once the window has ended the same row is claimed and synced; the stamp
  // does not survive the claim.
  await quotaRef.set({
    windowStartedAt: new Date(Date.now() - 2 * TOGGL_QUEUE_WINDOW_MS),
    count: TOGGL_QUEUE_LIMIT,
  });
  const retried = await remaining.docs[0].ref.get();
  await Promise.all([deliver(t, retried), deliver(t, retried)]);

  assert.equal(fetchCalls, 2);
  assert.equal((await quotaRef.get()).data()?.count, 1);
  remaining = await queue.get();
  assert.equal(remaining.empty, true);
  // The claim of an already-counted row did not count it again.
  assert.equal((await rowsRef.get()).data()?.count, 2);
});

test('the claim clears the deferral stamp even when the sync then fails', async (t) => {
  const quotaRef = userRef.collection('functionQuotas').doc('togglQueue');
  const queue = userRef.collection('togglQueue');
  const windowStartedAt = new Date(Date.now() - 2 * TOGGL_QUEUE_WINDOW_MS);
  await quotaRef.set({windowStartedAt, count: TOGGL_QUEUE_LIMIT});
  const ref = queue.doc('stamped-then-failing');
  await ref.set({
    ...freshCreate('Stamped'),
    deferredUntil: Timestamp.fromMillis(windowStartedAt.getTime() + TOGGL_QUEUE_WINDOW_MS),
    expiresAt: Timestamp.fromMillis(Date.now() + TOGGL_QUEUE_RETENTION_MS),
  });
  t.mock.method(globalThis, 'fetch', async () => new Response('down', {status: 400}));
  await assert.rejects(runQueue(await ref.get()), /status 400/);
  const failed = (await ref.get()).data();
  assert.equal(failed?.status, 'error');
  assert.equal(failed?.attempts, 1);
  assert.equal(failed?.deferredUntil, undefined);
  await ref.delete();
});

test('a flood of admitted rows is counted once each, deferred without a storm, and warned once', async (t) => {
  // The rules admit at most one atomic-stop row per timer clear and close
  // once the counter below reaches TOGGL_QUEUE_ROW_LIMIT; this exercises
  // the trigger's half against rows the rules already admitted, including
  // the burst that lands before the counter catches up.
  const warnings = captureWarnings(t);
  const quotaRef = userRef.collection('functionQuotas').doc('togglQueue');
  const rowsRef = userRef.collection('functionQuotas').doc('togglQueueRows');
  const queue = userRef.collection('togglQueue');
  const windowStartedAt = new Date();
  const total = TOGGL_QUEUE_ROW_LIMIT + 5;
  await Promise.all([
    quotaRef.set({windowStartedAt, count: TOGGL_QUEUE_LIMIT}),
    rowsRef.delete(),
  ]);
  const refs = Array.from({length: total}, (_, index) => queue.doc(`flood-${index}`));
  await Promise.all(refs.map((ref, index) => ref.set(freshCreate(`Flood ${index}`))));
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1;
    throw new Error('the quota is full; nothing may reach Toggl');
  });

  // Five concurrent deliveries at a time, so the row counter sees real
  // contention on the emulator without exhausting the SDK's retry budget.
  const snaps = await Promise.all(refs.map((ref) => ref.get()));
  for (let index = 0; index < snaps.length; index += 5) {
    await Promise.all(snaps.slice(index, index + 5).map((snap) => deliver(t, snap)));
  }

  assert.equal(fetchCalls, 0);
  assert.equal((await quotaRef.get()).data()?.count, TOGGL_QUEUE_LIMIT);
  const rows = (await rowsRef.get()).data();
  assert.equal(rows?.count, TOGGL_QUEUE_ROW_LIMIT + 1);
  assert.deepEqual(warnings, [['toggl.queue_rows_exceeded', {uid}]]);
  const until = windowStartedAt.getTime() + TOGGL_QUEUE_WINDOW_MS;
  const after = await Promise.all(refs.map((ref) => ref.get()));
  for (const snap of after) {
    const data = snap.data();
    assert.equal(data?.status, 'pending');
    assert.equal(data?.attempts, undefined);
    assert.equal((data?.deferredUntil as AdminTimestamp).toMillis(), until);
    assert.equal(data?.deferrals, 1);
    assert.ok(data?.expiresAt instanceof Timestamp);
  }

  // Redelivering every stamped row (which is what the stamp writes cause)
  // changes nothing: no writes, no counting, no second warning.
  for (let index = 0; index < after.length; index += 5) {
    await Promise.all(after.slice(index, index + 5).map((snap) => deliver(t, snap)));
  }
  const again = await Promise.all(refs.map((ref) => ref.get()));
  again.forEach((snap, index) => {
    assert.equal(snap.updateTime?.isEqual(after[index].updateTime!), true);
  });
  assert.equal((await rowsRef.get()).data()?.count, TOGGL_QUEUE_ROW_LIMIT + 1);
  assert.equal(warnings.length, 1);
  await Promise.all(refs.map((ref) => ref.delete()));
});

test('a row deferred in every window of a day becomes terminal, and a correlated stop is never deferred', async (t) => {
  const quotaRef = userRef.collection('functionQuotas').doc('togglQueue');
  const queue = userRef.collection('togglQueue');
  const windowStartedAt = new Date(Date.now() - 10 * 60 * 1000);
  await quotaRef.set({windowStartedAt, count: TOGGL_QUEUE_LIMIT});
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({id: 400 + fetchCalls}), {status: 200});
  });

  // Windows 1..24 each stamp the row once; the 25th makes it terminal —
  // not re-armable (attempts 5), expiring, and no longer stamped.
  const ref = queue.doc('deferred-daily');
  await ref.set(freshCreate('Deferred daily'));
  // Time does not advance in a test, so each "new window" is a full quota
  // window that started a second later than the previous one: still
  // current, still full, and with a different end for the stamp.
  for (let window = 0; window <= TOGGL_QUEUE_MAX_DEFERRALS; window += 1) {
    const started = new Date(windowStartedAt.getTime() + window * 1000);
    await quotaRef.set({windowStartedAt: started, count: TOGGL_QUEUE_LIMIT});
    await deliver(t, await ref.get());
    const data = (await ref.get()).data();
    if (window < TOGGL_QUEUE_MAX_DEFERRALS) {
      assert.equal(data?.status, 'pending');
      assert.equal(data?.deferrals, window + 1);
    } else {
      assert.equal(data?.status, 'error');
      assert.equal(data?.attempts, 5);
      assert.equal(data?.deferrals, TOGGL_QUEUE_MAX_DEFERRALS + 1);
      assert.equal(data?.deferredUntil, undefined);
      assert.ok(data?.expiresAt instanceof Timestamp);
      assert.match(String(data?.error), /consecutive hours/);
    }
  }
  assert.equal(fetchCalls, 0);
  await ref.delete();

  // A correlated stop holds the account's single timer lock, so it goes
  // through the full window and releases the book.
  await quotaRef.set({windowStartedAt, count: TOGGL_QUEUE_LIMIT});
  const start = '2026-08-24T15:00:00.000Z';
  const queueId = `book_${start}`;
  const bookRef = userRef.collection('books').doc('book');
  await Promise.all([
    bookRef.set({title: 'Book', activeTimer: {state: 'stopping', entryId: 777, start, queueId}}),
    lifecycleRef.set({version: 1, state: 'stopping', bookId: 'book', entryId: 777, start, queueId}),
    queue.doc(queueId).set({
      type: 'stop', bookId: 'book', timerClaimVersion: 1, entryId: 777,
      bookTitle: 'Book', start, stop: '2026-08-24T15:20:00.000Z',
      status: 'pending', createdAt: new Date(),
    }),
  ]);
  await deliver(t, await queue.doc(queueId).get());
  assert.equal(fetchCalls, 1);
  assert.equal((await queue.doc(queueId).get()).exists, false);
  assert.equal((await bookRef.get()).data()?.activeTimer, null);
  assert.equal((await lifecycleRef.get()).data()?.state, 'idle');
  assert.equal((await quotaRef.get()).data()?.count, TOGGL_QUEUE_LIMIT + 1);
});

test('a stale redelivery of a create event neither counts nor claims a row twice', async (t) => {
  const quotaRef = userRef.collection('functionQuotas').doc('togglQueue');
  const rowsRef = userRef.collection('functionQuotas').doc('togglQueueRows');
  const queue = userRef.collection('togglQueue');
  await Promise.all([
    quotaRef.set({windowStartedAt: new Date(), count: 0}),
    rowsRef.set({windowStartedAt: new Date(), count: 4}),
  ]);
  let fetchCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({id: 300 + fetchCalls}), {status: 200});
  });
  const ref = queue.doc('stale-redelivery');
  await ref.set(freshCreate('Stale'));
  const stale = await ref.get();
  await runQueue(stale);
  assert.equal(fetchCalls, 1);
  assert.equal((await ref.get()).exists, false);
  assert.equal((await rowsRef.get()).data()?.count, 5);

  // Eventarc redelivers the original create payload; the handler reads the
  // live row (gone) and does nothing.
  await runQueue(stale);
  assert.equal(fetchCalls, 1);
  assert.equal((await rowsRef.get()).data()?.count, 5);
  assert.equal((await quotaRef.get()).data()?.count, 1);
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
