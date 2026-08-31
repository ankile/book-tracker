import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readmeUrl = new URL('../README.md', import.meta.url);
const migrationsUrl = new URL('../MIGRATIONS.md', import.meta.url);
const packageUrl = new URL('../package.json', import.meta.url);
const functionsPackageUrl = new URL('../functions/package.json', import.meta.url);
const firebaseRcUrl = new URL('../.firebaserc', import.meta.url);
const functionsIndexUrl = new URL('../functions/src/index.ts', import.meta.url);
const progressMigrationUrl = new URL('../migrate-reading-progress-sources.ts', import.meta.url);
const firestoreIndexesUrl = new URL('../firestore.indexes.json', import.meta.url);

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
    assert.notEqual(index, -1, `missing documented step: ${value}`);
    assert.ok(index > previousIndex, `documented step is out of order: ${value}`);
    previousIndex = index;
  }
}

async function deployedFunctionNames(indexSource: string): Promise<string[]> {
  const namespaceMatches = [...indexSource.matchAll(
    /exports\.([A-Za-z0-9_]+)\s*=\s*require\("\.\/([^"/]+)"\)/g,
  )];
  const namespaces = new Set(namespaceMatches.map((match) => match[1]));
  const names = [...indexSource.matchAll(/exports\.([A-Za-z0-9_]+)\s*=/g)]
    .map((match) => match[1])
    .filter((name) => !namespaces.has(name));

  for (const [, namespace, moduleName] of namespaceMatches) {
    const moduleSource = await readFile(
      new URL(`../functions/src/${moduleName}.ts`, import.meta.url),
      'utf8',
    );
    for (const match of moduleSource.matchAll(/exports\.([A-Za-z0-9_]+)\s*=/g)) {
      names.push(`${namespace}-${match[1]}`);
    }
  }
  return names;
}

