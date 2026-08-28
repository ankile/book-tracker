import { FirebaseError } from 'firebase/app';

// Only the copy shown to the user. Failed sign-ins are deliberately not
// reported anywhere: before a session exists there is no caller to pin a
// row to, so recording them meant an unauthenticated write path (SEC-001),
// and the raw error text can carry what the user typed.
export interface AuthFailureDescription {
  userMessage: string;
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
  'auth/admin-restricted-operation': 'This action is not available. Contact the administrator for help.',
  'auth/email-already-in-use': 'An account already exists for this email address.',
  'auth/invalid-credential': 'The email address or password is incorrect.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/network-request-failed': 'Could not reach the authentication service. Please try again.',
  'auth/missing-password': 'Enter a password.',
  'auth/operation-not-allowed': 'This authentication method is not available.',
  'auth/password-does-not-meet-requirements': 'Passwords must be at least 12 characters.',
  'auth/too-many-requests': 'Too many attempts. Please wait and try again.',
  'auth/user-disabled': 'This account has been disabled. Contact the administrator for help.',
  'auth/user-not-found': 'The email address or password is incorrect.',
  'auth/weak-password': 'Choose a stronger password and try again.',
  'auth/wrong-password': 'The email address or password is incorrect.',
};

export function describeAuthFailure(error: unknown): AuthFailureDescription {
  if (!(error instanceof FirebaseError)) {
    return { userMessage: GENERIC_AUTH_FAILURE };
  }
  // hasOwn, not a bare lookup: a code named like an Object.prototype member
  // ("constructor") would otherwise resolve to a function, not copy.
  return {
    userMessage: Object.hasOwn(AUTH_FAILURE_MESSAGES, error.code)
      ? AUTH_FAILURE_MESSAGES[error.code]
      : GENERIC_AUTH_FAILURE,
  };
}

export async function runAuthAttempt(
  state: AuthAttemptState,
  authenticate: () => Promise<void>,
): Promise<AuthAttemptResult> {
  if (state.pending) return { status: 'ignored' };
  state.pending = true;
  try {
    await authenticate();
    return { status: 'succeeded' };
  } catch (error) {
    return { status: 'failed', failure: describeAuthFailure(error) };
  } finally {
    state.pending = false;
  }
}
