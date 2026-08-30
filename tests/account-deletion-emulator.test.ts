import './setup.ts';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

// Account deletion end to end against the Firestore emulator (SEC-006,
// soft delete): the compiled Auth trigger runs unmodified over a full
// account tree, the public renderer and sitemap read the result through
// the deployed repository, and the operator purge script is rehearsed on
// its own namespace. setup.ts points the Admin SDK at the emulator and at
// a credentials file that does not exist, so nothing here can reach a
// live project.
const functionsRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const { getFirestore, Timestamp, FieldValue } = functionsRequire('firebase-admin/firestore') as {
  getFirestore: (app?: unknown) => import('firebase-admin/firestore').Firestore;
  Timestamp: typeof import('firebase-admin/firestore').Timestamp;
  FieldValue: typeof import('firebase-admin/firestore').FieldValue;
};
const { initializeApp } = functionsRequire('firebase-admin/app') as {
  initializeApp: (options: { projectId: string }, name: string) => unknown;
};
const { getAuth } = functionsRequire('firebase-admin/auth') as {
  getAuth: (app?: unknown) => {
    createUser: (user: { uid: string; email: string }) => Promise<unknown>;
    deleteUser: (uid: string) => Promise<void>;
  };
};
const { logger } = functionsRequire('firebase-functions') as {
  logger: { warn: (...args: unknown[]) => void };
};
const deployed = functionsRequire('./lib') as {
  deleteUserDocument: { run: (user: { uid: string }) => Promise<unknown> };
};
const { firestoreRepository, resolvePublicWebRequest } = functionsRequire('./lib/publicWeb') as {
  firestoreRepository: unknown;
  resolvePublicWebRequest: (
    request: { method: string; path: string },
    repository: unknown,
    shell: string,
  ) => Promise<{ status: number; body: string; headers: Record<string, string> }>;
};
const shell = readFileSync(fileURLToPath(new URL('../functions/assets/profile-shell.html', import.meta.url)), 'utf8');

type Db = import('firebase-admin/firestore').Firestore;
type DocRef = import('firebase-admin/firestore').DocumentReference;
const db = getFirestore();
const run = `del${Date.now()}`;

const profileFor = (uid: string) => ({
  uid,
  public: true,
  givenName: 'Ada',
  familyName: 'Lovelace',
  links: [],
  stats: {
    totalBooks: 1, finishedBooks: 0, readingBooks: 1, totalTimeReadHours: 1,
    totalPagesRead: 20, booksPerYear: 1, avgTimePerBook: 60, authors: 1,
  },
  records: null,
  years: [{ year: 2026, count: 1, hours: 1, pages: 20 }],
  days: [{ day: '2026-08-20', pagesRead: 20, timeRead: 60, sessions: 1 }],
  updatedAt: Timestamp.fromDate(new Date('2026-08-24T12:00:00.000Z')),
});

// Everything an account can own, so the assertion "nothing else changed"
// covers every collection deletion used to leave behind.
async function seedAccount(target: Db, uid: string, username: string): Promise<void> {
  const user = target.collection('users').doc(uid);
  await user.set({ uid, email: `${uid}@example.test`, toggl: { apiToken: 'secret-token', workspaceId: 3, projectId: 4 } });
  const book = user.collection('books').doc('book-1');
  await book.set({ title: 'Kept', currentPage: 20, pageCount: 100, finished: false, pagesRead: 20, timeRead: 60, activeTimer: null, currentPageUpdateId: null, authorIds: ['author-1'], owner: user, updatedAt: Timestamp.now(), createdAt: Timestamp.now() });
  await book.collection('updates').doc('u1').set({ owner: user, book, type: 'reading', timeRead: 60, fromPage: 0, toPage: 20, pagesRead: 20, updatedAt: Timestamp.now(), createdAt: Timestamp.now() });
  await user.collection('authors').doc('author-1').set({ name: 'Ada Lovelace', nameLower: 'ada lovelace', kind: 'person', givenName: 'Ada', familyName: 'Lovelace' });
  await user.collection('timerLifecycle').doc('current').set({ version: 1, state: 'idle', cleared: null });
  await user.collection('togglQueue').doc('book-1_2026-08-29T10:00:00.000Z').set({ type: 'stop', status: 'error', attempts: 5, createdAt: Timestamp.now() });
  await user.collection('functionQuotas').doc('togglQueue').set({ windowStartedAt: Timestamp.now(), count: 1 });
  await target.collection('profiles').doc(username).set(profileFor(uid));
  await target.collection('profileDiscovery').doc(username).set({ uid, createdAt: Timestamp.now() });
  await target.collection('profileOwners').doc(uid).set({ username });
}

