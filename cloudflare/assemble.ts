// Assemble the Cloudflare Pages upload directory: the committed SvelteKit
// build in public/ plus the worker (worker.ts with its types stripped —
// Pages advanced mode wants a plain _worker.js at the upload root). .pages-dist/ is gitignored; the deploy
// runs wrangler from inside it so the repo's Firebase functions/ directory
// is never mistaken for Pages Functions.
import {access, cp, readFile, rm, writeFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';

const root = new URL('../', import.meta.url);
const publicDir = new URL('public/', root);
const dist = new URL('.pages-dist/', root);

await access(new URL('index.html', publicDir));
await access(new URL('_app/version.json', publicDir));
await rm(dist, {recursive: true, force: true});
await cp(publicDir, dist, {recursive: true, filter: (source) => !source.endsWith('.DS_Store')});
const workerSource = await readFile(new URL('worker.ts', import.meta.url), 'utf8');
await writeFile(new URL('_worker.js', dist), stripTypeScriptTypes(workerSource, {mode: 'strip'}));
console.log(`assembled ${dist.pathname}`);
