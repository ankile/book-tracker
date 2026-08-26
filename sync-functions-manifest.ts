import {createHash} from 'node:crypto';
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, sep} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const functionsRoot = join(root, 'functions');

function compiledRuntimeFiles(directory: string): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'scripts') return [];
      return compiledRuntimeFiles(path);
    }
    return entry.name.endsWith('.js') ? [path] : [];
  });
}

function sha256(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex');
}

const paths = [
  join(functionsRoot, '.gitignore'),
  join(functionsRoot, '.npmrc'),
  join(functionsRoot, 'package-lock.json'),
  join(functionsRoot, 'package.json'),
  join(functionsRoot, 'assets/profile-shell.html'),
  ...compiledRuntimeFiles(join(functionsRoot, 'lib')),
];
const files = Object.fromEntries(paths.map((path) => [
  relative(functionsRoot, path).split(sep).join('/'),
  sha256(readFileSync(path)),
] as const).sort(([left], [right]) => left.localeCompare(right)));

const renderer = await import(pathToFileURL(
  join(functionsRoot, 'lib/publicProfileRenderer.js'),
).href) as {renderNotFoundDocument(shell: string): string};
const shell = readFileSync(join(functionsRoot, 'assets/profile-shell.html'), 'utf8');
const profileProbeSha256 = sha256(renderer.renderNotFoundDocument(shell));

writeFileSync(
  join(root, 'functions-artifacts.json'),
  `${JSON.stringify({version: 1, files, profileProbeSha256}, null, 2)}\n`,
);
