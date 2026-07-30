import { writable } from 'svelte/store';
import {
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut
} from 'firebase/auth';
import { app } from './index.js';
import { browser } from '$app/environment';
import { clearErrors } from '../stores/errors.js';

export const auth = getAuth(app);

const authPersistenceReady = browser
  ? setPersistence(auth, browserLocalPersistence)
  : null;

function createUserStore() {
  // `undefined` means Firebase is still restoring the persisted session.
  // Once resolved, the value is either `null` (signed out) or a Firebase user.
  const { subscribe, set } = writable(undefined);

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

export async function signIn(email, password) {
  await authPersistenceReady;
  await signInWithEmailAndPassword(auth, email, password);
}

export async function signUp(email, password) {
  await authPersistenceReady;
  await createUserWithEmailAndPassword(auth, email, password);
}

export async function signOut() {
  await firebaseSignOut(auth);
}
