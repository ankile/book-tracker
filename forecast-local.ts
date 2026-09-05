// Verify an already-restored emulator and prepare a local review login.
// No production mode. Both emulator endpoints must be explicit loopback URLs.
// FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
// node forecast-local.ts <snapshot.json> <email> <private-output-directory>
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { encodeValue, type EncodedDocument } from './migrate-lib.ts';

if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8080'
    || process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9099') {
  throw new Error('Explicit loopback Firestore and Auth emulators are required. There is no production mode.');
}
const [file, email, outputDir, extra] = process.argv.slice(2);
if (!file || !email || !outputDir || extra) throw new Error('Expected snapshot, email and private output directory');
process.env.GOOGLE_APPLICATION_CREDENTIALS = resolve(outputDir, 'no-production-credentials.json');
const raw = readFileSync(file, 'utf8');
const snapshot: { projectId: string; docs: { path: string; data: EncodedDocument }[] } = JSON.parse(raw);
const app = initializeApp({ projectId: snapshot.projectId });
const db = getFirestore(app);
const expected = snapshot.docs.filter((doc) => !/^users\/[^/]+\/togglQueue\//.test(doc.path));
for (let i = 0; i < expected.length; i += 100) {
  const group = expected.slice(i, i + 100);
  const actual = await db.getAll(...group.map((doc) => db.doc(doc.path)));
  actual.forEach((doc, index) => {
    assert.equal(doc.exists, true, group[index].path);
    assert.deepEqual(encodeValue(doc.data()!), group[index].data, group[index].path);
  });
}
const user = expected.find((doc) => /^users\/[^/]+$/.test(doc.path) && doc.data.email === email);
if (!user) throw new Error('Account not found in the snapshot');
const uid = user.path.split('/')[1];
const auth = getAuth(app);
const existing = (await auth.listUsers()).users.find((user) => user.uid === uid);
const password = randomBytes(18).toString('base64url');
if (existing) await auth.updateUser(uid, { email, password, emailVerified: true });
else await auth.createUser({ uid, email, password, emailVerified: true });
mkdirSync(outputDir, { recursive: true });
writeFileSync(resolve(outputDir, 'local-login.json'), JSON.stringify({ email, uid, password }, null, 2), { mode: 0o600 });
writeFileSync(resolve(outputDir, 'mirror-verification.json'), JSON.stringify({
  sourceHash: createHash('sha256').update(raw).digest('hex'), expectedDocuments: expected.length,
  excludedQueueDocuments: snapshot.docs.length - expected.length, allSourceFieldsEqual: true,
  verifiedAt: new Date().toISOString(),
}, null, 2));
await deleteApp(app);
console.log(`Verified ${expected.length} documents. Emulator-only login saved in ${outputDir}/local-login.json`);
