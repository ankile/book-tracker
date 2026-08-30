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
// against production uses the SDK's debug provider, which prints a token
// to the console — register it in App Check before enforcement or dev
// requests will be refused.
if (browser && !(import.meta.env.DEV && import.meta.env.VITE_EMULATOR)) {
  if (import.meta.env.DEV) {
    (globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider('6Ldbm58tAAAAAGj4KhxJlm4yagS848O6dBg47p8_'),
    isTokenAutoRefreshEnabled: true,
  });
}
