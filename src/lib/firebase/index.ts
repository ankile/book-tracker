import { initializeApp } from 'firebase/app';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { browser } from '$app/environment';

const firebaseConfig = {
  apiKey: "AIzaSyCf5oh1h3ySg7M31dSpo1YDwVxQDhGR4Es",
  authDomain: "book-tracker-d8f24.firebaseapp.com",
  databaseURL: "https://book-tracker-d8f24.firebaseio.com",
  projectId: "book-tracker-d8f24",
  storageBucket: "book-tracker-d8f24.appspot.com",
  messagingSenderId: "440931185227",
  appId: "1:440931185227:web:950c6941a7471876e8d3ce",
  measurementId: "G-R4HGQYGQJH",
};

// Initialize Firebase
export const app = initializeApp(firebaseConfig);

// App Check (SEC-014): attach a reCAPTCHA Enterprise attestation to every
// Firestore and callable request this app makes. Monitor phase first — the
// backends stay UNENFORCED until the appcheck.monitor lines and the
// Firestore App Check metrics show the genuine clients presenting tokens —
// then enforcement makes an anonymous scripted invocation cheap to refuse
// (SEC-068). The site key is a public identifier, like the API key above.
// Emulator runs skip App Check (nothing verifies tokens there); plain dev
// against production uses the SDK's debug provider. Enforcement is ON
// (2026-08-30), so dev must present a debug token that is registered in
// App Check: `.env.local` (gitignored) carries the registered one as
// VITE_APPCHECK_DEBUG_TOKEN; without it the SDK mints a fresh token and
// prints it to the console, and every request is refused until that
// token is registered too. Never commit a debug token — this repo is
// public and a registered token bypasses attestation for whoever holds it.
if (browser && !(import.meta.env.DEV && import.meta.env.VITE_EMULATOR)) {
  if (import.meta.env.DEV) {
    (globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string }).FIREBASE_APPCHECK_DEBUG_TOKEN =
      import.meta.env.VITE_APPCHECK_DEBUG_TOKEN ?? true;
  }
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider('6Ldbm58tAAAAAGj4KhxJlm4yagS848O6dBg47p8_'),
    isTokenAutoRefreshEnabled: true,
  });
}
