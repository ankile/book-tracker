import { writable } from 'svelte/store';
import type { Readable } from 'svelte/store';
import type { User } from 'firebase/auth';
import {
  connectAuthEmulator,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut
} from 'firebase/auth';
import { app } from './index.ts';
import { browser } from '$app/environment';
import { clearErrors } from '../stores/errors.ts';

// getAuth's browser default is already persistent local auth. Do not call
// setPersistence during module startup: that operation temporarily removes the
// shared user and can make a Firestore multi-tab primary reject another tab's
// listeners during reload.
export const auth = getAuth(app);

// Migration-rehearsal hook, paired with the one in db.ts.
if (import.meta.env.DEV && import.meta.env.VITE_EMULATOR) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
}

function createUserStore(): Readable<User | null | undefined> {
  // `undefined` means Firebase is still restoring the persisted session.
  // Once resolved, the value is either `null` (signed out) or a Firebase user.
  const { subscribe, set } = writable<User | null | undefined>(undefined);

  if (browser) {
    onAuthStateChanged(auth, (u) => {
      clearErrors();
      set(u);
    });
  }

  return {
    subscribe,
  };
}

export const user = createUserStore();

export async function signIn(email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(auth, email, password);
}

export async function signUp(email: string, password: string): Promise<void> {
  await createUserWithEmailAndPassword(auth, email, password);
}

export async function signOut(): Promise<void> {
  await firebaseSignOut(auth);
}
