import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { test } from 'node:test';

const manifestPath = new URL('../static/manifest.json', import.meta.url);
const appTemplatePath = new URL('../src/app.html', import.meta.url);
const serviceWorkerPath = new URL('../src/service-worker.ts', import.meta.url);
const robotsPath = new URL('../static/robots.txt', import.meta.url);
const staticDir = new URL('../static/', import.meta.url);
const profileCardPath = new URL('social/profile-card.jpg', staticDir);
// Every file under static/ is served unauthenticated from the CDN; egress is
// billed per byte and cannot be capped (SEC-067), so nothing fat lives here.
const MAX_STATIC_FILE_BYTES = 150 * 1024;

function jpegDimensions(jpeg: Buffer): { width: number; height: number } {
  assert.equal(jpeg.readUInt16BE(0), 0xffd8, 'not a JPEG');
  let offset = 2;
  while (offset < jpeg.length) {
    assert.equal(jpeg[offset], 0xff, `bad marker at ${offset}`);
    const marker = jpeg[offset + 1];
    const length = jpeg.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: jpeg.readUInt16BE(offset + 5), width: jpeg.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  throw new Error('no SOF marker');
}

async function walk(dir: URL): Promise<URL[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const child = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, dir);
    return entry.isDirectory() ? walk(child) : [child];
  }));
  return files.flat();
}
const firebaseConfigPath = new URL('../firebase.json', import.meta.url);
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

test('profile social card is a JPEG at the large-preview size declared by the renderer', async () => {
  const jpeg = await readFile(profileCardPath);

  assert.deepEqual(jpegDimensions(jpeg), { width: 1200, height: 630 });
  assert.ok(jpeg.length < 100 * 1024, `profile card is ${jpeg.length} bytes`);
});

test('no file under static/ is large enough to be a cheap egress target', async () => {
  const files = await walk(staticDir);
  assert.ok(files.some((file) => file.href === profileCardPath.href), 'static/ walk missed the profile card');
  for (const file of files) {
    const { size } = await stat(file);
    assert.ok(size <= MAX_STATIC_FILE_BYTES, `${file.pathname} is ${size} bytes`);
  }
  assert.ok(!files.some((file) => file.pathname.includes('/static/screenshots/')), 'screenshots belong in docs/, not static/');
});

test('service worker precaches every static file and does not grow a navigation cache', async () => {
  const source = await readFile(serviceWorkerPath, 'utf8');

  assert.match(source, /\[\.\.\.build, \.\.\.files, APP_SHELL\]/);
  assert.doesNotMatch(source, /files\.filter/);
  assert.doesNotMatch(source, /cache\.put\(request/);
  assert.match(source, /caches\s*\.match\(APP_SHELL\)/);
});

test('robots allow crawling and advertise the generated sitemap', async () => {
  const robots = await readFile(robotsPath, 'utf8');

  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.match(robots, /^Sitemap: https:\/\/book\.ankile\.com\/sitemap\.xml$/m);
  assert.doesNotMatch(robots, /Disallow:\s*\/profiles/i);
});

test('the Firebase Hosting site is retired to a redirect: no rewrites, nothing servable', async () => {
  const config = JSON.parse(await readFile(firebaseConfigPath, 'utf8'));
  const hosting = config.hosting;

  assert.equal(hosting.public, 'hosting-retired');
  assert.equal(hosting.rewrites, undefined);
  assert.deepEqual(hosting.redirects, [{
    source: '/:path*',
    destination: 'https://book.ankile.com/:path',
    type: 301,
  }]);
  assert.equal(JSON.stringify(hosting).includes('publicweb'), false);
  assert.equal(JSON.stringify(hosting).includes('pinTag'), false);

  const retired = await readdir(new URL('../hosting-retired/', import.meta.url));
  assert.deepEqual(retired, ['404.html']);
});

test('JavaScript clients skip the crawler snapshot instead of flashing a second profile design', async () => {
  const html = await readFile(appTemplatePath, 'utf8');

  assert.match(html, /document\.documentElement\.classList\.add\('js'\)/);
  assert.match(html, /html:not\(\.js\) #profile-snapshot-slot:not\(:empty\) \+ #app-shell/);
  assert.match(html, /html\.js #profile-snapshot-slot:not\(:empty\)/);
});
