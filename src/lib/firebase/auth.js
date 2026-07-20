import { writable } from 'svelte/store';
import {
  browserLocalPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut
} from 'firebase/auth';
import { auth } from './index.js';
import { browser } from '$app/environment';

const authPersistenceReady = browser
  ? setPersistence(auth, browserLocalPersistence)
  : null;

function createUserStore() {
  // `undefined` means Firebase is still restoring the persisted session.
  // Once resolved, the value is either `null` (signed out) or a Firebase user.
  const { subscribe, set } = writable(undefined);

  if (browser) {
    onAuthStateChanged(auth, set);
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
