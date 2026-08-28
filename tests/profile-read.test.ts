import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProfileView } from '../src/lib/interfaces/profile.ts';
import { assertProfileViewFor, resolveProfileView } from '../src/lib/utils/profileRead.ts';

const view = (username: string, isPublic: boolean): ProfileView => ({
  username,
  public: isPublic,
  givenName: 'Ada',
  familyName: 'Lovelace',
  links: [],
  stats: {
    totalBooks: 0, finishedBooks: 0, readingBooks: 0, totalTimeReadHours: 0,
    totalPagesRead: 0, booksPerYear: 0, avgTimePerBook: 0, authors: 0,
  },
  records: null,
  years: [],
  days: [],
  updatedAt: '2026-08-24T12:00:00.000Z',
});

function readers(own: ProfileView | null, pub: ProfileView | null) {
  const calls = { own: 0, public: 0 };
  return {
    calls,
    readOwn: async () => { calls.own += 1; return own; },
    readPublic: async () => { calls.public += 1; return pub; },
  };
}

test('an anonymous viewer reads only the public projection', async () => {
  const r = readers(view('ada', false), view('ada', true));
  const result = await resolveProfileView(false, r.readOwn, r.readPublic);
  assert.equal(result?.public, true);
  assert.deepEqual(r.calls, { own: 0, public: 1 });
});

test('a signed-in viewer known to own another username never touches Firestore', async () => {
  const r = readers(view('ada', false), view('ada', true));
  const result = await resolveProfileView(false, r.readOwn, r.readPublic);
  assert.equal(result?.public, true);
  assert.deepEqual(r.calls, { own: 0, public: 1 });
});

test('an own read that fails for any reason falls through to the projection', async () => {
  let publicCalls = 0;
  const result = await resolveProfileView(
    true,
    async () => { throw new Error('unavailable'); },
    async () => { publicCalls += 1; return view('ada', true); },
  );
  assert.equal(result?.public, true);
  assert.equal(publicCalls, 1);
});

test('the own-read failure surfaces only when the projection has nothing either', async () => {
  await assert.rejects(
    resolveProfileView(true, async () => { throw new Error('unavailable'); }, async () => null),
    /unavailable/,
  );
  await assert.rejects(
    resolveProfileView(true, async () => { throw new Error('unavailable'); }, async () => { throw new Error('offline'); }),
    /offline/,
  );
});

test('an own read that rejects with a bare null or undefined is still a failure', async () => {
  await assert.rejects(
    resolveProfileView(true, () => Promise.reject(null), async () => null),
    (error) => error === null,
  );
  await assert.rejects(
    resolveProfileView(true, () => Promise.reject(undefined), async () => null),
    (error) => error === undefined,
  );
});

test('a projection for a different username is rejected, never rendered', () => {
  assert.equal(assertProfileViewFor(view('ada', true), 'ada').username, 'ada');
  assert.throws(() => assertProfileViewFor(view('someone-else', true), 'ada'), /Requested profiles\/ada\.json but received someone-else/);
});

test('the owner reads their own document, public or private, and never the projection', async () => {
  const r = readers(view('ada', false), view('ada', true));
  const result = await resolveProfileView(true, r.readOwn, r.readPublic);
  assert.equal(result?.public, false);
  assert.deepEqual(r.calls, { own: 1, public: 0 });
});

test('a signed-in stranger falls back to the public projection after a denied own read', async () => {
  const r = readers(null, view('ada', true));
  const result = await resolveProfileView(true, r.readOwn, r.readPublic);
  assert.equal(result?.public, true);
  assert.deepEqual(r.calls, { own: 1, public: 1 });
});

test('a missing or private profile resolves to null for a stranger', async () => {
  const r = readers(null, null);
  assert.equal(await resolveProfileView(true, r.readOwn, r.readPublic), null);
  assert.equal(await resolveProfileView(false, r.readOwn, r.readPublic), null);
  assert.deepEqual(r.calls, { own: 1, public: 2 });
});

test('a failing public read propagates instead of reading as not-found', async () => {
  await assert.rejects(
    resolveProfileView(false, async () => null, async () => { throw new Error('offline'); }),
    /offline/,
  );
});
