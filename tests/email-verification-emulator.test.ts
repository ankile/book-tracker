import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { deleteApp, initializeApp } from 'firebase/app';
import {
  applyActionCode,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  reload,
} from 'firebase/auth';
import { refreshVerification, sendVerificationEmail, syncVerifiedClaim } from '../src/lib/firebase/emailVerification.ts';

const PROJECT_ID = 'book-tracker-rules-test';
const AUTH_EMULATOR = 'http://127.0.0.1:9099';

interface OobCode {
  email: string;
  oobCode: string;
  oobLink: string;
  requestType: string;
}

// The emulator keeps every out-of-band email it would have sent.
async function oobCodesFor(email: string): Promise<OobCode[]> {
  const response = await fetch(`${AUTH_EMULATOR}/emulator/v1/projects/${PROJECT_ID}/oobCodes`);
  assert.ok(response.ok, `oobCodes ${response.status}`);
  const { oobCodes } = (await response.json()) as { oobCodes: OobCode[] };
  return oobCodes.filter((code) => code.email === email);
}

test('sign-up mails a verification link back to this origin, and confirming refreshes the claim', async (t) => {
  const app = initializeApp({ projectId: PROJECT_ID, apiKey: 'test-key' }, randomUUID());
  t.after(() => deleteApp(app));
  const auth = getAuth(app);
  connectAuthEmulator(auth, AUTH_EMULATOR, { disableWarnings: true });
  const email = `${randomUUID()}@example.com`;

  const { user } = await createUserWithEmailAndPassword(auth, email, 'valid-test-password');
  assert.deepEqual(await oobCodesFor(email), [], 'creating the account alone sends nothing');

  await sendVerificationEmail(user, 'https://book.ankile.com');
  const codes = await oobCodesFor(email);
  assert.equal(codes.length, 1);
  assert.equal(codes[0].requestType, 'VERIFY_EMAIL');
  assert.equal(new URL(codes[0].oobLink).searchParams.get('continueUrl'), 'https://book.ankile.com/');

  // Before the link is used: not verified, and the token says so.
  assert.equal(await refreshVerification(user), false);
  assert.equal(user.emailVerified, false);
  assert.equal((await user.getIdTokenResult()).claims.email_verified, false);

  // Using the link is what Firebase's hosted action page does with the code.
  await applyActionCode(auth, codes[0].oobCode);

  // The account record now says verified, and — the part a plain reload
  // would miss — the cached ID token has been replaced by one that carries
  // the claim Rules and callables check.
  assert.equal(await refreshVerification(user), true);
  assert.equal(user.emailVerified, true);
  assert.equal((await user.getIdTokenResult()).claims.email_verified, true);
});

test('a page load after verifying elsewhere gets its stale token claim repaired', async (t) => {
  const app = initializeApp({ projectId: PROJECT_ID, apiKey: 'test-key' }, randomUUID());
  t.after(() => deleteApp(app));
  const auth = getAuth(app);
  connectAuthEmulator(auth, AUTH_EMULATOR, { disableWarnings: true });
  const email = `${randomUUID()}@example.com`;
  const { user } = await createUserWithEmailAndPassword(auth, email, 'valid-test-password');
  await sendVerificationEmail(user, 'https://book.ankile.com');
  const [code] = await oobCodesFor(email);
  await applyActionCode(auth, code.oobCode);

  // What the SDK does on start-up with a persisted session: reload the
  // record, keep the token. Record and claim now disagree — the state the
  // first prod test account was stuck in.
  await reload(user);
  assert.equal(user.emailVerified, true);
  assert.equal((await user.getIdTokenResult()).claims.email_verified, false);

  assert.equal(await syncVerifiedClaim(user), true);
  assert.equal((await user.getIdTokenResult()).claims.email_verified, true);

  // Agreement is left alone: no refresh, so no needless token traffic.
  assert.equal(await syncVerifiedClaim(user), false);
});

test('an unverified account is not refreshed by the claim sync', async (t) => {
  const app = initializeApp({ projectId: PROJECT_ID, apiKey: 'test-key' }, randomUUID());
  t.after(() => deleteApp(app));
  const auth = getAuth(app);
  connectAuthEmulator(auth, AUTH_EMULATOR, { disableWarnings: true });
  const { user } = await createUserWithEmailAndPassword(auth, `${randomUUID()}@example.com`, 'valid-test-password');
  assert.equal(await syncVerifiedClaim(user), false);
  assert.equal((await user.getIdTokenResult()).claims.email_verified, false);
});
