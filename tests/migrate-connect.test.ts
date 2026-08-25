import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const migrateLibUrl = new URL('../migrate-lib.ts', import.meta.url);
const restorePath = fileURLToPath(new URL('../db-restore.ts', import.meta.url));

function environmentWithoutEmulator(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.FIRESTORE_EMULATOR_HOST;
  return env;
}

function runConnect(
  optionsSource: string,
  {
    cwd,
    env = environmentWithoutEmulator(),
    input,
  }: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): SpawnSyncReturns<string> {
  const source = [
    `const { connect } = await import(${JSON.stringify(migrateLibUrl.href)});`,
    `await connect(${optionsSource});`,
  ].join('\n');

  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', source],
    { cwd, env, input, encoding: 'utf8' },
  );
}

function temporaryDirectory(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'book-tracker-connect-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeTestProductionKey(cwd: string): void {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  writeFileSync(
    join(cwd, 'serviceAccountKey.json'),
    JSON.stringify({
      project_id: 'book-tracker-d8f24',
      client_email: 'migration-test@example.invalid',
      private_key: privateKey,
    }),
  );
}

test('connect refuses the default target when no emulator is configured', () => {
  const result = runConnect('{ prod: false }');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /no FIRESTORE_EMULATOR_HOST set/);
  assert.doesNotMatch(result.stderr, /serviceAccountKey\.json/);
});

test('connect defaults to the configured emulator without reading production credentials', () => {
  const result = runConnect(
    '{ prod: false }',
    { env: { ...process.env, FIRESTORE_EMULATOR_HOST: '127.0.0.1:1' } },
  );

  assert.equal(result.status, 0);
  assert.match(result.stdout, /TARGET: emulator 127\.0\.0\.1:1 \(book-tracker-d8f24\)/);
  assert.doesNotMatch(result.stderr, /serviceAccountKey\.json/);
});

test('connect refuses a non-loopback host presented as an emulator', () => {
  const result = runConnect(
    '{ prod: false }',
    { env: { ...process.env, FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443' } },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /emulator host must be loopback/);
  assert.doesNotMatch(result.stdout, /TARGET:/);
});

test('connect refuses contradictory production and emulator targets', () => {
  const result = runConnect(
    '{ prod: true }',
    { env: { ...process.env, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' } },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--prod with FIRESTORE_EMULATOR_HOST set/);
  assert.doesNotMatch(result.stderr, /serviceAccountKey\.json/);
});

test('connect rejects a service account for another project before initialization', (context) => {
  const cwd = temporaryDirectory(context);
  writeFileSync(
    join(cwd, 'serviceAccountKey.json'),
    JSON.stringify({
      project_id: 'wrong-project',
      client_email: 'unused@example.invalid',
      private_key: 'unused',
    }),
  );

  const result = runConnect('{ prod: true }', { cwd });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /wrong-project, expected book-tracker-d8f24/);
  assert.doesNotMatch(result.stdout, /TARGET: PRODUCTION/);
});

test('connect requires the exact project id before returning a production writer', (context) => {
  const cwd = temporaryDirectory(context);
  writeTestProductionKey(cwd);

  const result = runConnect(
    '{ prod: true, confirmWrite: true }',
    { cwd, input: 'not-the-project-id\n' },
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout, /TARGET: PRODUCTION book-tracker-d8f24/);
  assert.match(result.stderr, /confirmation mismatch, aborting/);
});

test('restore defaults to a credential-free dry run with no emulator writes', (context) => {
  const cwd = temporaryDirectory(context);
  const snapshot = join(cwd, 'snapshot.json');
  writeFileSync(snapshot, JSON.stringify({
    projectId: 'book-tracker-d8f24',
    docs: [{ path: 'users/dry-run', data: { marker: 'must-not-write' } }],
  }));
  const env = {
    ...process.env,
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:1',
    GOOGLE_APPLICATION_CREDENTIALS: join(cwd, 'must-not-be-read.json'),
  };

  const result = spawnSync(
    process.execPath,
    [restorePath, snapshot],
    { cwd, env, encoding: 'utf8', timeout: 5_000 },
  );

  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /DRY RUN ONLY — NOTHING WRITTEN; NOTHING WILL BE WRITTEN/);
  assert.match(result.stdout, /DRY RUN COMPLETE — NOTHING WRITTEN/);
  assert.match(result.stdout, /1 documents checked/);
  assert.doesNotMatch(result.stderr, /must-not-be-read|serviceAccountKey/);
});

test('restore production apply requires typed confirmation before processing', (context) => {
  const cwd = temporaryDirectory(context);
  const snapshot = join(cwd, 'snapshot.json');
  writeFileSync(snapshot, JSON.stringify({
    projectId: 'book-tracker-d8f24',
    docs: [{ path: 'users/must-not-write', data: { marker: 'blocked' } }],
  }));
  writeTestProductionKey(cwd);

  const result = spawnSync(
    process.execPath,
    [restorePath, snapshot, '--prod', '--apply'],
    {
      cwd,
      env: environmentWithoutEmulator(),
      input: 'not-the-project-id\n',
      encoding: 'utf8',
      timeout: 5_000,
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout, /APPLY MODE — WRITES ARE ENABLED/);
  assert.match(result.stdout, /Type the project id to continue/);
  assert.match(result.stderr, /confirmation mismatch, aborting/);
  assert.doesNotMatch(result.stdout, /APPLY COMPLETE/);
});

test('restore rejects an unknown flag before selecting a target', () => {
  const result = spawnSync(
    process.execPath,
    [restorePath, 'unused.json', '--aply'],
    { env: environmentWithoutEmulator(), encoding: 'utf8', timeout: 5_000 },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown flag --aply/);
  assert.doesNotMatch(result.stdout, /DRY RUN|APPLY MODE|TARGET:/);
});

test('restore rejects extra positional arguments before selecting a target', () => {
  const result = spawnSync(
    process.execPath,
    [restorePath, 'snapshot.json', 'recovered'],
    { env: environmentWithoutEmulator(), encoding: 'utf8', timeout: 5_000 },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires exactly one snapshot file/);
  assert.doesNotMatch(result.stdout, /DRY RUN|APPLY MODE|TARGET:/);
});
