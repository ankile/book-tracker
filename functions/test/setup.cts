const {join}: typeof import("node:path") = require("node:path");

const UNIT_TEST_PROJECT = "demo-book-tracker-test";
const DEAD_EMULATOR_HOST = "127.0.0.1:1";
// setup.cts is a regular file, so no credential can exist beneath it.
const MISSING_CREDENTIALS_PATH = join(__filename, "credentials.json");

// Load this file before any Admin SDK import. A missed Firestore/Auth mock
// must fail against a closed loopback port, never discover live credentials
// or resolve a production project endpoint.
process.env.GCLOUD_PROJECT = UNIT_TEST_PROJECT;
process.env.GOOGLE_CLOUD_PROJECT = UNIT_TEST_PROJECT;
process.env.FIREBASE_CONFIG = JSON.stringify({projectId: UNIT_TEST_PROJECT});
process.env.FIRESTORE_EMULATOR_HOST = DEAD_EMULATOR_HOST;
process.env.FIREBASE_AUTH_EMULATOR_HOST = DEAD_EMULATOR_HOST;
process.env.GOOGLE_APPLICATION_CREDENTIALS = MISSING_CREDENTIALS_PATH;

global.fetch = async () => {
  throw new Error(
    "Network access is disabled in Functions unit tests. Mock fetch explicitly.",
  );
};

module.exports = {
  DEAD_EMULATOR_HOST,
  MISSING_CREDENTIALS_PATH,
  UNIT_TEST_PROJECT,
};
