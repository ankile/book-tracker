import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {deleteApp, initializeApp} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';

const setupPath = fileURLToPath(new URL('./setup.ts', import.meta.url));

function assertedEnvironment(source: NodeJS.ProcessEnv): void {
  assert.equal(source.GCLOUD_PROJECT, 'book-tracker-test');
  assert.equal(source.GOOGLE_CLOUD_PROJECT, 'book-tracker-test');
  assert.deepEqual(JSON.parse(source.FIREBASE_CONFIG ?? ''), {projectId: 'book-tracker-test'});
  assert.match(source.FIRESTORE_EMULATOR_HOST ?? '', /^(?:127\.0\.0\.1|localhost):\d+$/);
  assert.match(source.FIREBASE_AUTH_EMULATOR_HOST ?? '', /^(?:127\.0\.0\.1|localhost):\d+$/);
  assert.match(source.GOOGLE_APPLICATION_CREDENTIALS ?? '', /credentials-do-not-exist\.json$/);
}

test('every root test process starts inside a non-production Firebase target', async () => {
  assertedEnvironment(process.env);

  const app = initializeApp({}, `containment-${Date.now()}`);
  assert.equal(Reflect.get(getFirestore(app), 'projectId'), 'book-tracker-test');
  await deleteApp(app);
});

test('the root preload replaces hostile inherited Firebase configuration', () => {
  const script = `console.log(JSON.stringify({
    GCLOUD_PROJECT: process.env.GCLOUD_PROJECT,
    GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
    FIREBASE_CONFIG: process.env.FIREBASE_CONFIG,
    FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
    FIREBASE_AUTH_EMULATOR_HOST: process.env.FIREBASE_AUTH_EMULATOR_HOST,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  }))`;
  const result = spawnSync(process.execPath, ['--import', setupPath, '--eval', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GCLOUD_PROJECT: 'book-tracker-d8f24',
      GOOGLE_CLOUD_PROJECT: 'book-tracker-d8f24',
      FIREBASE_CONFIG: JSON.stringify({projectId: 'book-tracker-d8f24'}),
      FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443',
      FIREBASE_AUTH_EMULATOR_HOST: 'identitytoolkit.googleapis.com:443',
      GOOGLE_APPLICATION_CREDENTIALS: '/real-looking-production-key.json',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assertedEnvironment(JSON.parse(result.stdout) as NodeJS.ProcessEnv);
});

test('Admin emulator tests contain direct single-file runs before Firebase imports', async () => {
  for (const relativePath of [
    './reading-progress-migration-emulator.test.ts',
    './toggl-transaction.test.ts',
  ]) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    assert.ok(
      source.startsWith("import './setup.ts';\n"),
      `${relativePath} must load the fail-closed Firebase setup first`,
    );
    assert.doesNotMatch(source, /process\.env\.GCLOUD_PROJECT\s*=\s*['"]book-tracker-d8f24['"]/);
  }
});
