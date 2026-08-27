import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProfileView } from '../src/lib/interfaces/profile.ts';
import { resolveProfileView } from '../src/lib/utils/profileRead.ts';

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
