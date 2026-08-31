import { writable } from 'svelte/store';
import type { Readable } from 'svelte/store';
import type { User } from 'firebase/auth';
import {
  browserLocalPersistence,
  connectAuthEmulator,
  getAuth,
  initializeAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut
} from 'firebase/auth';
import { app } from './index.ts';
import { browser } from '$app/environment';
import { clearErrors } from '../stores/errors.ts';
import { refreshVerification, sendVerificationEmail, syncVerifiedClaim } from './emailVerification.ts';

// Pin the browser to the existing localStorage backend at initialization. Do
// not call setPersistence during module startup: that operation temporarily
// removes the shared user and can make a Firestore multi-tab primary reject
// another tab's listeners during reload. Pinning also avoids migrating an
// existing production session while an older bundle is still open in a tab.
export const auth = browser
  ? initializeAuth(app, {
      persistence: browserLocalPersistence,
      popupRedirectResolver: undefined,
    })
  : getAuth(app);

// Migration-rehearsal hook, paired with the one in db.ts.
if (import.meta.env.DEV && import.meta.env.VITE_EMULATOR) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
}

interface UserStore extends Readable<User | null | undefined> {
  // Firebase mutates the User object in place (reload, token refresh) and
  // onAuthStateChanged stays silent for that; re-emitting the same object
  // is how a changed property such as emailVerified reaches the templates.
  reemit(): void;
}

function createUserStore(): UserStore {
  // `undefined` means Firebase is still restoring the persisted session.
  // Once resolved, the value is either `null` (signed out) or a Firebase user.
  const { subscribe, set } = writable<User | null | undefined>(undefined);
  let current: User | null | undefined = undefined;

  if (browser) {
    onAuthStateChanged(auth, (u) => {
      clearErrors();
      current = u;
      set(u);
      // The record can say verified while the token still says not (see
      // syncVerifiedClaim); a stale claim is a Rules denial on every
      // verified-only path, so it is repaired here rather than left to the
      // hourly token rotation. A failure surfaces like any other auth
      // problem instead of being swallowed.
      if (u !== null) void syncVerifiedClaim(u).then((changed) => { if (changed) set(current); });
    });
  }

  return {
    subscribe,
    reemit: () => set(current),
  };
}

export const user = createUserStore();

export async function signIn(email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(auth, email, password);
}

export async function signUp(email: string, password: string): Promise<void> {
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  // The account exists and is signed in from here on. A failed send is
  // reported like any other auth failure, and the in-app banner offers a
  // resend, so the sign-up itself is never rolled back over it.
  await sendVerificationEmail(credential.user, window.location.origin);
}

function signedInUser(): User {
  const current = auth.currentUser;
  if (current === null) throw new Error('No signed-in user.');
  return current;
}

export async function resendVerificationEmail(): Promise<void> {
  await sendVerificationEmail(signedInUser(), window.location.origin);
}

// True once the account is verified AND the ID token carries the claim.
export async function confirmEmailVerified(): Promise<boolean> {
  const verified = await refreshVerification(signedInUser());
  if (verified) user.reemit();
  return verified;
}

export async function signOut(): Promise<void> {
  // A shared device must not keep this account's Firestore mirror —
  // books, sessions, the user document — readable in IndexedDB after
  // sign-out (SEC-004; sign-out used to leave the whole cache behind).
  // The clear runs even if the Auth sign-out throws, and always ends in
  // a reload, so a failure can never wedge a signed-out app with the
  // cache intact (review F2). Dynamic import: db.ts imports this module.
  try {
    await firebaseSignOut(auth);
  } finally {
    const { clearLocalData } = await import('./db.ts');
    await clearLocalData();
  }
}
