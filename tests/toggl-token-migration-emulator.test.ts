import './setup.ts';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// migrate-toggl-tokens.ts rehearsal (SEC-004): a legacy users/{uid}.toggl
// credential moves to the secrets database, leaving the status-only
// mirror; the run is idempotent, refuses --rotate without --apply, and
// never prints a token. Runs on the migrate-lib namespace (the real
// project id keyed into the emulator), like the purge rehearsal.
const functionsRequire = createRequire(new URL('../functions/package.json', import.meta.url));
const { getFirestore, Timestamp } = functionsRequire('firebase-admin/firestore') as {
  getFirestore: (appOrDatabaseId?: unknown, databaseId?: string) => import('firebase-admin/firestore').Firestore;
  Timestamp: typeof import('firebase-admin/firestore').Timestamp;
};
const { initializeApp } = functionsRequire('firebase-admin/app') as {
  initializeApp: (options: { projectId: string }, name: string) => unknown;
};

const run = `tok${Date.now()}`;
const app = initializeApp({ projectId: 'book-tracker-d8f24' }, `token-migration-${run}`);
const db = getFirestore(app);
const secrets = getFirestore(app, 'secrets');
const root = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(new URL('../migrate-toggl-tokens.ts', import.meta.url));

const migrate = (...flags: string[]) => spawnSync('node', [script, ...flags], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env },
});
const audit = () => {
  const result = spawnSync('node', [fileURLToPath(new URL('../db-audit.ts', import.meta.url))], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

test('the token migration moves a legacy credential server-side, idempotently, without printing it', async () => {
  const legacy = `legacy-${run}`;
  const done = `done-${run}`;
  const plain = `plain-${run}`;
  await db.doc(`users/${legacy}`).set({ uid: legacy, email: `${legacy}@example.test`, toggl: { apiToken: 'legacy-credential-value', workspaceId: 5, projectId: 6 } });
  await db.doc(`users/${done}`).set({ uid: done, email: `${done}@example.test`, toggl: { workspaceId: 8, projectId: 9, connectedAt: Timestamp.now() } });
  await secrets.doc(`togglTokens/${done}`).set({ apiToken: 'already-moved', workspaceId: 8, projectId: 9, updatedAt: Timestamp.now() });
  await db.doc(`users/${plain}`).set({ uid: plain, email: `${plain}@example.test` });

  // --rotate is a real state change at Toggl: dry runs must refuse it.
  const rotateDry = migrate('--rotate');
  assert.notEqual(rotateDry.status, 0);
  assert.match(rotateDry.stderr, /--rotate .* needs --apply/);

  // Pre-migration this is the audit finding the whole item exists to
  // clear: a credential stored client-readable.
  const preAudit = audit();
  assert.match(preAudit, new RegExp(`^user\\.toggl-legacy-token users/${legacy}`, 'm'));
  assert.ok(!preAudit.includes('legacy-credential-value'));

  const dry = migrate();
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /TARGET: emulator/);
  assert.match(dry.stdout, new RegExp(`^DRY users/${legacy}\\.toggl \\(token 23 chars, workspace 5, project 6\\) -> secrets:togglTokens/${legacy}$`, 'm'));
  assert.match(dry.stdout, new RegExp(`^ok users/${done} already migrated$`, 'm'));
  assert.ok(!dry.stdout.includes('legacy-credential-value'), 'a dry run never prints the token');
  assert.deepEqual((await db.doc(`users/${legacy}`).get()).get('toggl'), { apiToken: 'legacy-credential-value', workspaceId: 5, projectId: 6 });
  assert.equal((await secrets.doc(`togglTokens/${legacy}`).get()).exists, false);

  const applied = migrate('--apply');
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, new RegExp(`^MIGRATE users/${legacy}\\.toggl`, 'm'));
  assert.match(applied.stdout, /1 credential migrated/);
  assert.ok(!applied.stdout.includes('legacy-credential-value'), 'the apply never prints the token');
  const moved = (await secrets.doc(`togglTokens/${legacy}`).get()).data() as Record<string, unknown>;
  assert.deepEqual(Object.keys(moved).sort(), ['apiToken', 'projectId', 'updatedAt', 'workspaceId']);
  assert.equal(moved.apiToken, 'legacy-credential-value');
  assert.equal(moved.workspaceId, 5);
  assert.equal(moved.projectId, 6);
  assert.ok(moved.updatedAt instanceof Timestamp);
  const mirror = (await db.doc(`users/${legacy}`).get()).get('toggl') as Record<string, unknown>;
  assert.deepEqual(Object.keys(mirror).sort(), ['connectedAt', 'projectId', 'workspaceId']);
  assert.equal(mirror.workspaceId, 5);
  assert.equal(mirror.projectId, 6);
  assert.ok(mirror.connectedAt instanceof Timestamp);
  // The untouched accounts stayed untouched.
  assert.equal((await db.doc(`users/${plain}`).get()).get('toggl'), undefined);
  assert.equal((await secrets.doc(`togglTokens/${done}`).get()).get('apiToken'), 'already-moved');

  const postAudit = audit();
  assert.doesNotMatch(postAudit, new RegExp(`user\\.toggl-legacy-token users/${legacy}`));
  assert.doesNotMatch(postAudit, new RegExp(`toggl-secret\\S* secrets:togglTokens/${legacy}`));
  assert.doesNotMatch(postAudit, new RegExp(`user\\.toggl-status\\S* users/${legacy}`));

  // Idempotent: a re-run finds only migrated accounts and writes nothing.
  const again = migrate('--apply');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, new RegExp(`^ok users/${legacy} already migrated$`, 'm'));
  assert.match(again.stdout, /^0 credentials migrated/m);
  assert.deepEqual((await secrets.doc(`togglTokens/${legacy}`).get()).data(), moved);
});
