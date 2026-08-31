import { defineConfig } from '@playwright/test';

// Every callable enforces App Check (SEC-068) and the client skips App
// Check in emulator runs, so the browser would be refused by the Functions
// emulator. That emulator never verifies tokens — it unsafe-decodes the
// header — so an unsigned JWT attached at the browser-context level stands
// in for the reCAPTCHA attestation a real client presents.
const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const emulatorAppCheckToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
  sub: '1:emulator:web:playwright',
  aud: ['projects/book-tracker-d8f24'],
  iss: 'https://firebaseappcheck.googleapis.com/emulator',
  exp: 4102444800,
})}.`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://127.0.0.1:5176',
    extraHTTPHeaders: { 'x-firebase-appcheck': emulatorAppCheckToken },
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'VITE_EMULATOR=1 npm run dev -- --host 127.0.0.1 --port 5176 --strictPort',
    url: 'http://127.0.0.1:5176/',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
