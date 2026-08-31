import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// SEC-007. The built pages carry the Content-Security-Policy in a <meta>
// tag; these pins keep the policy from silently regressing: an inline
// script whose hash is missing breaks the whole app at once, and a
// re-appearing 'unsafe-inline' would let a future injection bug execute.

const indexHtml = readFileSync('public/index.html', 'utf8');
const shellHtml = readFileSync('functions/assets/profile-shell.html', 'utf8');

function metaPolicy(html: string): string {
  const m = html.match(/<meta http-equiv="content-security-policy" content="([^"]+)">/);
  assert.ok(m, 'the built page must carry a CSP meta tag');
  return m[1];
}

test('every inline script in the built page is hash-allowlisted, nothing else is', () => {
  const policy = metaPolicy(indexHtml);
  const scriptSrc = policy.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src '));
  assert.ok(scriptSrc, 'script-src present');
  assert.doesNotMatch(scriptSrc, /unsafe-inline|unsafe-eval/);
  const bodies = [...indexHtml.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    .filter(([tag]) => !tag.includes('src='))
    .map(([, body]) => body);
  assert.ok(bodies.length >= 2, 'the bootstrap and classList scripts are inline');
  for (const body of bodies) {
    const hash = createHash('sha256').update(body).digest('base64');
    assert.ok(scriptSrc.includes(`'sha256-${hash}'`), `inline script hash sha256-${hash} missing from script-src`);
  }
});

test('the policy pins the injection-relevant directives', () => {
  const policy = metaPolicy(indexHtml);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /base-uri 'none'/);
  assert.match(policy, /default-src 'self'/);
  for (const endpoint of [
    'https://firestore.googleapis.com',
    'https://identitytoolkit.googleapis.com',
    'https://securetoken.googleapis.com',
    'https://firebaseinstallations.googleapis.com',
    'https://content-firebaseappcheck.googleapis.com',
    'https://europe-west1-book-tracker-d8f24.cloudfunctions.net',
    'https://api.nb.no',
    'https://openlibrary.org',
  ]) {
    assert.ok(policy.includes(endpoint), `connect-src must include ${endpoint}`);
  }
  assert.match(policy, /frame-src https:\/\/www\.google\.com\/recaptcha\//);
});

test('the Cloudflare Web Analytics beacon is allowed and nothing else third-party runs', () => {
  const policy = metaPolicy(indexHtml);
  const directive = (name: string) =>
    policy.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';
  const scriptSrc = directive('script-src');
  const connectSrc = directive('connect-src');
  assert.ok(scriptSrc.includes('https://static.cloudflareinsights.com'), 'beacon script origin');
  assert.ok(connectSrc.includes('https://cloudflareinsights.com'), 'beacon report origin');
  // The only script hosts besides self and the inline hashes: reCAPTCHA and the beacon.
  const hosts = scriptSrc.split(/\s+/).slice(1).filter((s) => s.startsWith('https://'));
  assert.deepEqual(hosts.sort(), [
    'https://static.cloudflareinsights.com',
    'https://www.google.com/recaptcha/',
    'https://www.gstatic.com/recaptcha/',
  ]);
});

test('the profile shell serves the same policy as the SPA', () => {
  assert.equal(metaPolicy(shellHtml), metaPolicy(indexHtml));
});

test('the header-only directives live in the Pages worker and publicweb', async () => {
  const {BASE_HEADERS} = await import('../cloudflare/worker.ts');
  assert.equal(BASE_HEADERS['Content-Security-Policy'], "frame-ancestors 'none'");
  assert.equal(BASE_HEADERS['X-Frame-Options'], 'DENY');
  assert.equal(BASE_HEADERS['X-Content-Type-Options'], 'nosniff');
  assert.match(BASE_HEADERS['Permissions-Policy'], /camera=\(\)/);
  const publicWeb = readFileSync('functions/src/publicWeb.ts', 'utf8');
  assert.match(publicWeb, /"Content-Security-Policy": "frame-ancestors 'none'",\s*"X-Frame-Options": "DENY",\s*"X-Content-Type-Options": "nosniff",\s*"Referrer-Policy": "no-referrer",/);
  assert.match(publicWeb, /const headers = \{\.\.\.SECURITY_HEADERS, \.\.\.response\.headers\};/);
});