async function dumpTree(ref: DocRef, into: Map<string, string>): Promise<void> {
  const snapshot = await ref.get();
  if (snapshot.exists) into.set(ref.path, JSON.stringify(snapshot.data()));
  for (const collection of await ref.listCollections()) {
    for (const child of await collection.listDocuments()) await dumpTree(child, into);
  }
}

async function dumpAccount(target: Db, uid: string, username: string): Promise<Map<string, string>> {
  const into = new Map<string, string>();
  await dumpTree(target.collection('users').doc(uid), into);
  for (const path of [`profiles/${username}`, `profileDiscovery/${username}`, `profileOwners/${uid}`]) {
    await dumpTree(target.doc(path), into);
  }
  return into;
}

function withoutTombstone(json: string): string {
  const { deletedAt, ...rest } = JSON.parse(json) as Record<string, unknown>;
  assert.ok(deletedAt !== undefined, 'expected a tombstone');
  return JSON.stringify(rest);
}

const warnings: unknown[][] = [];
const originalWarn = logger.warn;
logger.warn = (...args: unknown[]) => {
  warnings.push(args);
};
after(() => {
  logger.warn = originalWarn;
});

test('deleting an account tombstones its document and profile and removes nothing', async () => {
  const uid = `gone-${run}`;
  const username = `gone-${run}`;
  const bystander = `live-${run}`;
  await seedAccount(db, uid, username);
  await seedAccount(db, bystander, bystander);
  const before = await dumpAccount(db, uid, username);
  const bystanderBefore = await dumpAccount(db, bystander, bystander);
  assert.equal(before.size, 10);
  assert.ok(before.has(`profileDiscovery/${username}`));

  await deployed.deleteUserDocument.run({ uid });

  const afterFirst = await dumpAccount(db, uid, username);
  // The discovery marker — a search-index pointer, not content — is the
  // one thing deletion removes; everything else survives, with a tombstone
  // on the user document and the profile.
  const markerPath = `profileDiscovery/${username}`;
  assert.ok(before.has(markerPath));
  assert.ok(!afterFirst.has(markerPath), 'the discovery marker must be deleted');
  assert.deepEqual([...afterFirst.keys()].sort(), [...before.keys()].filter((p) => p !== markerPath).sort());
  for (const [path, json] of before) {
    if (path === markerPath) continue;
    const stored = afterFirst.get(path);
    assert.ok(stored !== undefined);
    if (path === `users/${uid}` || path === `profiles/${username}`) {
      assert.equal(withoutTombstone(stored), json, path);
      const tombstone = (await db.doc(path).get()).get('deletedAt');
      assert.ok(tombstone instanceof Timestamp, `${path} deletedAt is a server timestamp`);
    } else {
      assert.equal(stored, json, `${path} must be untouched`);
    }
  }
  // The credential is retained with the rest (the owner's retention
  // decision); toggl.ts refuses to use it for a tombstoned account.
  assert.equal((await db.doc(`users/${uid}`).get()).get('toggl').apiToken, 'secret-token');
  assert.deepEqual(await dumpAccount(db, bystander, bystander), bystanderBefore);

  // Redelivery (failurePolicy): idempotent to the byte — the tombstones
  // keep their first timestamp.
  await deployed.deleteUserDocument.run({ uid });
  assert.deepEqual(await dumpAccount(db, uid, username), afterFirst);

  // To a stranger the tombstoned profile is a missing one: the same 404
  // page as a name that never existed, no sitemap row, and no skip logged
  // for it; the bystander's profile still serves.
  const page = await resolvePublicWebRequest({ method: 'GET', path: `/profiles/${username}` }, firestoreRepository, shell);
  const missing = await resolvePublicWebRequest({ method: 'GET', path: `/profiles/never-${run}` }, firestoreRepository, shell);
  assert.equal(page.status, 404);
  assert.equal(page.body, missing.body);
  assert.deepEqual(page.headers, missing.headers);
  const json = await resolvePublicWebRequest({ method: 'GET', path: `/profiles/${username}.json` }, firestoreRepository, shell);
  assert.equal(json.status, 404);
  const live = await resolvePublicWebRequest({ method: 'GET', path: `/profiles/${bystander}` }, firestoreRepository, shell);
  assert.equal(live.status, 200);
  const sitemap = await resolvePublicWebRequest({ method: 'GET', path: '/sitemap.xml' }, firestoreRepository, shell);
  assert.equal(sitemap.status, 200);
  assert.ok(sitemap.body.includes(`/profiles/${bystander}<`));
  assert.ok(!sitemap.body.includes(username));
  const skipped = warnings.filter(([event]) => event === 'publicweb.sitemap.skip' || event === 'publicweb.profile.skip');
  assert.deepEqual(skipped, []);
});

