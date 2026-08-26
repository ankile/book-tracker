import './setup.ts';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {deleteApp as deleteAdminApp, initializeApp as initializeAdminApp} from 'firebase-admin/app';
import {getStorage as getAdminStorage} from 'firebase-admin/storage';
import {deleteApp, initializeApp} from 'firebase/app';
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
} from 'firebase/auth';
import {
  connectStorageEmulator,
  getBytes,
  getStorage,
  ref,
  uploadBytes,
} from 'firebase/storage';

test('Storage emulator denies dummy reads and writes before and after authentication', async (t) => {
  const projectId = 'book-tracker-rules-test';
  const app = initializeApp({
    projectId,
    apiKey: 'dummy-api-key',
    storageBucket: `${projectId}.firebasestorage.app`,
  }, randomUUID());
  t.after(() => deleteApp(app));
  const auth = getAuth(app);
  const storage = getStorage(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', {disableWarnings: true});
  connectStorageEmulator(storage, '127.0.0.1', 9199);
  const object = ref(storage, `security-review/${randomUUID()}.txt`);
  const dummyData = new TextEncoder().encode('dummy security review payload');
  process.env.STORAGE_EMULATOR_HOST = 'http://127.0.0.1:9199';
  const admin = initializeAdminApp({projectId, storageBucket: `${projectId}.firebasestorage.app`}, randomUUID());
  t.after(async () => {
    delete process.env.STORAGE_EMULATOR_HOST;
    await deleteAdminApp(admin);
  });
  await getAdminStorage(admin).bucket().file(object.fullPath).save(dummyData);

  await assert.rejects(getBytes(object), /storage\/unauthorized/);
  await assert.rejects(uploadBytes(object, dummyData), /storage\/unauthorized/);
  await createUserWithEmailAndPassword(
    auth,
    `${randomUUID()}@example.test`,
    'dummy-test-password',
  );
  await assert.rejects(getBytes(object), /storage\/unauthorized/);
  await assert.rejects(uploadBytes(object, dummyData), /storage\/unauthorized/);
});
