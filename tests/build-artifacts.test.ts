import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const publicIndexUrl = new URL('../public/index.html', import.meta.url);
const publicServiceWorkerUrl = new URL('../public/service-worker.js', import.meta.url);
const publicVersionUrl = new URL('../public/_app/version.json', import.meta.url);
const profileShellUrl = new URL('../functions/assets/profile-shell.html', import.meta.url);

function immutableAssetPaths(source: string): string[] {
  return [...source.matchAll(/\/_app\/immutable\/[^"'`\\\s)]+/g)]
    .map((match) => match[0]);
}

function sha256(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function trackedFile(path: string): string {
  const result = spawnSync('git', ['show', `HEAD:${path}`], { encoding: 'utf8' });
  assert.equal(result.status, 0, `could not read tracked ${path}: ${result.stderr}`);
  return result.stdout;
}

function versionName(source: string, name: string): string {
  const parsed: unknown = JSON.parse(source);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    typeof parsed.version !== 'string'
  ) {
    throw new Error(`${name} does not contain a string version`);
  }
  return parsed.version;
}

async function assertReferencesCurrentAssets(name: string, source: string): Promise<void> {
  const paths = [...new Set(immutableAssetPaths(source))];
  assert.ok(paths.length > 0, `${name} must reference at least one immutable build asset`);

  await Promise.all(paths.map((path) => access(
    new URL(`../public${path}`, import.meta.url),
  )));
}

const trackedVersion = versionName(
  trackedFile('public/_app/version.json'),
  'tracked public/_app/version.json',
);
const verificationBuild = spawnSync('npm', ['run', 'build'], {
  encoding: 'utf8',
  env: {
    ...process.env,
    BOOK_TRACKER_BUILD_VERSION: trackedVersion,
  },
});
assert.equal(
  verificationBuild.status,
  0,
  `verification build failed:\n${verificationBuild.stdout}\n${verificationBuild.stderr}`,
);

test('tracked service worker matches the latest build', async () => {
  const [built, builtVersionSource] = await Promise.all([
    readFile(publicServiceWorkerUrl, 'utf8'),
    readFile(publicVersionUrl, 'utf8'),
  ]);
  const tracked = trackedFile('public/service-worker.js');
  const builtVersion = versionName(builtVersionSource, 'built public/_app/version.json');

  assert.equal(builtVersion, trackedVersion, 'verification build did not use the tracked version');
  assert.equal(
    sha256(tracked),
    sha256(built),
    'public/service-worker.js is stale; run npm run build and commit the generated file',
  );
});

test('tracked index matches the latest build', async () => {
  const built = await readFile(publicIndexUrl, 'utf8');
  const tracked = trackedFile('public/index.html');

  assert.equal(
    sha256(tracked),
    sha256(built),
    'public/index.html is stale; run npm run build and commit the generated file',
  );
});

test('tracked profile shell matches the latest build', async () => {
  const built = await readFile(profileShellUrl, 'utf8');
  const tracked = trackedFile('functions/assets/profile-shell.html');

  assert.equal(
    sha256(tracked),
    sha256(built),
    'functions/assets/profile-shell.html is stale; run npm run build and commit the generated file',
  );
});

test('built deploy entrypoints reference emitted assets', async () => {
  const [index, serviceWorker, profileShell] = await Promise.all([
    readFile(publicIndexUrl, 'utf8'),
    readFile(publicServiceWorkerUrl, 'utf8'),
    readFile(profileShellUrl, 'utf8'),
  ]);

  assert.equal(
    sha256(profileShell),
    sha256(index),
    'functions/assets/profile-shell.html must be generated from public/index.html',
  );
  await Promise.all([
    assertReferencesCurrentAssets('public/index.html', index),
    assertReferencesCurrentAssets('public/service-worker.js', serviceWorker),
    assertReferencesCurrentAssets('functions/assets/profile-shell.html', profileShell),
  ]);
});
