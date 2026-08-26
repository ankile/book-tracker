import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {deleteApp, initializeApp} from 'firebase/app';
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
} from 'firebase/auth';
import {
  connectStorageEmulator,
  getStorage,
  ref,
  uploadBytes,
} from 'firebase/storage';

test('Storage emulator denies dummy uploads before and after authentication', async (t) => {
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

  await assert.rejects(uploadBytes(object, dummyData), /storage\/unauthorized/);
  await createUserWithEmailAndPassword(
    auth,
    `${randomUUID()}@example.test`,
    'dummy-test-password',
  );
  await assert.rejects(uploadBytes(object, dummyData), /storage\/unauthorized/);
});