// The trigger pages profiles by document id, 100 at a time, behind a
// cursor — a limit-only page would never advance, since the tombstone does
// not change the query. The unit test pins the query shape against a
// mock; this runs the real cursor against the emulator, so a paging bug
// that a mock cannot see (an infinite loop, a skipped page) shows here.
test('a 101-profile account is tombstoned page by page and only its own markers go', async () => {
  const uid = `many-${run}`;
  const squatter = `squat-${run}`;
  const usernames = Array.from({ length: 101 }, (_, i) => `many-${run}-${String(i).padStart(3, '0')}`);
  const batch = db.batch();
  batch.set(db.doc(`users/${uid}`), { uid, email: `${uid}@example.test` });
  for (const username of usernames) {
    batch.set(db.doc(`profiles/${username}`), profileFor(uid));
    batch.set(db.doc(`profileDiscovery/${username}`), { uid, createdAt: Timestamp.now() });
  }
  // A marker that names another account under one of this account's
  // profile names: drift the rules make unlikely, but the marker rule's
  // promise is that a marker is only ever removed by the uid it names.
  const reclaimed = `many-${run}-rc`;
  batch.set(db.doc(`profiles/${reclaimed}`), profileFor(uid));
  batch.set(db.doc(`profileDiscovery/${reclaimed}`), { uid: squatter, createdAt: Timestamp.now() });
  await batch.commit();

  await deployed.deleteUserDocument.run({ uid });

  const profiles = await db.collection('profiles').where('uid', '==', uid).get();
  assert.equal(profiles.size, 102);
  for (const profile of profiles.docs) {
    assert.ok(profile.get('deletedAt') instanceof Timestamp, `${profile.id} must be tombstoned`);
  }
  for (const username of usernames) {
    assert.equal((await db.doc(`profileDiscovery/${username}`).get()).exists, false, `${username} marker must go`);
  }
  assert.equal((await db.doc(`profileDiscovery/${reclaimed}`).get()).get('uid'), squatter);
  // The namespace is shared across the emulator session: a marker that
  // names a uid with no matching profile would be a sitemap skip for
  // every later test, so it goes here.
  await db.doc(`profileDiscovery/${reclaimed}`).delete();
});

