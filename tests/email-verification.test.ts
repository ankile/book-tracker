import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  RESEND_COOLDOWN_MS,
  canResend,
  verificationEmailSettings,
} from '../src/lib/firebase/emailVerification.ts';

test('the verification email only ever carries this app\'s own origin', () => {
  assert.deepEqual(verificationEmailSettings('https://book.ankile.com'), {
    url: 'https://book.ankile.com/',
    handleCodeInApp: false,
  });
  assert.equal(verificationEmailSettings('http://localhost:5173').url, 'http://localhost:5173/');
  assert.equal(verificationEmailSettings('http://127.0.0.1:4173').url, 'http://127.0.0.1:4173/');
  for (const origin of [
    'http://book.ankile.com',
    'https://book.ankile.com/somewhere',
    'https://evil.example?x=book.ankile.com',
    'javascript:alert(1)',
    '',
  ]) {
    assert.throws(() => verificationEmailSettings(origin), /Refusing to put/, origin);
  }
});

test('resend waits out the cooldown after a send', () => {
  assert.equal(canResend(null, 1_000), true);
  assert.equal(canResend(1_000, 1_000 + RESEND_COOLDOWN_MS - 1), false);
  assert.equal(canResend(1_000, 1_000 + RESEND_COOLDOWN_MS), true);
});

// The Svelte side cannot run under node:test; pin the wiring instead.
const authSource = readFileSync('src/lib/firebase/auth.ts', 'utf8');
const layoutSource = readFileSync('src/routes/+layout.svelte', 'utf8');
const bannerSource = readFileSync('src/lib/components/EmailVerificationBanner.svelte', 'utf8');
const meSource = readFileSync('src/routes/me/+page.svelte', 'utf8');

test('sign-up sends the verification email to the account it just created', () => {
  assert.match(
    authSource,
    /const credential = await createUserWithEmailAndPassword\(auth, email, password\);[\s\S]*?await sendVerificationEmail\(credential\.user, window\.location\.origin\);/,
  );
});

test('confirming verification re-emits the user so templates see the new claim', () => {
  assert.match(
    authSource,
    /const verified = await refreshVerification\(signedInUser\(\)\);\s*if \(verified\) user\.reemit\(\);\s*return verified;/,
  );
});

test('every signed-in page shows the banner to an unverified account', () => {
  assert.match(layoutSource, /import EmailVerificationBanner from '\$lib\/components\/EmailVerificationBanner\.svelte';/);
  assert.match(layoutSource, /\{#if \$user\}\s*<Navbar \/>\s*<EmailVerificationBanner \/>/);
  assert.match(bannerSource, /\{#if \$user && !\$user\.emailVerified\}/);
  assert.match(bannerSource, /onclick=\{check\}/);
  assert.match(bannerSource, /onclick=\{resend\}/);
  assert.match(bannerSource, /await confirmEmailVerified\(\)/);
  assert.match(bannerSource, /await resendVerificationEmail\(\)/);
  // Accounts from before verification existed never received a link, so
  // the button must read as a first send, not only a resend.
  assert.match(bannerSource, /or request a new one/);
  assert.match(bannerSource, />\s*Send verification email\s*</);
});

test('the profile page no longer tells an unverified user the app cannot verify them', () => {
  assert.doesNotMatch(meSource, /cannot verify it yet/);
  assert.match(meSource, /verification email/);
});
