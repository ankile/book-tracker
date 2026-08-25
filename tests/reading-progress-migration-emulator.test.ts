import './setup.ts';

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test, {after} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initializeApp} from 'firebase-admin/app';
import {getFirestore, Timestamp} from 'firebase-admin/firestore';

const db = getFirestore(initializeApp({projectId: 'book-tracker-d8f24'}, 'progress-migration-test'));
const uid = `progress-migration-${Date.now()}`;
const userRef = db.doc(`users/${uid}`);
const migrationPath = fileURLToPath(new URL('../migrate-reading-progress-sources.ts', import.meta.url));
const timerMigrationPath = fileURLToPath(new URL('../migrate-timer-claims.ts', import.meta.url));
const auditPath = fileURLToPath(new URL('../db-audit.ts', import.meta.url));
const phantomUid = `phantom-timer-migration-${Date.now()}`;
const phantomUserRef = db.doc(`users/${phantomUid}`);

after(async () => {
  await Promise.all([
    db.recursiveDelete(userRef),
    db.recursiveDelete(phantomUserRef),
  ]);
});

function runScript(scriptPath: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {...process.env},
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('progress-source migration dry-runs, applies, and is idempotent in Firestore', async () => {
  const bookRef = userRef.collection('books').doc('legacy');
  await userRef.set({uid, email: `${uid}@example.test`});
  await bookRef.set({currentPage: 20});
  await Promise.all([
    bookRef.collection('updates').doc('older-reading').set({
      type: 'reading', toPage: 20, createdAt: Timestamp.fromMillis(1),
    }),
    bookRef.collection('updates').doc('newer-correction').set({
      type: 'update', toPage: 20, createdAt: Timestamp.fromMillis(2),
    }),
  ]);

  assert.match(runScript(migrationPath), new RegExp(`DRY users/${uid}/books/legacy`));
  assert.equal((await bookRef.get()).data()?.currentPageUpdateId, undefined);

  assert.match(runScript(migrationPath, '--apply'), new RegExp(`MIGRATE users/${uid}/books/legacy`));
  assert.equal((await bookRef.get()).data()?.currentPageUpdateId, 'newer-correction');

  assert.match(runScript(migrationPath, '--apply'), /0 books migrated/);

  await db.recursiveDelete(userRef);
});

test('timer and progress migrations and audit traverse books beneath a missing user document', async () => {
  const bookRef = phantomUserRef.collection('books').doc('legacy');
  const baselineBookRef = phantomUserRef.collection('books').doc('unexplained-baseline');
  const start = '2026-08-25T12:00:00.000Z';
  await bookRef.set({activeTimer: {start}, currentPage: 20});
  await baselineBookRef.set({currentPage: 12, currentPageUpdateId: null});
  await bookRef.collection('updates').doc('phantom-reading').set({
    type: 'reading', toPage: 20, createdAt: Timestamp.fromMillis(1),
  });
  assert.equal((await phantomUserRef.get()).exists, false);

  const auditBefore = runScript(auditPath);
  assert.match(auditBefore, new RegExp(`orphan\\.user users/${phantomUid}`));
  assert.match(
    auditBefore,
    new RegExp(`timer-lifecycle\\.missing users/${phantomUid}/timerLifecycle/current`),
  );
  assert.match(
    auditBefore,
    new RegExp(
      `book\\.progress-source-null-baseline users/${phantomUid}/books/unexplained-baseline ` +
      '\\[page 12 has no establishing update\\]',
    ),
  );
  assert.match(auditBefore, /^user-documents: 0$/m);
  assert.match(auditBefore, /^user-refs: 1$/m);
  assert.match(auditBefore, /^phantom-users: 1$/m);

  assert.match(runScript(timerMigrationPath), new RegExp(`DRY users/${phantomUid} timer=local`));
  assert.equal((await phantomUserRef.collection('timerLifecycle').doc('current').get()).exists, false);

  assert.match(runScript(timerMigrationPath, '--apply'), new RegExp(`MIGRATE users/${phantomUid} timer=local`));
  const migratedBook = (await bookRef.get()).data();
  const lifecycle = (await phantomUserRef.collection('timerLifecycle').doc('current').get()).data();
  assert.equal(typeof migratedBook?.activeTimer.operationId, 'string');
  assert.deepEqual(lifecycle, {
    version: 1,
    state: 'local',
    bookId: 'legacy',
    operationId: migratedBook?.activeTimer.operationId,
    start,
  });
  assert.equal((await phantomUserRef.get()).exists, false);
  assert.match(runScript(timerMigrationPath, '--apply'), /0 users migrated/);

  assert.match(
    runScript(migrationPath),
    new RegExp(`DRY users/${phantomUid}/books/legacy currentPageUpdateId=phantom-reading`),
  );
  assert.equal((await bookRef.get()).data()?.currentPageUpdateId, undefined);
  assert.match(
    runScript(migrationPath, '--apply'),
    new RegExp(`MIGRATE users/${phantomUid}/books/legacy currentPageUpdateId=phantom-reading`),
  );
  assert.equal((await bookRef.get()).data()?.currentPageUpdateId, 'phantom-reading');
  assert.match(runScript(migrationPath, '--apply'), /0 books migrated/);

  const auditAfter = runScript(auditPath);
  assert.match(auditAfter, new RegExp(`orphan\\.user users/${phantomUid}`));
  assert.doesNotMatch(
    auditAfter,
    new RegExp(`timer-lifecycle\\.missing users/${phantomUid}/timerLifecycle/current`),
  );
  assert.doesNotMatch(
    auditAfter,
    new RegExp(`book\\.missing\\.currentPageUpdateId users/${phantomUid}/books/legacy`),
  );
  assert.match(
    auditAfter,
    new RegExp(
      `book\\.progress-source-null-baseline users/${phantomUid}/books/unexplained-baseline ` +
      '\\[page 12 has no establishing update\\]',
    ),
  );
});
