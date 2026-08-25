const {
  DEAD_EMULATOR_HOST,
  MISSING_CREDENTIALS_PATH,
  UNIT_TEST_PROJECT,
} = require("./setup.cjs");

const assert = require("node:assert/strict");
const {spawnSync} = require("node:child_process");
const {existsSync, readFileSync, readdirSync} = require("node:fs");
const {join} = require("node:path");
const test = require("node:test");
const {getApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");

require("../lib");

test("Functions unit tests are contained to a dead local emulator", async () => {
  const app = getApp();
  const db = getFirestore();

  assert.equal(process.env.GCLOUD_PROJECT, UNIT_TEST_PROJECT);
  assert.equal(process.env.GOOGLE_CLOUD_PROJECT, UNIT_TEST_PROJECT);
  assert.deepEqual(JSON.parse(process.env.FIREBASE_CONFIG), {
    projectId: UNIT_TEST_PROJECT,
  });
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, DEAD_EMULATOR_HOST);
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, DEAD_EMULATOR_HOST);
  assert.equal(
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    MISSING_CREDENTIALS_PATH,
  );
  assert.equal(existsSync(MISSING_CREDENTIALS_PATH), false);
  assert.equal(app.options.projectId, UNIT_TEST_PROJECT);
  assert.equal(db.projectId, UNIT_TEST_PROJECT);
  assert.equal(db._settings.servicePath, "127.0.0.1");
  assert.equal(db._settings.port, 1);
  assert.equal(db._settings.ssl, false);
  await assert.rejects(
    global.fetch("https://firestore.googleapis.com"),
    /Network access is disabled/,
  );
});

test("the preload replaces a hostile environment before bundle initialization", () => {
  const childScript = `
    const assert = require("node:assert/strict");
    const {existsSync} = require("node:fs");
    assert.equal(process.env.GCLOUD_PROJECT, ${JSON.stringify(UNIT_TEST_PROJECT)});
    assert.equal(process.env.GOOGLE_CLOUD_PROJECT, ${JSON.stringify(UNIT_TEST_PROJECT)});
    assert.deepEqual(JSON.parse(process.env.FIREBASE_CONFIG), {
      projectId: ${JSON.stringify(UNIT_TEST_PROJECT)},
    });
    assert.equal(process.env.FIRESTORE_EMULATOR_HOST, ${JSON.stringify(DEAD_EMULATOR_HOST)});
    assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, ${JSON.stringify(DEAD_EMULATOR_HOST)});
    assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, ${JSON.stringify(MISSING_CREDENTIALS_PATH)});
    assert.equal(existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS), false);
    require("./lib");
    const {getApp} = require("firebase-admin/app");
    const {getFirestore} = require("firebase-admin/firestore");
    const db = getFirestore();
    assert.equal(getApp().options.projectId, ${JSON.stringify(UNIT_TEST_PROJECT)});
    assert.equal(db.projectId, ${JSON.stringify(UNIT_TEST_PROJECT)});
    assert.equal(db._settings.servicePath, "127.0.0.1");
    assert.equal(db._settings.port, 1);
    assert.equal(db._settings.ssl, false);
  `;
  const result = spawnSync(
    process.execPath,
    ["--require", join(__dirname, "setup.cjs"), "-e", childScript],
    {
      cwd: join(__dirname, ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        GCLOUD_PROJECT: "book-tracker-d8f24",
        GOOGLE_CLOUD_PROJECT: "book-tracker-d8f24",
        FIREBASE_CONFIG: JSON.stringify({projectId: "book-tracker-d8f24"}),
        FIRESTORE_EMULATOR_HOST: "firestore.googleapis.com:443",
        FIREBASE_AUTH_EMULATOR_HOST: "identitytoolkit.googleapis.com:443",
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/production-credentials.json",
      },
      timeout: 5_000,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
});

test("every Functions test self-loads the containment setup", () => {
  const testDirectory = __dirname;
  for (const name of readdirSync(testDirectory)) {
    if (!name.endsWith(".test.cjs")) continue;
    const source = readFileSync(join(testDirectory, name), "utf8");
    assert.match(
      source,
      /require\("\.\/setup\.cjs"\)/,
      `${name} must load setup.cjs for direct single-file runs`,
    );
  }
});
