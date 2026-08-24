import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test, { after } from 'node:test';

process.env.GCLOUD_PROJECT = 'book-tracker-rules-test';

const functionsRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const { getFirestore } = functionsRequire('firebase-admin/firestore') as {
  getFirestore: () => import('firebase-admin/firestore').Firestore;
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
  };
};

const db = getFirestore();
const uid = `toggl-transaction-${Date.now()}`;
const userRef = db.doc(`users/${uid}`);

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

  const snapshot = await books.get();
  assert.equal(snapshot.docs.filter((book) => book.data().activeTimer !== null).length, 1);
});

test('one remaining queue slot serializes simultaneous claims', async (t) => {
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
  await Promise.all([
    deployed.toggl.syncqueue.run({
      data: {after: first},
      params: {uid, queueId: 'first'},
    }),
    deployed.toggl.syncqueue.run({
      data: {after: second},
      params: {uid, queueId: 'second'},
    }),
  ]);

  assert.equal(fetchCalls, 1);
  assert.equal((await quotaRef.get()).data()?.count, 10);
  const remaining = await queue.get();
  assert.equal(remaining.size, 1);
  assert.equal(remaining.docs[0].data().status, 'error');
  assert.equal(remaining.docs[0].data().attempts, 5);
  assert.match(remaining.docs[0].data().error, /hourly limit/);
});
