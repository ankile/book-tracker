import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';

const publicIndexUrl = new URL('../public/index.html', import.meta.url);
const publicServiceWorkerUrl = new URL('../public/service-worker.js', import.meta.url);
const publicVersionUrl = new URL('../public/_app/version.json', import.meta.url);
const profileShellUrl = new URL('../functions/assets/profile-shell.html', import.meta.url);
const hostingManifestUrl = new URL('../hosting-artifacts.json', import.meta.url);
const functionsManifestUrl = new URL('../functions-artifacts.json', import.meta.url);
const functionsRootUrl = new URL('../functions/', import.meta.url);
const publicRootUrl = new URL('../public/', import.meta.url);

function immutableAssetPaths(source: string): string[] {
  return [...source.matchAll(/\/_app\/immutable\/[^"'`\\\s)]+/g)]
    .map((match) => match[0]);
}

function sha256(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

async function builtHostingFiles(directory: URL): Promise<string[]> {
  const entries = await readdir(directory, {withFileTypes: true});
  const files = await Promise.all(entries.map(async (entry) => {
    const url = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, directory);
    if (entry.isDirectory()) return builtHostingFiles(url);
    if (entry.name === '.DS_Store') return [];
    return [fileURLToPath(url)];
  }));
  return files.flat();
}

function trackedFile(path: string): string {
  const result = spawnSync('git', ['show', `HEAD:${path}`], { encoding: 'utf8' });
  assert.equal(result.status, 0, `could not read tracked ${path}: ${result.stderr}`);
  return result.stdout;
}

function indexedFile(path: string): string {
  const result = spawnSync('git', ['show', `:${path}`], { encoding: 'utf8' });
  assert.equal(result.status, 0, `could not read staged ${path}: ${result.stderr}`);
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

test('Hosting manifest binds every generated deployment file', async () => {
  const builtManifest = await readFile(hostingManifestUrl, 'utf8');
  assert.equal(
    sha256(indexedFile('hosting-artifacts.json')),
    sha256(builtManifest),
    'hosting-artifacts.json is stale; run npm run build and stage the generated manifest',
  );
  const parsed: unknown = JSON.parse(builtManifest);
  assert.equal(typeof parsed, 'object');
  assert.notEqual(parsed, null);
  assert.equal(Array.isArray(parsed), false);
  const manifest = parsed as {version?: unknown; files?: unknown};
  assert.equal(manifest.version, 2);
  assert.equal(typeof manifest.files, 'object');
  assert.notEqual(manifest.files, null);
  assert.equal(Array.isArray(manifest.files), false);

  const actual = Object.fromEntries(await Promise.all(
    (await builtHostingFiles(publicRootUrl)).map(async (path) => {
      const content = await readFile(path);
      return [
        relative(fileURLToPath(publicRootUrl), path).split(sep).join('/'),
        {
          sha256: createHash('sha256').update(content).digest('hex'),
          hostingHash: createHash('sha256')
            .update(gzipSync(content, {level: 9}))
            .digest('hex'),
        },
      ] as const;
    }),
  ));
  assert.deepEqual(manifest.files, actual);
});

test('Functions manifest binds the exact compiled deployment source and profile probe', async () => {
  const builtManifest = await readFile(functionsManifestUrl, 'utf8');
  assert.equal(
    sha256(indexedFile('functions-artifacts.json')),
    sha256(builtManifest),
    'functions-artifacts.json is stale; run npm run build and stage the generated manifest',
  );
  const manifest = JSON.parse(builtManifest) as {
    version: number;
    files: Record<string, string>;
    profileProbeSha256: string;
  };
  assert.equal(manifest.version, 1);
  const actual = Object.fromEntries(await Promise.all(
    Object.keys(manifest.files).map(async (deploymentPath) => [
      deploymentPath,
      createHash('sha256')
        .update(await readFile(new URL(deploymentPath, functionsRootUrl)))
        .digest('hex'),
    ] as const),
  ));
  assert.deepEqual(manifest.files, actual);
  assert.deepEqual(Object.keys(manifest.files).sort(), [
    '.gitignore',
    '.npmrc',
    'assets/profile-shell.html',
    'lib/admin.js',
    'lib/adminIssues.js',
    'lib/booksapi.js',
    'lib/decoders.js',
    'lib/index.js',
    'lib/logging.js',
    'lib/publicProfileRenderer.js',
    'lib/publicWeb.js',
    'lib/release.js',
    'lib/toggl-recovery.js',
    'lib/toggl.js',
    'package-lock.json',
    'package.json',
  ]);
  const rendererPath = '../functions/lib/' + 'publicProfileRenderer.js';
  const renderer = await import(rendererPath) as {
    renderNotFoundDocument(shell: string): string;
  };
  const shell = await readFile(profileShellUrl, 'utf8');
  assert.equal(
    manifest.profileProbeSha256,
    sha256(renderer.renderNotFoundDocument(shell)),
  );
});

test('Firebase Functions packaging excludes local configuration and non-runtime sources', () => {
  const firebaseJson = JSON.parse(indexedFile('firebase.json')) as {
    functions: Record<string, unknown>;
  };
  assert.deepEqual(firebaseJson.functions, {
    source: 'functions',
    disallowLegacyRuntimeConfig: true,
    ignore: [
      'node_modules',
      '.git',
      '.DS_Store',
      '.env*',
      '.secret.*',
      '*.log',
      'src',
      'test',
      'eslint.config.cjs',
      'tsconfig.json',
      '**/*.js.map',
      '**/lib/scripts/**',
    ],
    predeploy: [
      'npm --prefix "$RESOURCE_DIR" run lint',
      'npm --prefix "$RESOURCE_DIR" run build',
    ],
  });
});
