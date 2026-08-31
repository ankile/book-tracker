import { getIdToken, getIdTokenResult, reload, sendEmailVerification } from 'firebase/auth';
import type { ActionCodeSettings, User } from 'firebase/auth';

// Kept free of $app imports so the Auth emulator can exercise it directly
// (tests/email-verification-emulator.test.ts); auth.ts supplies the origin.

// Where the link in the email sends the user once Firebase's hosted action
// page has applied the code. Only this app's own origin may go into an
// email: the value is user-visible, and a wrong one is a phishing link
// with our name on it — so anything but https (or a loopback dev server)
// crashes here instead of being mailed out.
export function verificationEmailSettings(origin: string): ActionCodeSettings {
  if (!/^(?:https:\/\/[a-z0-9.-]+|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)$/.test(origin)) {
    throw new Error(`Refusing to put ${origin} in a verification email.`);
  }
  return { url: `${origin}/`, handleCodeInApp: false };
}

export async function sendVerificationEmail(user: User, origin: string): Promise<void> {
  await sendEmailVerification(user, verificationEmailSettings(origin));
}

// The account record and the ID token are separate things: reload() pulls
// the record, where emailVerified flips the moment the link is used, but
// the token minted at sign-in keeps its old email_verified claim for up to
// an hour — and Rules and callables read the claim. So a confirmed
// verification forces a token refresh before reporting success.
export async function refreshVerification(user: User): Promise<boolean> {
  await reload(user);
  if (!user.emailVerified) return false;
  await getIdToken(user, true);
  return true;
}

// The SDK reloads the persisted account record on every page load
// (initializeCurrentUser -> _reloadWithoutSaving) but keeps the cached ID
// token, so an account that used its link in another tab comes back with
// emailVerified true on the record and email_verified false in the token
// for up to an hour: the banner hides, and every Rules check still denies
// (seen in prod 2026-08-31 on the first test account). Called for every
// signed-in user the store sees; when the two disagree it forces a fresh
// token, which Firestore picks up through its own token listener.
export async function syncVerifiedClaim(user: User): Promise<boolean> {
  const { claims } = await getIdTokenResult(user);
  if (!user.emailVerified || claims.email_verified === true) return false;
  await getIdToken(user, true);
  return true;
}

// Firebase rate-limits sends per account (auth/too-many-requests); the
// button-side cooldown keeps an impatient user from running into it.
export const RESEND_COOLDOWN_MS = 60_000;

export function canResend(lastSentAt: number | null, now: number): boolean {
  return lastSentAt === null || now - lastSentAt >= RESEND_COOLDOWN_MS;
}
