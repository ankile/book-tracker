import {createHash} from 'node:crypto';
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';

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
    const content = readFileSync(path);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const hostingHash = createHash('sha256')
      .update(gzipSync(content, {level: 9}))
      .digest('hex');
    return [deploymentPath, {sha256, hostingHash}] as const;
  })
  .sort(([left], [right]) => left.localeCompare(right)));

writeFileSync(
  join(root, 'hosting-artifacts.json'),
  `${JSON.stringify({version: 2, files}, null, 2)}\n`,
);
