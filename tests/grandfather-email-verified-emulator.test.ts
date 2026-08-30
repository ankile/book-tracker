import './setup.ts';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// migrate-grandfather-email-verified.ts rehearsal: only unverified accounts
// that own a book are flipped, the apply is idempotent and recorded, and
// --revert restores exactly the recorded run. Runs on the migrate-lib
// namespace (the real project id keyed into the emulator), like the other
// migration rehearsals.
const functionsRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const { getFirestore, Timestamp } = functionsRequire('firebase-admin/firestore') as {
  getFirestore: (app?: unknown) => import('firebase-admin/firestore').Firestore;
  Timestamp: typeof import('firebase-admin/firestore').Timestamp;
};
const { initializeApp } = functionsRequire('firebase-admin/app') as {
  initializeApp: (options: { projectId: string }, name: string) => unknown;
};
const { getAuth } = functionsRequire('firebase-admin/auth') as {
  getAuth: (app?: unknown) => import('firebase-admin/auth').Auth;
};

const run = `gf${Date.now()}`;
const app = initializeApp({ projectId: 'book-tracker-d8f24' }, `grandfather-${run}`);
const db = getFirestore(app);
const auth = getAuth(app);
const root = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(new URL('../migrate-grandfather-email-verified.ts', import.meta.url));

const migrate = (
  flags: string[],
  env: NodeJS.ProcessEnv = { ...process.env },
) => spawnSync('node', [script, ...flags], { cwd: root, encoding: 'utf8', env });

test('grandfathering flips only unverified accounts with books, records the run, and reverts it exactly', async (t) => {
  const active = `active-${run}`;
  const idle = `idle-${run}`;
  const done = `done-${run}`;
  for (const [uid, emailVerified] of [[active, false], [idle, false], [done, true]] as const) {
    await auth.createUser({ uid, email: `${uid}@example.test`, password: 'valid-test-password', emailVerified });
    await db.doc(`users/${uid}`).set({ uid, email: `${uid}@example.test` });
  }
  t.after(() => Promise.all([active, idle, done].map((uid) => auth.deleteUser(uid))));
  for (const uid of [active, done]) {
    await db.doc(`users/${uid}/books/book-${run}`).set({ title: 'A Book', updatedAt: Timestamp.now() });
  }
  const outFile = join(root, `grandfathered-test-${run}.json`);

  // The Auth target is guarded like the Firestore one.
  const noAuthEmulator = { ...process.env };
  delete noAuthEmulator.FIREBASE_AUTH_EMULATOR_HOST;
  const unguarded = migrate([], noAuthEmulator);
  assert.notEqual(unguarded.status, 0);
  assert.match(unguarded.stderr, /no loopback FIREBASE_AUTH_EMULATOR_HOST/);

  // Dry run decides but writes nothing.
  const dry = migrate([]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp(`^DRY ${active} emailVerified -> true$`, 'm'));
  assert.match(dry.stdout, new RegExp(`^skip ${idle} no books$`, 'm'));
  assert.match(dry.stdout, new RegExp(`^ok ${done} already verified$`, 'm'));
  assert.equal((await auth.getUser(active)).emailVerified, false);

  const applied = migrate(['--apply', `--out=${outFile}`]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, new RegExp(`^VERIFY ${active} emailVerified -> true$`, 'm'));
  assert.equal((await auth.getUser(active)).emailVerified, true);
  assert.equal((await auth.getUser(idle)).emailVerified, false);
  assert.equal((await auth.getUser(done)).emailVerified, true);

  // The record holds exactly what this run changed — not the already-verified
  // account — so a revert cannot un-verify anyone the script never touched.
  const record = JSON.parse(readFileSync(outFile, 'utf8')) as { project: string; uids: string[] };
  assert.equal(record.project, 'book-tracker-d8f24');
  assert.ok(record.uids.includes(active));
  assert.ok(!record.uids.includes(done));
  assert.ok(!record.uids.includes(idle));

  // Idempotent: a re-run finds nothing to do and leaves no new record.
  const again = migrate(['--apply', `--out=${outFile}.second`]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, new RegExp(`^ok ${active} already verified$`, 'm'));
  assert.match(again.stdout, /^0 account\(s\) grandfathered/m);
  assert.throws(() => readFileSync(`${outFile}.second`), /ENOENT/);

  const revert = migrate([`--revert=${outFile}`, '--apply']);
  assert.equal(revert.status, 0, revert.stderr);
  assert.match(revert.stdout, new RegExp(`^REVERT ${active} emailVerified -> false`, 'm'));
  assert.equal((await auth.getUser(active)).emailVerified, false);
  assert.equal((await auth.getUser(done)).emailVerified, true);
});

test('a live account with a tombstoned user document stops the run', async (t) => {
  const drifted = `drift-${run}`;
  await auth.createUser({ uid: drifted, email: `${drifted}@example.test`, password: 'valid-test-password' });
  await db.doc(`users/${drifted}`).set({ uid: drifted, deletedAt: Timestamp.now() });
  t.after(async () => {
    await auth.deleteUser(drifted);
    await db.doc(`users/${drifted}`).delete();
  });

  const result = migrate([]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`${drifted} is live in Auth but users/${drifted} is tombstoned`));
});
