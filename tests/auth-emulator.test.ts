import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { deleteApp, FirebaseError, initializeApp } from 'firebase/app';
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { describeAuthFailure } from '../src/lib/utils/authFailure.ts';

test('a real Auth emulator rejection reaches the safe failure classifier', async () => {
  const app = initializeApp({ projectId: 'book-tracker-rules-test', apiKey: 'test-key' }, randomUUID());
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const email = `${randomUUID()}@example.com`;

  await createUserWithEmailAndPassword(auth, email, 'valid-test-password');
  await signOut(auth);
  let failure: FirebaseError | null = null;
  await assert.rejects(
    signInWithEmailAndPassword(auth, email, 'wrong-test-password'),
    (error: unknown) => {
      assert.ok(error instanceof FirebaseError);
      failure = error;
      return true;
    },
  );

  assert.ok(failure);
  const description = describeAuthFailure(failure, 'sign_in');
  assert.equal(description.userMessage, 'The email address or password is incorrect.');
  assert.equal(description.issue?.event, 'auth.sign_in_failed');
  assert.equal(description.issue?.detail, null);
  await deleteApp(app);
});
