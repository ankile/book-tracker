import assert from 'node:assert/strict';
import {afterEach, beforeEach, test} from 'node:test';

import worker, {
  BASE_HEADERS,
  IMMUTABLE_CACHE_CONTROL,
  ORIGIN,
  PROFILE_CACHE_CONTROL,
  SITEMAP_CACHE_CONTROL,
  cacheControlFor,
  isRenderedPath,
} from '../cloudflare/worker.ts';

const SITE = 'https://book.ankile.com';

type Call = {url: string; init: RequestInit | undefined};

let originCalls: Call[];
let assetCalls: Request[];
let originHandler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
const realFetch = globalThis.fetch;

function env() {
  return {
    ASSETS: {
      fetch: async (request: Request) => {
        assetCalls.push(request);
        const path = new URL(request.url).pathname;
        if (path.startsWith('/_app/immutable/')) {
          return new Response('js', {headers: {'Content-Type': 'text/javascript', 'ETag': '"abc"'}});
        }
        // Pages serves index.html for unknown paths (SPA mode); the worker
        // must not care which asset came back.
        return new Response('<html>shell</html>', {headers: {'Content-Type': 'text/html; charset=utf-8'}});
      },
    },
  };
}

function run(path: string, init: RequestInit = {}) {
  return worker.fetch(new Request(`${SITE}${path}`, init), env());
}

function assertPolicy(response: Response, cacheControl: string) {
  for (const [name, value] of Object.entries(BASE_HEADERS)) {
    if (name === 'Cache-Control') continue;
    assert.equal(response.headers.get(name), value, name);
  }
  assert.equal(response.headers.get('Cache-Control'), cacheControl);
}

