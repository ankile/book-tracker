import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {env, execPath} from 'node:process';
import {fileURLToPath} from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
function string(value: unknown): string {
  assert.equal(typeof value, 'string');
  return value as string;
}

const trackedVersion = JSON.parse(
  readFileSync(join(root, 'public/_app/version.json'), 'utf8'),
) as {version?: unknown};
const version = string(trackedVersion.version);
assert.notEqual(version, '');

const buildVersion = env.BOOK_TRACKER_BUILD_VERSION ?? version;
execFileSync(
  execPath,
  [join(root, 'node_modules/vite/bin/vite.js'), 'build'],
  {
    cwd: root,
    env: {...env, BOOK_TRACKER_BUILD_VERSION: buildVersion},
    stdio: 'inherit',
  },
);
execFileSync(execPath, [join(root, 'sync-profile-shell.ts')], {
  cwd: root,
  stdio: 'inherit',
});
execFileSync(execPath, [join(root, 'sync-hosting-manifest.ts')], {
  cwd: root,
  stdio: 'inherit',
});
