import './setup.ts';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// migrate-grandfather-email-verified.ts rehearsal: every unverified account
// is flipped except the ones on the exclusion list, the apply is idempotent
// and recorded, and --revert restores exactly the recorded run. Runs on the migrate-lib
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

test('grandfathering flips every unverified account except the excluded ones, records the run, and reverts it exactly', async (t) => {
  const reader = `reader-${run}`; // a real person with books
  const lurker = `lurker-${run}`; // a real person who never added a book
  const probe = `probe-${run}`; // a test sign-up, on the exclusion list
  const done = `done-${run}`; // verified already
  for (const [uid, emailVerified] of [[reader, false], [lurker, false], [probe, false], [done, true]] as const) {
    await auth.createUser({ uid, email: `${uid}@example.test`, password: 'valid-test-password', emailVerified });
    await db.doc(`users/${uid}`).set({ uid, email: `${uid}@example.test` });
  }
  t.after(() => Promise.all([reader, lurker, probe, done].map((uid) => auth.deleteUser(uid))));
  for (const uid of [reader, done]) {
    await db.doc(`users/${uid}/books/book-${run}`).set({ title: 'A Book', updatedAt: Timestamp.now() });
  }
  const outFile = join(root, `grandfathered-test-${run}.json`);
  const excludeFile = join(root, `grandfathered-exclude-${run}.txt`);
  writeFileSync(excludeFile, `# test sign-ups\n${probe}   # red-team probe\n\n`);

  // The Auth target is guarded like the Firestore one.
  const noAuthEmulator = { ...process.env };
  delete noAuthEmulator.FIREBASE_AUTH_EMULATOR_HOST;
  const unguarded = migrate([], noAuthEmulator);
  assert.notEqual(unguarded.status, 0);
  assert.match(unguarded.stderr, /no loopback FIREBASE_AUTH_EMULATOR_HOST/);

  // An exclusion list naming an unknown uid is a typo, not a no-op.
  writeFileSync(`${excludeFile}.typo`, `${probe}\nno-such-uid-${run}\n`);
  const typo = migrate([`--exclude=${excludeFile}.typo`]);
  assert.notEqual(typo.status, 0);
  assert.match(typo.stderr, new RegExp(`excluded uid no-such-uid-${run} is not an account`));

  // Neither is an empty one.
  writeFileSync(`${excludeFile}.empty`, '# nothing here\n');
  const empty = migrate([`--exclude=${excludeFile}.empty`]);
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /lists no uids/);

  // Dry run decides but writes nothing; every line carries the facts the
  // exclusion list is built from.
  const dry = migrate([`--exclude=${excludeFile}`]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, new RegExp(`^DRY ${reader} emailVerified -> true \\(${reader}@example.test, created .+, last sign-in .+, 1 book\\(s\\)\\)$`, 'm'));
  assert.match(dry.stdout, new RegExp(`^DRY ${lurker} emailVerified -> true \\(${lurker}@example.test, created .+, last sign-in .+, 0 book\\(s\\)\\)$`, 'm'));
  assert.match(dry.stdout, new RegExp(`^skip ${probe} excluded \\(`, 'm'));
  assert.match(dry.stdout, new RegExp(`^ok ${done} already verified \\(`, 'm'));
  assert.equal((await auth.getUser(reader)).emailVerified, false);
  assert.equal((await auth.getUser(lurker)).emailVerified, false);

  const applied = migrate(['--apply', `--exclude=${excludeFile}`, `--out=${outFile}`]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, new RegExp(`^VERIFY ${reader} emailVerified -> true`, 'm'));
  assert.match(applied.stdout, new RegExp(`^VERIFY ${lurker} emailVerified -> true`, 'm'));
  assert.equal((await auth.getUser(reader)).emailVerified, true);
  assert.equal((await auth.getUser(lurker)).emailVerified, true);
  assert.equal((await auth.getUser(probe)).emailVerified, false);
  assert.equal((await auth.getUser(done)).emailVerified, true);

  // The record holds exactly what this run changed — not the already-verified
  // account, not the excluded one — so a revert cannot un-verify anyone the
  // script never touched.
  const record = JSON.parse(readFileSync(outFile, 'utf8')) as { project: string; uids: string[] };
  assert.equal(record.project, 'book-tracker-d8f24');
  assert.ok(record.uids.includes(reader));
  assert.ok(record.uids.includes(lurker));
  assert.ok(!record.uids.includes(done));
  assert.ok(!record.uids.includes(probe));

  // Idempotent: a re-run finds nothing to do and leaves no new record.
  const again = migrate(['--apply', `--exclude=${excludeFile}`, `--out=${outFile}.second`]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, new RegExp(`^ok ${reader} already verified`, 'm'));
  assert.match(again.stdout, /^0 account\(s\) grandfathered/m);
  assert.throws(() => readFileSync(`${outFile}.second`), /ENOENT/);

  const revert = migrate([`--revert=${outFile}`, '--apply']);
  assert.equal(revert.status, 0, revert.stderr);
  assert.match(revert.stdout, new RegExp(`^REVERT ${reader} emailVerified -> false`, 'm'));
  assert.match(revert.stdout, new RegExp(`^REVERT ${lurker} emailVerified -> false`, 'm'));
  assert.equal((await auth.getUser(reader)).emailVerified, false);
  assert.equal((await auth.getUser(lurker)).emailVerified, false);
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
