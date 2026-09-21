import assert from 'node:assert/strict';
import test from 'node:test';

import {immutableAssetPaths, sitemapProfilePaths, verifyRelease} from '../release-check.ts';

const endpoints = {site: 'https://site.test', origin: 'https://origin.test'};

function shellFor(entry: string): string {
  return `<!DOCTYPE html><html><head>
    <link rel="modulepreload" href="/_app/immutable/entry/start.${entry}.js">
    <link rel="modulepreload" href="/_app/immutable/entry/app.${entry}.js">
    <link rel="stylesheet" href="/_app/immutable/assets/0.${entry}.css">
    <script type="module">import("/_app/immutable/entry/start.${entry}.js")</script>
  </head><body></body></html>`;
}

const SITEMAP = `<?xml version="1.0"?><urlset><url><loc>https://site.test/profiles/lars</loc></url></urlset>`;

type Reply = {status: number; type: string; body: string};

// A site as Cloudflare Pages behaves: known bundle paths are assets, every
// other path is the SPA shell with 200 text/html.
function fakeFetch(parts: {
  sitemap?: Reply;
  rendered: Reply;
  siteIndex: string;
  siteAssets: string[];
}): typeof fetch & {requests: string[]} {
  const requests: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    const reply = (r: Reply) => new Response(r.body, {status: r.status, headers: {'content-type': r.type}});
    if (url === `${endpoints.origin}/sitemap.xml`) {
      return reply(parts.sitemap ?? {status: 200, type: 'application/xml', body: SITEMAP});
    }
    if (url === `${endpoints.origin}/profiles/lars`) return reply(parts.rendered);
    if (url.startsWith(`${endpoints.site}/`)) {
      const path = url.slice(endpoints.site.length);
      if (parts.siteAssets.includes(path)) {
        return reply({status: 200, type: path.endsWith('.css') ? 'text/css' : 'text/javascript', body: ''});
      }
      return reply({status: 200, type: 'text/html; charset=utf-8', body: parts.siteIndex});
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch & {requests: string[]};
  impl.requests = requests;
  return impl;
}

test('immutableAssetPaths lists every bundle reference once, sorted', () => {
  assert.deepEqual(immutableAssetPaths(shellFor('A1')), [
    '/_app/immutable/assets/0.A1.css',
    '/_app/immutable/entry/app.A1.js',
    '/_app/immutable/entry/start.A1.js',
  ]);
  assert.deepEqual(immutableAssetPaths('<html></html>'), []);
});

test('sitemapProfilePaths keeps profile paths only', () => {
  const xml = `<urlset><url><loc>https://site.test/</loc></url>${SITEMAP}<url><loc>https://site.test/profiles/ann</loc></url></urlset>`;
  assert.deepEqual(sitemapProfilePaths(xml), ['/profiles/lars', '/profiles/ann']);
});

test('a consistent release has no problems and never touches the edge copy of the profile', async () => {
  const shell = shellFor('A1');
  const fetchImpl = fakeFetch({
    rendered: {status: 200, type: 'text/html', body: shell},
    siteIndex: shell,
    siteAssets: immutableAssetPaths(shell),
  });
  assert.deepEqual(await verifyRelease(fetchImpl, shell, endpoints), []);
  assert.ok(fetchImpl.requests.includes(`GET ${endpoints.origin}/profiles/lars`));
  assert.ok(!fetchImpl.requests.includes(`GET ${endpoints.site}/profiles/lars`));
  assert.ok(fetchImpl.requests.includes(`HEAD ${endpoints.site}/_app/immutable/entry/app.A1.js`));
});

test('the 2026-09-21 state fails: renderer references entries the site answers with the SPA shell', async () => {
  const current = shellFor('B2');
  const stale = shellFor('A1');
  const fetchImpl = fakeFetch({
    rendered: {status: 200, type: 'text/html', body: stale},
    siteIndex: current,
    siteAssets: immutableAssetPaths(current),
  });
  const problems = await verifyRelease(fetchImpl, current, endpoints);
  assert.match(problems[0], /renderer serves a shell that differs from functions\/assets\/profile-shell\.html/);
  const missing = problems.filter((p) => /the site answers 200 text\/html/.test(p));
  assert.equal(missing.length, 3, problems.join('\n'));
  assert.match(missing[0], /\/_app\/immutable\/assets\/0\.A1\.css/);
});

test('a site released from an older commit than HEAD fails', async () => {
  const head = shellFor('B2');
  const old = shellFor('A1');
  const fetchImpl = fakeFetch({
    rendered: {status: 200, type: 'text/html', body: head},
    siteIndex: old,
    siteAssets: immutableAssetPaths(old),
  });
  const problems = await verifyRelease(fetchImpl, head, endpoints);
  assert.equal(problems.filter((p) => /site serves a bundle that differs/.test(p)).length, 1, problems.join('\n'));
  assert.equal(problems.filter((p) => /the site answers 200 text\/html/.test(p)).length, 3);
});

test('an asset the site cannot serve fails even when both shells agree', async () => {
  const shell = shellFor('A1');
  const fetchImpl = fakeFetch({
    rendered: {status: 200, type: 'text/html', body: shell},
    siteIndex: shell,
    siteAssets: immutableAssetPaths(shell).filter((p) => !p.endsWith('app.A1.js')),
  });
  const problems = await verifyRelease(fetchImpl, shell, endpoints);
  assert.deepEqual(
    problems.map((p) => p.split(' — ')[0]),
    ['renderer references /_app/immutable/entry/app.A1.js but the site answers 200 text/html; charset=utf-8'],
  );
});

test('a renderer that cannot answer is reported instead of passing vacuously', async () => {
  const shell = shellFor('A1');
  const assets = immutableAssetPaths(shell);
  assert.deepEqual(
    await verifyRelease(fakeFetch({rendered: {status: 503, type: 'text/plain', body: ''}, siteIndex: shell, siteAssets: assets}), shell, endpoints),
    ['renderer answered 503 for /profiles/lars'],
  );
  assert.deepEqual(
    await verifyRelease(fakeFetch({sitemap: {status: 503, type: 'text/plain', body: ''}, rendered: {status: 200, type: 'text/html', body: shell}, siteIndex: shell, siteAssets: assets}), shell, endpoints),
    ['renderer sitemap answered 503'],
  );
  assert.deepEqual(
    await verifyRelease(fakeFetch({sitemap: {status: 200, type: 'application/xml', body: '<urlset></urlset>'}, rendered: {status: 200, type: 'text/html', body: shell}, siteIndex: shell, siteAssets: assets}), shell, endpoints),
    ['renderer sitemap lists no public profile to check'],
  );
});
