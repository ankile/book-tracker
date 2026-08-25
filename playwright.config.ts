import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://127.0.0.1:5175',
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'VITE_EMULATOR=1 npm run dev -- --host 127.0.0.1 --port 5175 --strictPort',
    url: 'http://127.0.0.1:5175/',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
