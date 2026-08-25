import assert from 'node:assert/strict';
import test from 'node:test';
import { FirebaseError } from 'firebase/app';
import { describeAuthFailure, runAuthAttempt } from '../src/lib/utils/authFailure.ts';

test('Firebase auth failures expose code-based copy without logging user input', () => {
  const error = new FirebaseError(
    'auth/invalid-credential',
    'Internal text that could contain password=Secret1@example.com',
  );

  assert.deepEqual(describeAuthFailure(error, 'sign_in'), {
    userMessage: 'The email address or password is incorrect.',
    issue: {
      level: 'warn',
      event: 'auth.sign_in_failed',
      message: 'Authentication request failed.',
      code: 'auth/invalid-credential',
      detail: null,
    },
  });
});

test('sign-up failures use the sign-up issue event', () => {
  const failure = describeAuthFailure(
    new FirebaseError('auth/email-already-in-use', 'Email is already in use.'),
    'sign_up',
  );

  assert.equal(failure.issue?.event, 'auth.sign_up_failed');
});

test('password input and policy failures have actionable copy', () => {
  assert.equal(
    describeAuthFailure(
      new FirebaseError('auth/user-disabled', 'unsafe raw text'),
      'sign_in',
    ).userMessage,
    'This account has been disabled. Contact the administrator for help.',
  );
  assert.equal(
    describeAuthFailure(
      new FirebaseError('auth/missing-password', 'unsafe raw text'),
      'sign_in',
    ).userMessage,
    'Enter a password.',
  );
  assert.equal(
    describeAuthFailure(
      new FirebaseError('auth/password-does-not-meet-requirements', 'unsafe raw text'),
      'sign_up',
    ).userMessage,
    'The password does not meet the account requirements.',
  );
});

test('unexpected Errors use generic copy without exposing their message', () => {
  const failure = describeAuthFailure(
    new Error('password=Secret1@example.com'),
    'sign_in',
  );

  assert.deepEqual(failure, {
    userMessage: 'Something went wrong. Please try again.',
    issue: {
      level: 'error',
      event: 'auth.sign_in_failed',
      message: 'Authentication request failed outside Firebase.',
      code: 'non-firebase-error',
      detail: null,
    },
  });
  assert.doesNotMatch(JSON.stringify(failure), /Secret1/);
});

test('unknown Firebase codes use generic copy and fixed telemetry', () => {
  const failure = describeAuthFailure(
    new FirebaseError('auth/new-code', 'password=Secret1@example.com'),
    'sign_in',
  );

  assert.equal(failure.userMessage, 'Something went wrong. Please try again.');
  assert.equal(failure.issue?.message, 'Authentication request failed.');
  assert.equal(failure.issue?.detail, null);
});

test('non-Error throws receive a generic visible message', () => {
  for (const error of [null, undefined, 'failed', { password: 'do not display' }]) {
    assert.deepEqual(describeAuthFailure(error, 'sign_in'), {
      userMessage: 'Something went wrong. Please try again.',
      issue: {
        level: 'error',
        event: 'auth.sign_in_failed',
        message: 'Authentication request failed outside Firebase.',
        code: 'non-firebase-error',
        detail: null,
      },
    });
  }
});

test('one captured auth attempt runs at a time and owns its failure operation', async () => {
  const state = { pending: false };
  let rejectAttempt!: (error: unknown) => void;
  let calls = 0;
  const first = runAuthAttempt(state, 'sign_in', () => {
    calls += 1;
    return new Promise<void>((_resolve, reject) => {
      rejectAttempt = reject;
    });
  });

  assert.equal(state.pending, true);
  assert.deepEqual(
    await runAuthAttempt(state, 'sign_up', async () => {
      calls += 1;
    }),
    { status: 'ignored' },
  );
  assert.equal(calls, 1);

  rejectAttempt(new FirebaseError('auth/invalid-credential', 'unsafe raw text'));
  const result = await first;
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') {
    assert.equal(result.failure.issue?.event, 'auth.sign_in_failed');
  }
  assert.equal(state.pending, false);
});

test('a successful auth attempt releases the pending state', async () => {
  const state = { pending: false };

  assert.deepEqual(await runAuthAttempt(state, 'sign_up', async () => {}), {
    status: 'succeeded',
  });
  assert.equal(state.pending, false);
});
