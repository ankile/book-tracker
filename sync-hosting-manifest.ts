import {createHash} from 'node:crypto';
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const publicRoot = join(root, 'public');

function hostingFiles(directory: string): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return hostingFiles(path);
    if (entry.name === '.DS_Store') return [];
    return [path];
  });
}

const files = Object.fromEntries(hostingFiles(publicRoot)
  .map((path) => {
    const deploymentPath = relative(publicRoot, path).split(sep).join('/');
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
    return [deploymentPath, hash] as const;
  })
  .sort(([left], [right]) => left.localeCompare(right)));

writeFileSync(
  join(root, 'hosting-artifacts.json'),
  `${JSON.stringify({version: 1, files}, null, 2)}\n`,
);
