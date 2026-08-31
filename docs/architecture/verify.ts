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
];

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function applicationRoutes(): string[] {
  const routesRoot = join(repositoryRoot, 'src/routes');
  return filesBelow(routesRoot)
    .filter((path) => path.endsWith('/+page.svelte'))
    .map((path) => {
      const directory = relative(routesRoot, dirname(path));
      return directory === '' ? '/' : `/${directory}`;
    })
    .sort();
}

function deployedFunctions(): string[] {
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

const navigationDiagram = readFileSync(join(architectureDir, 'site-functionality.mmd'), 'utf8');
const accessSourcePath = join(architectureDir, 'site-access.ts');
const accessSource = readFileSync(accessSourcePath, 'utf8');
const routes = applicationRoutes();
const functions = deployedFunctions();

for (const route of routes) {
  const navigationMarker = route === '/' ? '<code>/</code>' : route;
  const accessMarker = `path: '${route}'`;
  assert(navigationDiagram.includes(navigationMarker), `site-functionality.mmd is missing route ${route}`);
  assert(accessSource.includes(accessMarker), `site-access.ts is missing route ${route}`);
}

const publicSourcePaths = [
  join(architectureDir, 'README.md'),
  ...diagramStems.map((stem) => join(architectureDir, `${stem}.mmd`)),
  accessSourcePath,
];
const projectConfig: unknown = JSON.parse(readFileSync(join(repositoryRoot, '.firebaserc'), 'utf8'));
assert(typeof projectConfig === 'object' && projectConfig !== null && 'projects' in projectConfig);
assert(typeof projectConfig.projects === 'object' && projectConfig.projects !== null);
const projectIdentifiers = Object.values(projectConfig.projects ?? {});
const implementationIdentifiers = [...functions, ...projectIdentifiers];
const forbiddenPatterns = [
  { description: 'absolute web URL', pattern: /https?:\/\//i },
  { description: 'email or service-account address', pattern: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i },
  { description: 'IP address', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
  { description: 'localhost port', pattern: /\blocalhost:\d+\b/i },
  { description: 'cloud region identifier', pattern: /\b[a-z]+-[a-z]+\d\b/ },
  { description: 'secret-like uppercase identifier', pattern: /\b[A-Z][A-Z0-9_]{5,}\b/ },
  { description: 'backend resource placeholder', pattern: /\{(?:uid|userId|bookId|queueId)\}/ },
];

interface ForbiddenPattern {
  description: string;
  pattern: RegExp;
}

function assertSanitizedText(path: string, extraPatterns: ForbiddenPattern[] = []): void {
  const source = readFileSync(path, 'utf8');
  const disclosureScanSource = source
    .replaceAll('http://www.w3.org/2000/svg', '')
    .replaceAll('http://www.w3.org/1999/xhtml', '')
    .replaceAll('http://www.w3.org/1999/xlink', '');
  const sourceName = relative(repositoryRoot, path);
  for (const identifier of implementationIdentifiers) {
    assert(!disclosureScanSource.includes(identifier), `${sourceName} exposes implementation identifier ${identifier}`);
  }
  for (const { description, pattern } of [...forbiddenPatterns, ...extraPatterns]) {
    assert(!pattern.test(disclosureScanSource), `${sourceName} contains a ${description}`);
  }
}

for (const sourcePath of publicSourcePaths) assertSanitizedText(sourcePath);

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

const accessSvgPath = join(architectureDir, 'site-access.svg');
const accessPngPath = join(architectureDir, 'site-access.png');
assert(existsSync(accessSvgPath), 'site-access.svg has not been rendered');
assert(existsSync(accessPngPath), 'site-access.png has not been rendered');
assert(statSync(accessSvgPath).mtimeMs >= statSync(accessSourcePath).mtimeMs, 'site-access.svg is older than its source');
assert(statSync(accessPngPath).mtimeMs >= statSync(accessSvgPath).mtimeMs, 'site-access.png is older than its SVG');
const accessSvg = readFileSync(accessSvgPath, 'utf8');
assert(accessSvg.includes('<title id="title">'), 'site-access.svg is missing an accessible title');
assert(accessSvg.includes('<desc id="description">'), 'site-access.svg is missing an accessible description');

const renderedSvgPaths = [
  ...diagramStems.map((stem) => join(architectureDir, `${stem}.svg`)),
  accessSvgPath,
];
const artifactPatterns = [
  { description: 'active SVG content', pattern: /<(?:script|iframe|object|embed)\b|javascript:|\bon[a-z]+\s*=/i },
  { description: 'local filesystem reference', pattern: /file:\/\/|\/Users\/|[A-Z]:\\/i },
];
for (const svgPath of renderedSvgPaths) assertSanitizedText(svgPath, artifactPatterns);

console.log(
  `Architecture docs verified: ${routes.length} routes and ${diagramStems.length + 1} sanitized rendered diagrams.`,
);
