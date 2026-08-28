import assert from 'node:assert/strict';
import test from 'node:test';
import { FirebaseError } from 'firebase/app';
import { describeAuthFailure, runAuthAttempt } from '../src/lib/utils/authFailure.ts';

test('Firebase auth failures expose code-based copy and nothing else', () => {
  const error = new FirebaseError(
    'auth/invalid-credential',
    'Internal text that could contain password=Secret1@example.com',
  );

  assert.deepEqual(describeAuthFailure(error), {
    userMessage: 'The email address or password is incorrect.',
  });
});

test('password input and policy failures have actionable copy', () => {
  assert.equal(
    describeAuthFailure(
      new FirebaseError('auth/user-disabled', 'unsafe raw text'),
    ).userMessage,
    'This account has been disabled. Contact the administrator for help.',
  );
  assert.equal(
    describeAuthFailure(
      new FirebaseError('auth/missing-password', 'unsafe raw text'),
    ).userMessage,
    'Enter a password.',
  );
  assert.equal(
    describeAuthFailure(
      new FirebaseError('auth/password-does-not-meet-requirements', 'unsafe raw text'),
    ).userMessage,
    'Passwords must be at least 12 characters.',
  );
  assert.equal(
    describeAuthFailure(
      new FirebaseError('auth/email-already-in-use', 'Email is already in use.'),
    ).userMessage,
    'An account already exists for this email address.',
  );
});

test('unexpected Errors use generic copy without exposing their message', () => {
  const failure = describeAuthFailure(new Error('password=Secret1@example.com'));

  assert.deepEqual(failure, { userMessage: 'Something went wrong. Please try again.' });
  assert.doesNotMatch(JSON.stringify(failure), /Secret1/);
});

test('unknown Firebase codes use generic copy', () => {
  for (const code of ['auth/new-code', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.deepEqual(
      describeAuthFailure(new FirebaseError(code, 'password=Secret1@example.com')),
      { userMessage: 'Something went wrong. Please try again.' },
      code,
    );
  }
});

test('non-Error throws receive a generic visible message', () => {
  for (const error of [null, undefined, 'failed', { password: 'do not display' }]) {
    assert.deepEqual(describeAuthFailure(error), {
      userMessage: 'Something went wrong. Please try again.',
    });
  }
});

test('one captured auth attempt runs at a time', async () => {
  const state = { pending: false };
  let rejectAttempt!: (error: unknown) => void;
  let calls = 0;
  const first = runAuthAttempt(state, () => {
    calls += 1;
    return new Promise<void>((_resolve, reject) => {
      rejectAttempt = reject;
    });
  });

  assert.equal(state.pending, true);
  assert.deepEqual(
    await runAuthAttempt(state, async () => {
      calls += 1;
    }),
    { status: 'ignored' },
  );
  assert.equal(calls, 1);

  rejectAttempt(new FirebaseError('auth/invalid-credential', 'unsafe raw text'));
  assert.deepEqual(await first, {
    status: 'failed',
    failure: { userMessage: 'The email address or password is incorrect.' },
  });
  assert.equal(state.pending, false);
});

test('a successful auth attempt releases the pending state', async () => {
  const state = { pending: false };

  assert.deepEqual(await runAuthAttempt(state, async () => {}), {
    status: 'succeeded',
  });
  assert.equal(state.pending, false);
});
