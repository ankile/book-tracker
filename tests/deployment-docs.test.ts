import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readmeUrl = new URL('../README.md', import.meta.url);
const migrationsUrl = new URL('../MIGRATIONS.md', import.meta.url);
const progressMigrationUrl = new URL('../migrate-reading-progress-sources.ts', import.meta.url);

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing ${start}`);
  assert.notEqual(endIndex, -1, `missing ${end}`);
  return source.slice(startIndex, endIndex);
}

function assertOrdered(source: string, values: string[]): void {
  let previousIndex = -1;
  for (const value of values) {
    const index = source.indexOf(value, previousIndex + 1);
    assert.notEqual(index, -1, `missing deployment step: ${value}`);
    assert.ok(index > previousIndex, `deployment step is out of order: ${value}`);
    previousIndex = index;
  }
}

test('the README deploys compatible Hosting before the progress-source backfill', async () => {
  const readme = await readFile(readmeUrl, 'utf8');
  const deployment = section(readme, '### Deploy Everything', '### Deploy Hosting Only');

  assert.match(deployment, /\[timer-claim rollout\]\(MIGRATIONS\.md#timer-claim-rollout\)/);
  assertOrdered(deployment, [
    'firebase deploy --only firestore',
    'firebase deploy --only functions',
    'let old in-flight invocations drain',
    'node migrate-timer-claims.ts --prod',
    'node db-snapshot.ts --prod',
    'node migrate-timer-claims.ts --prod --apply',
    'node migrate-timer-claims.ts --prod --apply',
    'node db-audit.ts --prod',
    'firebase deploy --only hosting',
    '7-day old-bundle overlap window',
    'node migrate-reading-progress-sources.ts --prod',
    'node db-snapshot.ts --prod',
    'node migrate-reading-progress-sources.ts --prod --apply',
    'node migrate-reading-progress-sources.ts --prod --apply',
    'node db-audit.ts --prod',
  ]);
  assert.equal(
    deployment.match(/node migrate-timer-claims\.ts --prod --apply/g)?.length,
    2,
    'the rollout must apply twice to prove idempotency',
  );
  assert.equal(
    deployment.match(/node migrate-reading-progress-sources\.ts --prod --apply/g)?.length,
    2,
    'the progress migration must apply twice to prove idempotency',
  );
});

test('the general migration order links to the timer-claim exception', async () => {
  const migrations = await readFile(migrationsUrl, 'utf8');
  assert.match(migrations, /\[timer-claim rollout\]\(#timer-claim-rollout\)/);
  assert.match(migrations, /#### Timer-claim rollout/);
  assert.match(migrations, /#### Reading-progress-source rollout/);
  assert.match(
    migrations,
    /default \*\*7-day overlap\s+window\*\*[\s\S]*still-running old bundle, online or offline/i,
  );
  assert.match(
    migrations,
    /Session edit\/delete rewind is deliberately disabled on un-backfilled books[\s\S]*window artifact/i,
  );
});

test('the strict-TypeScript rollback runbook preserves compatible release stages', async () => {
  const migrations = await readFile(new URL('../MIGRATIONS.md', import.meta.url), 'utf8');
  const rollback = migrations.slice(
    migrations.indexOf('#### Strict-TypeScript release record and rollback boundary'),
    migrations.indexOf('### 4. Production run'),
  );

  assert.match(rollback, /repository has no GitHub Actions[\s\S]*Merge only:[\s\S]*revert the merge commit/i);
  assert.match(rollback, /New rules only:[\s\S]*firestore:rules[\s\S]*Do not deploy `--only firestore`/i);
  assert.match(rollback, /New Functions, before timer migration:[\s\S]*wait for the superseded invocations to drain[\s\S]*firestore:rules/i);
  assert.match(
    rollback,
    /After timer migration, before new Hosting:[\s\S]*Rollback is unsupported[\s\S]*no enforced gate[\s\S]*purpose-built repair migration/i,
  );
  assert.match(rollback, /After new Hosting has ever been exposed:[\s\S]*do \*\*not\*\* roll back Hosting,[\s\S]*fix forward/i);
  assert.match(rollback, /Never roll back Functions alone[\s\S]*Never roll back Hosting alone/i);
  assert.match(rollback, /Do not use `db-restore\.ts`\s+for an ordinary release[\s\S]*non-atomic[\s\S]*does not delete/i);
  assert.match(
    rollback,
    /local snapshot is only a targeted recovery aid[\s\S]*without a shared read[\s\S]*does not currently provide enforced write quiescence/i,
  );
});

test('the progress migration traverses phantom users and logs the applied transaction patch', async () => {
  const migration = await readFile(progressMigrationUrl, 'utf8');
  assert.match(migration, /collection\('users'\)\.listDocuments\(\)/);

  const transaction = migration.indexOf('const appliedPatch = await db.runTransaction');
  const appliedLog = migration.indexOf('appliedPatch.currentPageUpdateId', transaction);
  assert.notEqual(transaction, -1, 'apply mode must return the patch chosen inside the transaction');
  assert.ok(appliedLog > transaction, 'apply mode must log the transaction-applied patch');
});
