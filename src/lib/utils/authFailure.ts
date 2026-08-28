import { FirebaseError } from 'firebase/app';

export type AuthOperation = 'sign_in' | 'sign_up';

export interface AuthFailureIssue {
  level: 'warn' | 'error';
  event: `auth.${AuthOperation}_failed`;
  message: string;
  code: string;
  detail: null;
}

export interface AuthFailureDescription {
  userMessage: string;
  issue: AuthFailureIssue | null;
}

export interface AuthAttemptState {
  pending: boolean;
}

export type AuthAttemptResult =
  | { status: 'succeeded' }
  | { status: 'failed'; failure: AuthFailureDescription }
  | { status: 'ignored' };

const GENERIC_AUTH_FAILURE = 'Something went wrong. Please try again.';
const AUTH_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  'auth/email-already-in-use': 'An account already exists for this email address.',
  'auth/invalid-credential': 'The email address or password is incorrect.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/network-request-failed': 'Could not reach the authentication service. Please try again.',
  'auth/missing-password': 'Enter a password.',
  'auth/operation-not-allowed': 'This authentication method is not available.',
  'auth/password-does-not-meet-requirements': 'The password does not meet the account requirements.',
  'auth/too-many-requests': 'Too many attempts. Please wait and try again.',
  'auth/user-disabled': 'This account has been disabled. Contact the administrator for help.',

  'auth/admin-restricted-operation': 'This action is not available. Contact the administrator for help.',
  'auth/user-not-found': 'The email address or password is incorrect.',
  'auth/weak-password': 'Choose a stronger password and try again.',
  'auth/wrong-password': 'The email address or password is incorrect.',
};

export function describeAuthFailure(
  error: unknown,
  operation: AuthOperation,
): AuthFailureDescription {
  if (!(error instanceof FirebaseError)) {
    return {
      userMessage: GENERIC_AUTH_FAILURE,
      issue: {
        level: 'error',
        event: `auth.${operation}_failed`,
        message: 'Authentication request failed outside Firebase.',
        code: 'non-firebase-error',
        detail: null,
      },
    };
  }

  return {
    userMessage: AUTH_FAILURE_MESSAGES[error.code] ?? GENERIC_AUTH_FAILURE,
    issue: {
      level: 'warn',
      event: `auth.${operation}_failed`,
      message: 'Authentication request failed.',
      code: error.code,
      detail: null,
    },
  };
}

export async function runAuthAttempt(
  state: AuthAttemptState,
  operation: AuthOperation,
  authenticate: () => Promise<void>,
): Promise<AuthAttemptResult> {
  if (state.pending) return { status: 'ignored' };
  state.pending = true;
  try {
    await authenticate();
    return { status: 'succeeded' };
  } catch (error) {
    return { status: 'failed', failure: describeAuthFailure(error, operation) };
  } finally {
    state.pending = false;
  }
}
