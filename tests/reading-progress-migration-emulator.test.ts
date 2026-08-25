import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test, {after} from 'node:test';
import {fileURLToPath} from 'node:url';
import {initializeApp} from 'firebase-admin/app';
import {getFirestore, Timestamp} from 'firebase-admin/firestore';

process.env.GCLOUD_PROJECT = 'book-tracker-d8f24';
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

test('timer migration and audit traverse books beneath a missing user document', async () => {
  const bookRef = phantomUserRef.collection('books').doc('legacy');
  await bookRef.set({activeTimer: null});
  assert.equal((await phantomUserRef.get()).exists, false);

  const auditBefore = runScript(auditPath);
  assert.match(auditBefore, new RegExp(`orphan\\.user users/${phantomUid}`));
  assert.match(
    auditBefore,
    new RegExp(`timer-lifecycle\\.missing users/${phantomUid}/timerLifecycle/current`),
  );

  assert.match(runScript(timerMigrationPath), new RegExp(`DRY users/${phantomUid} timer=idle`));
  assert.equal((await phantomUserRef.collection('timerLifecycle').doc('current').get()).exists, false);

  assert.match(runScript(timerMigrationPath, '--apply'), new RegExp(`MIGRATE users/${phantomUid} timer=idle`));
  assert.equal(
    (await phantomUserRef.collection('timerLifecycle').doc('current').get()).data()?.state,
    'idle',
  );
  assert.match(runScript(timerMigrationPath, '--apply'), /0 users migrated/);

  const auditAfter = runScript(auditPath);
  assert.match(auditAfter, new RegExp(`orphan\\.user users/${phantomUid}`));
  assert.doesNotMatch(
    auditAfter,
    new RegExp(`timer-lifecycle\\.missing users/${phantomUid}/timerLifecycle/current`),
  );
});