test('public operational docs omit deployment and operator identifiers', async () => {
  const [readme, migrations, firebaseRc, functionsIndex] = await Promise.all([
    readFile(readmeUrl, 'utf8'),
    readFile(migrationsUrl, 'utf8'),
    readFile(firebaseRcUrl, 'utf8'),
    readFile(functionsIndexUrl, 'utf8'),
  ]);
  const publicDocs = `${readme}\n${migrations}`;
  const projects = Object.values(
    (JSON.parse(firebaseRc) as { projects?: Record<string, string> }).projects ?? {},
  );
  const functionNames = await deployedFunctionNames(functionsIndex);

  for (const identifier of [...projects, ...functionNames]) {
    assert.ok(!publicDocs.includes(identifier), `public docs expose backend identifier ${identifier}`);
  }
  assert.doesNotMatch(publicDocs, /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  assert.doesNotMatch(publicDocs, /\bgcloud\s+/i);
  assert.doesNotMatch(publicDocs, /--account(?:=|\s)/i);
  assert.doesNotMatch(publicDocs, /\b(?:maxInstances|minInstances|serviceAccountEmail)\b/);
  assert.doesNotMatch(publicDocs, /FUNCTIONS_CONFIG_EXPORT|runtime config export/i);
});

test('the README documents the current routine release without completed migrations', async () => {
  const readme = await readFile(readmeUrl, 'utf8');
  const deployment = section(readme, '## Deployment', '## Project layout');

  assertOrdered(deployment, [
    'npm test',
    'npm run build',
    'node docs/architecture/verify.ts',
    'Commit the source and generated artifacts',
    'npm run validate',
    'artifact checks compare',
    'firebase-tools@15.24.0',
  ]);
  assert.match(deployment, /Hosting and the public profile renderer are coupled/i);
  assert.match(deployment, /Do not release Hosting\s+by\s+itself/i);
  assert.doesNotMatch(deployment, /migrate-timer-claims|migrate-reading-progress-sources/i);
  assert.doesNotMatch(deployment, /7-day|old-bundle overlap|let old in-flight invocations drain/i);
  assert.doesNotMatch(deployment, /functions:config:export|--force/i);
});

test('local setup is emulator-first and refuses repository reinitialization', async () => {
  const readme = await readFile(readmeUrl, 'utf8');
  const setup = section(readme, '## Set up the repository', '## Testing');

  assert.match(setup, /Do not run\s+`firebase init`/i);
  assertOrdered(setup, [
    'npm --prefix functions run serve',
    'VITE_EMULATOR=1 npm run dev',
    'Plain `npm run dev` does not enable the emulators',
  ]);
});

test('book metadata docs describe field-specific live precedence and validated writes', async () => {
  const readme = await readFile(readmeUrl, 'utf8');
  const metadata = section(readme, '## Book metadata', '## Requirements');

  assert.match(metadata, /Metadata precedence is field-specific/i);
  assert.match(metadata, /Cover \| Metered catalog \| Open catalog, then national catalog/);
  assert.match(metadata, /Publisher and publication date \| Open catalog \| Metered catalog, then national catalog/);
  assert.match(metadata, /Firestore Rules allowlist the book\s+fields, validate their types and sizes/i);
  assert.doesNotMatch(metadata, /blanket write access/i);
});

test('catalog queries have the required collection-group and pagination indexes', async () => {
  const parsed = JSON.parse(await readFile(firestoreIndexesUrl, 'utf8')) as {
    indexes: Array<{
      collectionGroup: string;
      queryScope: string;
      fields: Array<{fieldPath: string; order: string}>;
    }>;
    fieldOverrides: Array<{
      collectionGroup: string;
      fieldPath: string;
      indexes: Array<{order?: string; arrayConfig?: string; queryScope?: string}>;
    }>;
  };

  for (const fieldPath of ['workId', 'editionId']) {
    const override = parsed.fieldOverrides.find((entry) =>
      entry.collectionGroup === 'books' && entry.fieldPath === fieldPath);
    assert.ok(override, `missing books.${fieldPath} field override`);
    assert.equal(override.indexes.some((entry) =>
      entry.order === 'ASCENDING' && entry.queryScope === 'COLLECTION_GROUP'), true);
  }
  // mergeAuthors rewrites every personal book that references an absorbed
  // author through a collection-group array-contains-any query. Firestore's
  // automatic single-field indexes are collection-scoped only, and the
  // emulator does not enforce indexes, so without this override the first
  // production merge fails with FAILED_PRECONDITION after its reads.
  const authorIds = parsed.fieldOverrides.find((entry) =>
    entry.collectionGroup === 'books' && entry.fieldPath === 'authorIds');
  assert.ok(authorIds, 'missing books.authorIds field override');
  assert.equal(authorIds.indexes.some((entry) =>
    entry.arrayConfig === 'CONTAINS' && entry.queryScope === 'COLLECTION_GROUP'), true,
  'missing collection-group CONTAINS index for books.authorIds');

  assert.equal(parsed.indexes.some((index) =>
    index.collectionGroup === 'workTitleIndex' && index.queryScope === 'COLLECTION' &&
    index.fields[0]?.fieldPath === 'visibility' && index.fields[0]?.order === 'ASCENDING' &&
    index.fields[1]?.fieldPath === 'titleKey' && index.fields[1]?.order === 'ASCENDING'), true,
  'missing searchable title-prefix composite index');
  assert.equal(parsed.indexes.some((index) =>
    index.collectionGroup === 'sharedWorkOwners' && index.queryScope === 'COLLECTION' &&
    index.fields[0]?.fieldPath === 'workId' && index.fields[0]?.order === 'ASCENDING' &&
    index.fields[1]?.fieldPath === '__name__' && index.fields[1]?.order === 'ASCENDING'), true,
  'missing stable work-reader pagination composite index');
});

test('migration docs mark one-time rollouts complete and prescribe idempotency', async () => {
  const migrations = await readFile(migrationsUrl, 'utf8');

  assert.match(migrations, /migrate-timer-claims\.ts[^\n]*Completed historical rollout[^\n]*Do not rerun during deployment/i);
  assert.match(migrations, /migrate-reading-progress-sources\.ts[^\n]*Completed historical rollout/i);
  assert.match(migrations, /proposed waiting period was superseded[^\n]*completed in the same release window/i);
  assert.match(migrations, /strict-TypeScript[\s\S]*?rollouts are complete/i);
  assert.equal(
    migrations.match(/node <migration>\.ts --prod --apply/g)?.length,
    2,
    'the production procedure must prove an idempotent second apply',
  );
  assertOrdered(migrations, [
    'node <migration>.ts --prod',
    'node db-snapshot.ts --prod',
    'node <migration>.ts --prod --apply',
    'node db-audit.ts --prod',
  ]);
});

test('README lists every package script', async () => {
  const [readme, rootPackage, functionsPackage] = await Promise.all([
    readFile(readmeUrl, 'utf8'),
    readFile(packageUrl, 'utf8'),
    readFile(functionsPackageUrl, 'utf8'),
  ]);
  const rootScripts = Object.keys(
    (JSON.parse(rootPackage) as { scripts: Record<string, string> }).scripts,
  );
  const functionsScripts = Object.keys(
    (JSON.parse(functionsPackage) as { scripts: Record<string, string> }).scripts,
  );

  for (const script of rootScripts) {
    const command = script === 'test' ? '`npm test`' : `\`npm run ${script}\``;
    assert.ok(readme.includes(command), `README omits root script ${script}`);
  }
  for (const script of functionsScripts) {
    const command = script === 'test'
      ? '`npm --prefix functions test`'
      : script === 'start'
        ? '`npm --prefix functions start`'
        : `\`npm --prefix functions run ${script}\``;
    assert.ok(readme.includes(command), `README omits Functions script ${script}`);
  }
});

test('every Firebase CLI invocation in the public README pins one version', async () => {
  const readme = await readFile(readmeUrl, 'utf8');
  const invocations = readme
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .filter((line) => /^\s*(npm exec|npx|firebase)\b/.test(line) && /\bfirebase\s+/.test(line));

  assert.ok(invocations.length >= 1, 'expected a documented Firebase CLI invocation');
  for (const line of invocations) {
    assert.match(line, /firebase-tools@15\.24\.0/, `unpinned Firebase CLI: ${line.trim()}`);
  }
});

test('the progress migration traverses phantom users and logs its transaction patch', async () => {
  const migration = await readFile(progressMigrationUrl, 'utf8');
  assert.match(migration, /collection\('users'\)\.listDocuments\(\)/);

  const transaction = migration.indexOf('const appliedPatch = await db.runTransaction');
  const appliedLog = migration.indexOf('appliedPatch.currentPageUpdateId', transaction);
  assert.notEqual(transaction, -1, 'apply mode must return the patch chosen inside the transaction');
  assert.ok(appliedLog > transaction, 'apply mode must log the transaction-applied patch');
});
