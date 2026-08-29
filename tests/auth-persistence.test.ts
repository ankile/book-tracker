import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const authSource = readFileSync('src/lib/firebase/auth.ts', 'utf8');

test('auth initialization does not rewrite shared persistence on every tab load', () => {
  assert.doesNotMatch(authSource, /\bsetPersistence\s*\(/);
  assert.doesNotMatch(authSource, /\bauthPersistenceReady\b/);
  assert.match(
    authSource,
    /initializeAuth\(app,\s*\{[\s\S]*?persistence:\s*browserLocalPersistence,[\s\S]*?popupRedirectResolver:\s*undefined,[\s\S]*?\}\)/,
  );
});

test('admin password reauthentication refreshes auth_time through a real credential check', () => {
  assert.match(authSource, /EmailAuthProvider\.credential\(currentUser\.email, password\)/);
  assert.match(authSource, /await reauthenticateWithCredential\(currentUser, credential\)/);
  assert.match(authSource, /await currentUser\.getIdToken\(true\)/);
  assert.match(authSource, /currentUser === null \|\| currentUser\.email === null/);
});
