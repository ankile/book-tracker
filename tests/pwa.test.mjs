import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const manifestPath = new URL('../static/manifest.json', import.meta.url);
const appTemplatePath = new URL('../src/app.html', import.meta.url);
const serviceWorkerPath = new URL('../src/service-worker.js', import.meta.url);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

test('manifest has a stable standalone launch configuration', () => {
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.background_color, manifest.theme_color);
});

test('declared app icons exist at their exact dimensions without alpha', async () => {
  for (const icon of manifest.icons) {
    const file = new URL(`../static${icon.src}`, import.meta.url);
    const png = await readFile(file);
    const [expectedWidth, expectedHeight] = icon.sizes.split('x').map(Number);

    assert.equal(png.toString('ascii', 1, 4), 'PNG');
    assert.equal(png.readUInt32BE(16), expectedWidth);
    assert.equal(png.readUInt32BE(20), expectedHeight);
    assert.equal(png[25], 2, `${icon.src} must be an opaque RGB PNG`);
  }
});

test('iPhone metadata and launch colors match the manifest', async () => {
  const html = await readFile(appTemplatePath, 'utf8');

  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /apple-mobile-web-app-status-bar-style" content="black-translucent"/);
  assert.match(html, /rel="apple-touch-icon"/);
  assert.match(html, new RegExp(`theme-color" content="${manifest.theme_color}"`));
  assert.match(html, new RegExp(`background-color: ${manifest.background_color}`));
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net/);
});

test('service worker excludes screenshots and does not grow a navigation cache', async () => {
  const source = await readFile(serviceWorkerPath, 'utf8');

  assert.match(source, /files\.filter\(\(path\) => !path\.startsWith\('\/screenshots\/'\)\)/);
  assert.doesNotMatch(source, /cache\.put\(request/);
  assert.match(source, /caches\s*\.match\(APP_SHELL\)/);
});
