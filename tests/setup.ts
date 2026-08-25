import {fileURLToPath} from 'node:url';

const TEST_PROJECT = 'book-tracker-test';
const DEAD_LOCAL_EMULATOR = '127.0.0.1:1';

function isLocalEmulator(value: string | undefined): boolean {
  return /^(?:127\.0\.0\.1|localhost):\d+$/.test(value ?? '');
}

process.env.GCLOUD_PROJECT = TEST_PROJECT;
process.env.GOOGLE_CLOUD_PROJECT = TEST_PROJECT;
process.env.FIREBASE_CONFIG = JSON.stringify({projectId: TEST_PROJECT});
process.env.GOOGLE_APPLICATION_CREDENTIALS = fileURLToPath(
  new URL('./credentials-do-not-exist.json', import.meta.url),
);

if (!isLocalEmulator(process.env.FIRESTORE_EMULATOR_HOST)) {
  process.env.FIRESTORE_EMULATOR_HOST = DEAD_LOCAL_EMULATOR;
}
if (!isLocalEmulator(process.env.FIREBASE_AUTH_EMULATOR_HOST)) {
  process.env.FIREBASE_AUTH_EMULATOR_HOST = DEAD_LOCAL_EMULATOR;
}
