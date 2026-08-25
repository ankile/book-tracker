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
    'let cached old clients reload and the overlap window pass',
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
    /clients offline longer than the chosen overlap window[\s\S]*queued reading batches can still reject/i,
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