beforeEach(() => {
  originCalls = [];
  assetCalls = [];
  originHandler = () => new Response('<html>profile</html>', {
    status: 200,
    headers: {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'from-origin', 'Vary': 'Accept-Encoding'},
  });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    originCalls.push({url, init});
    return originHandler(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('the path classifier mirrors the Hosting rewrite and header globs', () => {
  assert.equal(isRenderedPath('/sitemap.xml'), true);
  assert.equal(isRenderedPath('/profiles/lars'), true);
  assert.equal(isRenderedPath('/profiles/lars.json'), true);
  assert.equal(isRenderedPath('/profiles'), false);
  assert.equal(isRenderedPath('/sitemap.xml.bak'), false);
  assert.equal(isRenderedPath('/'), false);

  assert.equal(cacheControlFor('/sitemap.xml'), SITEMAP_CACHE_CONTROL);
  assert.equal(cacheControlFor('/profiles/lars'), PROFILE_CACHE_CONTROL);
  assert.equal(cacheControlFor('/_app/immutable/chunks/x.js'), IMMUTABLE_CACHE_CONTROL);
  assert.equal(cacheControlFor('/'), 'no-cache');
  assert.equal(cacheControlFor('/_app/version.json'), 'no-cache');
});

test('static paths come from the Pages bundle with the full header policy', async () => {
  const response = await run('/');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<html>shell</html>');
  assertPolicy(response, 'no-cache');
  assert.equal(assetCalls.length, 1);
  assert.equal(originCalls.length, 0);
});

test('immutable build chunks keep their long cache lifetime and upstream headers', async () => {
  const response = await run('/_app/immutable/chunks/x.js');
  assertPolicy(response, IMMUTABLE_CACHE_CONTROL);
  assert.equal(response.headers.get('ETag'), '"abc"');
  assert.equal(response.headers.get('Content-Type'), 'text/javascript');
});

test('a stale immutable URL that falls back to the shell is not cached as immutable', async () => {
  const response = await run('/_app/immutable/chunks/gone.js');
  // env().ASSETS only answers text/javascript for /_app/immutable/; force the shell path.
  assert.equal(response.headers.get('Cache-Control'), IMMUTABLE_CACHE_CONTROL);

  const shellEnv = {ASSETS: {fetch: async () => new Response('<html>shell</html>', {headers: {'Content-Type': 'text/html; charset=utf-8'}})}};
  const stale = await worker.fetch(new Request(`${SITE}/_app/immutable/chunks/gone.js`), shellEnv);
  assert.equal(stale.status, 200);
  assertPolicy(stale, 'no-cache');
});

test('a profile page is proxied to the renderer origin with the query string and only safe request headers', async () => {
  const response = await run('/profiles/lars?x=1', {
    headers: {
      'Accept': 'text/html',
      'Accept-Encoding': 'br, gzip',
      'User-Agent': 'probe/1',
      'Cookie': 'session=secret',
      'Authorization': 'Bearer nope',
      'X-Forwarded-For': '203.0.113.9',
    },
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '<html>profile</html>');
  assertPolicy(response, PROFILE_CACHE_CONTROL);
  assert.equal(response.headers.get('Vary'), 'Accept-Encoding');
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(assetCalls.length, 0);

  assert.equal(originCalls.length, 1);
  const [call] = originCalls;
  assert.equal(call.url, `${ORIGIN}/profiles/lars?x=1`);
  assert.equal(call.init?.method, 'GET');
  assert.equal(call.init?.redirect, 'manual');
  const sent = call.init?.headers as Headers;
  assert.equal(sent.get('accept'), 'text/html');
  assert.equal(sent.get('accept-encoding'), 'br, gzip');
  assert.equal(sent.get('user-agent'), 'probe/1');
  assert.equal(sent.get('cookie'), null);
  assert.equal(sent.get('authorization'), null);
  assert.equal(sent.get('x-forwarded-for'), null);
});

test('profile JSON and the sitemap are proxied with their own cache lifetimes', async () => {
  const json = await run('/profiles/lars.json');
  assertPolicy(json, PROFILE_CACHE_CONTROL);
  assert.equal(originCalls.at(-1)?.url, `${ORIGIN}/profiles/lars.json`);

  const sitemap = await run('/sitemap.xml');
  assertPolicy(sitemap, SITEMAP_CACHE_CONTROL);
  assert.equal(originCalls.at(-1)?.url, `${ORIGIN}/sitemap.xml`);
  assert.equal(assetCalls.length, 0);
});

test('HEAD reaches the renderer as HEAD; other methods are refused without an origin call', async () => {
  const head = await run('/profiles/lars', {method: 'HEAD'});
  assert.equal(head.status, 200);
  assert.equal(originCalls.at(-1)?.init?.method, 'HEAD');

  const post = await run('/profiles/lars', {method: 'POST', body: 'x'});
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('Allow'), 'GET, HEAD');
  assertPolicy(post, PROFILE_CACHE_CONTROL);
  assert.equal(originCalls.length, 1);
  assert.equal(assetCalls.length, 0);
});

test('the trailing-slash profile URL redirects permanently, as the Hosting redirect did', async () => {
  const response = await run('/profiles/lars/?utm=1');
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('Location'), `${SITE}/profiles/lars?utm=1`);
  assertPolicy(response, PROFILE_CACHE_CONTROL);
  assert.equal(originCalls.length, 0);
  assert.equal(assetCalls.length, 0);
});

test('renderer errors pass through untouched instead of falling back to the SPA shell', async () => {
  originHandler = () => new Response('<html>missing</html>', {
    status: 404,
    headers: {'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex'},
  });
  const missing = await run('/profiles/nobody');
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), '<html>missing</html>');
  assert.equal(missing.headers.get('X-Robots-Tag'), 'noindex');
  assertPolicy(missing, PROFILE_CACHE_CONTROL);

  originHandler = () => new Response('boom', {status: 500});
  const failed = await run('/profiles/lars');
  assert.equal(failed.status, 500);
  assert.equal(assetCalls.length, 0);
});

test('an unreachable renderer fails closed with a 503, never the shell', async () => {
  originHandler = () => {
    throw new TypeError('fetch failed');
  };
  const response = await run('/profiles/lars');
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Retry-After'), '30');
  assert.match(await response.text(), /unavailable/);
  assertPolicy(response, PROFILE_CACHE_CONTROL);
  assert.equal(assetCalls.length, 0);
});

test('the header policy is the firebase.json Hosting policy, verbatim', async () => {
  const {readFile} = await import('node:fs/promises');
  const config = JSON.parse(await readFile(new URL('../firebase.json', import.meta.url), 'utf8'));
  const blocks = Object.fromEntries(
    config.hosting.headers.map((block: {source: string; headers: {key: string; value: string}[]}) => [
      block.source,
      Object.fromEntries(block.headers.map((h) => [h.key, h.value])),
    ]),
  );
  assert.deepEqual(blocks['**'], BASE_HEADERS);
  assert.equal(blocks['/_app/immutable/**']['Cache-Control'], IMMUTABLE_CACHE_CONTROL);
  assert.equal(blocks['/profiles/**']['Cache-Control'], PROFILE_CACHE_CONTROL);
  assert.equal(blocks['/sitemap.xml']['Cache-Control'], SITEMAP_CACHE_CONTROL);
});