// The purge script is the only path that removes an account's data. It
// runs against its own project namespace (migrate-lib pins the real
// project id; the emulator keys data by project), one uid per run, and
// refuses anything that is not tombstoned.
test('the purge script refuses a live account, dry-runs, and removes exactly one tombstoned tree', async () => {
  const purgeApp = initializeApp({ projectId: 'book-tracker-d8f24' }, `purge-${run}`);
  const target = getFirestore(purgeApp);
  const gone = `purge-${run}`;
  const kept = `keep-${run}`;
  await seedAccount(target, gone, gone);
  await seedAccount(target, kept, kept);
  const keptBefore = await dumpAccount(target, kept, kept);
  const auth = getAuth(purgeApp);
  await auth.createUser({ uid: gone, email: `${gone}@example.test` });
  const root = fileURLToPath(new URL('..', import.meta.url));
  const script = fileURLToPath(new URL('../migrate-purge-deleted-accounts.ts', import.meta.url));
  const purge = (uid: string, ...flags: string[]) => spawnSync('node', [script, uid, ...flags], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST },
  });
  const audit = () => {
    const result = spawnSync('node', [fileURLToPath(new URL('../db-audit.ts', import.meta.url))], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };

  // Live account, still in Auth: refused, even with --apply, before it
  // looks at Firestore at all, and it changed nothing.
  const goneBefore = await dumpAccount(target, gone, gone);
  assert.ok(goneBefore.size > 0);
  const inAuth = purge(gone, '--apply');
  assert.notEqual(inAuth.status, 0);
  assert.match(inAuth.stderr, /still exists in Auth/);
  assert.deepEqual(await dumpAccount(target, gone, gone), goneBefore);

  // Gone from Auth but not tombstoned (the trigger has not run, or
  // never will — deleteUsers() in bulk does not fire it): refused too.
  await auth.deleteUser(gone);
  const refused = purge(gone, '--apply');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /not tombstoned/);
  assert.deepEqual(await dumpAccount(target, gone, gone), goneBefore);

  await target.doc(`users/${gone}`).set({ deletedAt: FieldValue.serverTimestamp() }, { merge: true });
  await target.doc(`profiles/${gone}`).set({ deletedAt: FieldValue.serverTimestamp() }, { merge: true });
  const tombstoned = await dumpAccount(target, gone, gone);

  // A tombstone on an account that exists in Auth is drift (only the
  // deletion trigger writes one), and purging it would destroy a working
  // account: refused, before anything is read.
  await auth.createUser({ uid: gone, email: `${gone}@example.test` });
  const drift = purge(gone, '--apply');
  assert.notEqual(drift.status, 0);
  assert.match(drift.stderr, /still exists in Auth/);
  assert.deepEqual(await dumpAccount(target, gone, gone), tombstoned);
  await auth.deleteUser(gone);

  // No trigger ran in this namespace, so the marker is still there on a
  // tombstoned profile — the half-done state the audit must report (the
  // tombstone leaves `public` true, so no older check catches it).
  assert.match(audit(), new RegExp(`^profile-discovery\\.profile-tombstoned profileDiscovery/${gone}$`, 'm'));
  assert.match(audit(), /^deleted-accounts: [1-9]/m);

  const dry = purge(gone);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /TARGET: emulator/);
  assert.match(dry.stdout, new RegExp(`^${gone} is not in Auth$`, 'm'));
  assert.match(dry.stdout, new RegExp(`DRY profileDiscovery/${gone}`));
  assert.match(dry.stdout, new RegExp(`DRY profiles/${gone}`));
  assert.match(dry.stdout, new RegExp(`DRY profileOwners/${gone}`));
  assert.match(dry.stdout, /tree: 7 documents/);
  assert.match(dry.stdout, /nothing written/);
  assert.deepEqual(await dumpAccount(target, gone, gone), tombstoned);

  const applied = purge(gone, '--apply');
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /3 public documents and a 7-document tree deleted/);
  assert.equal((await dumpAccount(target, gone, gone)).size, 0);
  assert.deepEqual(await target.collection('users').doc(gone).listCollections(), []);
  assert.deepEqual(await dumpAccount(target, kept, kept), keptBefore);

  // Re-running a completed purge (or one interrupted after the root doc
  // went) does not throw and writes nothing: the root is absent, so the
  // account is treated as already gone.
  const again = purge(gone, '--apply');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /is absent/);
  assert.match(again.stdout, /0 public documents and a 0-document tree deleted/);
  assert.doesNotMatch(audit(), new RegExp(`profileDiscovery/${gone}`));

  // A purge interrupted after the root document went (root-last makes
  // that the only possible partial state): the re-run finds the orphaned
  // subcollections under the missing root, removes them, and reports it.
  await target.doc(`users/${gone}/books/orphan`).set({ title: 'Orphan' });
  await target.doc(`users/${gone}/books/orphan/updates/u1`).set({ pagesRead: 1 });
  const cleaned = purge(gone, '--apply');
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.match(cleaned.stdout, /is absent/);
  assert.match(cleaned.stdout, /tree: 2 documents/);
  assert.match(cleaned.stdout, /0 public documents and a 2-document tree deleted/);
  assert.equal((await dumpAccount(target, gone, gone)).size, 0);
  assert.deepEqual(await target.collection('users').doc(gone).listCollections(), []);
  assert.deepEqual(await dumpAccount(target, kept, kept), keptBefore);
});
