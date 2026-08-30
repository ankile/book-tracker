import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// SEC-014: the enforcement flip will refuse any client that does not
// attest, so the one place that initializes App Check is pinned here —
// reverting it would strand every production client the moment
// enforcement lands, with no compile error.
const indexSource = readFileSync('src/lib/firebase/index.ts', 'utf8');

test('the browser client initializes App Check with the reCAPTCHA Enterprise key', () => {
  assert.match(
    indexSource,
    /initializeAppCheck\(app,\s*\{\s*provider:\s*new ReCaptchaEnterpriseProvider\('6Ldbm58tAAAAAGj4KhxJlm4yagS848O6dBg47p8_'\),\s*isTokenAutoRefreshEnabled:\s*true,\s*\}\)/,
  );
});

test('App Check runs in every browser context except emulator runs', () => {
  // The emulator suite never verifies tokens, so those runs skip App
  // Check; every other browser context (prod, preview, plain dev) must
  // attest or enforcement will refuse it.
  assert.match(
    indexSource,
    /if \(browser && !\(import\.meta\.env\.DEV && import\.meta\.env\.VITE_EMULATOR\)\) \{/,
  );
});

test('only dev builds use the App Check debug token', () => {
  // In production the debug flag would let anyone mint tokens from the
  // console; it must stay behind the DEV check.
  const flag = /FIREBASE_APPCHECK_DEBUG_TOKEN/g;
  assert.equal(indexSource.match(flag)?.length, 2, 'the debug flag appears in its type and its assignment only');
  assert.match(
    indexSource,
    /if \(import\.meta\.env\.DEV\) \{\s*\(globalThis as \{ FIREBASE_APPCHECK_DEBUG_TOKEN\?: boolean \}\)\.FIREBASE_APPCHECK_DEBUG_TOKEN = true;\s*\}/,
  );
});
