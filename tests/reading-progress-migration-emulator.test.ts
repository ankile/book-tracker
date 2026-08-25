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

after(() => db.recursiveDelete(userRef));

function runMigration(...args: string[]) {
  const result = spawnSync(process.execPath, [migrationPath, ...args], {
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

  assert.match(runMigration(), new RegExp(`DRY users/${uid}/books/legacy`));
  assert.equal((await bookRef.get()).data()?.currentPageUpdateId, undefined);

  assert.match(runMigration('--apply'), new RegExp(`MIGRATE users/${uid}/books/legacy`));
  assert.equal((await bookRef.get()).data()?.currentPageUpdateId, 'newer-correction');

  assert.match(runMigration('--apply'), /0 books migrated/);
});
