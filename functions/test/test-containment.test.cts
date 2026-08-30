const {
  DEAD_EMULATOR_HOST,
  MISSING_CREDENTIALS_PATH,
  UNIT_TEST_PROJECT,
} = require("./setup.cts");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const {spawnSync}: typeof import("node:child_process") = require("node:child_process");
const {existsSync, readFileSync, readdirSync}: typeof import("node:fs") = require("node:fs");
const {join}: typeof import("node:path") = require("node:path");
const test: typeof import("node:test").test = require("node:test");
const {getApp}: typeof import("firebase-admin/app") = require("firebase-admin/app");
const {getFirestore}: typeof import("firebase-admin/firestore") = require("firebase-admin/firestore");

require("../lib");

function firestoreConnection(value: object): {
  projectId: string;
  servicePath: string;
  port: number;
  ssl: boolean;
} {
  assert.ok("projectId" in value);
  assert.ok(typeof value.projectId === "string");
  assert.ok("_settings" in value);
  assert.ok(typeof value._settings === "object" && value._settings !== null);
  const settings = value._settings;
  assert.ok("servicePath" in settings);
  assert.ok(typeof settings.servicePath === "string");
  assert.ok("port" in settings);
  assert.ok(typeof settings.port === "number");
  assert.ok("ssl" in settings);
  assert.ok(typeof settings.ssl === "boolean");
  return {
    projectId: value.projectId,
    servicePath: settings.servicePath,
    port: settings.port,
    ssl: settings.ssl,
  };
}

test("Functions unit tests are contained to a dead local emulator", async () => {
  const app = getApp();
  const db = getFirestore();
  const connection = firestoreConnection(db);

  assert.equal(process.env.GCLOUD_PROJECT, UNIT_TEST_PROJECT);
  assert.equal(process.env.GOOGLE_CLOUD_PROJECT, UNIT_TEST_PROJECT);
  assert.ok(process.env.FIREBASE_CONFIG);
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
  assert.equal(connection.projectId, UNIT_TEST_PROJECT);
  assert.equal(connection.servicePath, "127.0.0.1");
  assert.equal(connection.port, 1);
  assert.equal(connection.ssl, false);
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
    ["--require", join(__dirname, "setup.cts"), "-e", childScript],
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
    if (!name.endsWith(".test.cts")) continue;
    const source = readFileSync(join(testDirectory, name), "utf8");
    assert.match(
      source,
      /require\("\.\/setup\.cts"\)/,
      `${name} must load setup.cts for direct single-file runs`,
    );
  }
});
