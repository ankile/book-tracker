import {mkdir, readFile, writeFile} from 'node:fs/promises';

const sourceUrl = new URL('./public/index.html', import.meta.url);
const assetsUrl = new URL('./functions/assets/', import.meta.url);
const targetUrl = new URL('profile-shell.html', assetsUrl);

const markers = [
  '<title data-shell-title>Personal Book Tracker</title>',
  'data-shell-description',
  '<meta data-profile-head-slot content="" />',
  '<div id="profile-snapshot-slot"></div>',
];

const shell = (await readFile(sourceUrl, 'utf8')).replace(/[\t ]+$/gm, '');
for (const marker of markers) {
  const matches = shell.split(marker).length - 1;
  if (matches !== 1) {
    throw new Error(`public/index.html must contain ${marker} exactly once; found ${matches}`);
  }
}

await mkdir(assetsUrl, {recursive: true});
await writeFile(sourceUrl, shell);
await writeFile(targetUrl, shell);
