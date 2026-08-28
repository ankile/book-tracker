import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const architectureDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(architectureDir, '../..');
const diagramStems = [
  'system-context',
  'app-architecture',
  'backend-runtime',
  'site-functionality',
  'site-access',
];

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function applicationRoutes() {
  const routesRoot = join(repositoryRoot, 'src/routes');
  return filesBelow(routesRoot)
    .filter((path) => path.endsWith('/+page.svelte'))
    .map((path) => {
      const directory = relative(routesRoot, dirname(path));
      return directory === '' ? '/' : `/${directory}`;
    })
    .sort();
}

function deployedFunctions() {
  const functionsRoot = join(repositoryRoot, 'functions/src');
  const indexSource = readFileSync(join(functionsRoot, 'index.ts'), 'utf8');
  const namespaceMatches = [...indexSource.matchAll(
    /exports\.([A-Za-z0-9_]+)\s*=\s*require\("\.\/([^"/]+)"\)/g,
  )];
  const namespaces = new Set(namespaceMatches.map((match) => match[1]));
  const names = new Set(
    [...indexSource.matchAll(/exports\.([A-Za-z0-9_]+)\s*=/g)]
      .map((match) => match[1])
      .filter((name) => !namespaces.has(name)),
  );

  for (const [, namespace, moduleName] of namespaceMatches) {
    const moduleSource = readFileSync(join(functionsRoot, `${moduleName}.ts`), 'utf8');
    for (const match of moduleSource.matchAll(/exports\.([A-Za-z0-9_]+)\s*=/g)) {
      names.add(`${namespace}-${match[1]}`);
    }
  }
  return [...names].sort();
}

const architectureReadme = readFileSync(join(architectureDir, 'README.md'), 'utf8');
const backendDiagram = readFileSync(join(architectureDir, 'backend-runtime.mmd'), 'utf8');
const navigationDiagram = readFileSync(join(architectureDir, 'site-functionality.mmd'), 'utf8');
const accessDiagram = readFileSync(join(architectureDir, 'site-access.mmd'), 'utf8');
const routes = applicationRoutes();
const functions = deployedFunctions();

for (const route of routes) {
  const marker = route === '/' ? '<code>/</code>' : route;
  assert(navigationDiagram.includes(marker), `site-functionality.mmd is missing route ${route}`);
  assert(accessDiagram.includes(marker), `site-access.mmd is missing route ${route}`);
}

for (const functionName of functions) {
  assert(backendDiagram.includes(functionName), `backend-runtime.mmd is missing function ${functionName}`);
  assert(architectureReadme.includes(functionName), `README.md is missing function ${functionName}`);
}

const sharedInputs = [
  join(architectureDir, 'mermaid-config.json'),
  join(architectureDir, 'mermaid.css'),
];

for (const stem of diagramStems) {
  const sourcePath = join(architectureDir, `${stem}.mmd`);
  const source = readFileSync(sourcePath, 'utf8');
  assert(/^\s+accTitle:/m.test(source), `${stem}.mmd is missing accTitle`);
  assert(/^\s+accDescr:/m.test(source), `${stem}.mmd is missing accDescr`);

  for (const extension of ['svg', 'png']) {
    const outputPath = join(architectureDir, `${stem}.${extension}`);
    assert(existsSync(outputPath), `${stem}.${extension} has not been rendered`);
    const newestInput = Math.max(
      statSync(sourcePath).mtimeMs,
      ...sharedInputs.map((path) => statSync(path).mtimeMs),
    );
    assert(
      statSync(outputPath).mtimeMs >= newestInput,
      `${stem}.${extension} is older than its source or shared styles`,
    );
  }
}

console.log(
  `Architecture docs verified: ${routes.length} routes, ${functions.length} deployed functions, ${diagramStems.length} rendered diagrams.`,
);
