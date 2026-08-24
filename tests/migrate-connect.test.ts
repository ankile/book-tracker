import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

const migrateLibUrl = new URL('../migrate-lib.ts', import.meta.url);

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

  const result = runConnect(
    '{ prod: true, confirmWrite: true }',
    { cwd, input: 'not-the-project-id\n' },
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout, /TARGET: PRODUCTION book-tracker-d8f24/);
  assert.match(result.stderr, /confirmation mismatch, aborting/);
});
