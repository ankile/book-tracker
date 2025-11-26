import { writable } from 'svelte/store';
import { 
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut
} from 'firebase/auth';
import { auth } from './index.js';
import { browser } from '$app/environment';

// Create a store for the current user
function createUserStore() {
  const { subscribe, set } = writable(null);

  // Only set up auth listener in browser
  if (browser) {
    onAuthStateChanged(auth, (user) => {
      set(user);
    });
  }

  return {
    subscribe,
  };
}

export const user = createUserStore();

// Auth helper functions
export async function signIn(email, password) {
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (error) {
    console.error('Sign in error:', error);
    throw error;
  }
}

export async function signUp(email, password) {
  try {
    await createUserWithEmailAndPassword(auth, email, password);
  } catch (error) {
    console.error('Sign up error:', error);
    throw error;
  }
}

export async function signOut() {
  try {
    await firebaseSignOut(auth);
  } catch (error) {
    console.error('Sign out error:', error);
    throw error;
  }
}
