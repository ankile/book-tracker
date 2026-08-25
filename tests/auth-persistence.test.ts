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
