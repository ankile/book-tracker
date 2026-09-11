import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { ADMIN_UID, Database, starts, stops } from './fixtures/prefetch-stores.ts';

// Exercise the production prefetch functions with observable stores, without
// initializing Firebase or opening network connections.
const fixture = new URL('./fixtures/prefetch-stores.ts', import.meta.url).href;
const mocks = new Set([
  '$app/navigation', '$lib/admin-uid.ts', '$lib/firebase/db.ts',
  '$lib/firebase/adminCatalog.ts', '$lib/firebase/functions.ts',
]);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (mocks.has(specifier)) return { url: fixture, shortCircuit: true };
    if (specifier === '$lib/admin.ts') {
      return { url: new URL('../src/lib/admin.ts', import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
// Dynamic import keeps the mocks in place before resolving production imports.
const appModule = new URL('../src/lib/app-prefetch.ts', import.meta.url).href;
const { startAppPrefetch } = await import(appModule);

// The old operator prefetch schedules its admin import after an idle callback.
Object.defineProperty(globalThis, 'window', {
  value: { requestIdleCallback: (callback: () => void) => { callback(); return 1; } },
  configurable: true,
});
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('Reading prefetch never opens history or admin subscriptions for the operator', async () => {
  const release = startAppPrefetch(ADMIN_UID) as () => void;
  await import(new URL('../src/lib/admin.ts', import.meta.url).href);
  await settle();
  release();
  assert.equal(starts.get(`history:${ADMIN_UID}`) ?? 0, 0);
  assert.equal(starts.get('admin') ?? 0, 0);
  assert.equal(starts.get(`books:${ADMIN_UID}`), 1);
  assert.equal(stops.get(`books:${ADMIN_UID}`), 1);
});

test('/me owns one history source and leaving releases it despite global prefetch', () => {
  const uid = 'history-owner';
  const stopPrefetch = startAppPrefetch(uid) as () => void;
  const history = Database.getAllReadingSessions(uid);
  const firstValues: string[][] = [];
  const leaveMe = history.subscribe((value) => firstValues.push(value));
  assert.equal(starts.get(`history:${uid}`), 1);
  leaveMe();
  const stopsAfterLeaving = stops.get(`history:${uid}`) ?? 0;
  const returningValues: string[][] = [];
  const leaveAgain = history.subscribe((value) => returningValues.push(value));
  leaveAgain();
  stopPrefetch();
  assert.equal(stopsAfterLeaving, 1, 'history must stop while Reading remains mounted');
  assert.deepEqual(returningValues, firstValues, 'returning consumers receive retained data');
  assert.equal(starts.get(`history:${uid}`), 2);
});

test('global prefetch effect tracks scalar uid rather than user object emissions', () => {
  const source = readFileSync(new URL('../src/routes/+layout.svelte', import.meta.url), 'utf8');
  assert.match(source, /const userId = \$derived\(\$user\?\.uid\)/);
  const effectStart = source.indexOf('$effect(() => {');
  assert.ok(effectStart >= 0);
  assert.doesNotMatch(source.slice(effectStart, source.indexOf('</script>')), /\$user/);
});

test('admin layout owns the catalog keepalive for its mounted lifetime', async () => {
  const layoutPath = new URL('../src/routes/admin/+layout.svelte', import.meta.url);
  const source = readFileSync(layoutPath, 'utf8');
  assert.match(source, /startAdminPrefetch\(catalogOwner\)/);
  const { startAdminPrefetch } = await import(new URL('../src/lib/admin.ts', import.meta.url).href);
  const { adminCatalogScan } = await import(fixture);
  const beforeStarts = starts.get('admin') ?? 0;
  const beforeStops = stops.get('admin') ?? 0;
  const leaveAdmin = startAdminPrefetch(ADMIN_UID) as () => void;
  const leaveOverview = adminCatalogScan.subscribe(() => {});
  leaveOverview();
  const leaveWork = adminCatalogScan.subscribe(() => {});
  assert.equal(starts.get('admin'), beforeStarts + 1, 'admin navigation shares its source');
  leaveWork();
  assert.equal(stops.get('admin') ?? 0, beforeStops, 'shared layout keeps the source alive');
  leaveAdmin();
  assert.equal(stops.get('admin'), beforeStops + 1);
});

test('admin prefetch refuses absent and non-operator identities', async () => {
  const { startAdminPrefetch } = await import(new URL('../src/lib/admin.ts', import.meta.url).href);
  const before = starts.get('admin') ?? 0;
  for (const uid of [undefined, 'another-reader']) {
    const stop = startAdminPrefetch(uid) as () => void;
    stop();
  }
  assert.equal(starts.get('admin') ?? 0, before);
});

test('catalog ownership excludes account-only and denied routes', async () => {
  const { adminCatalogOwner } = await import(new URL('../src/lib/admin.ts', import.meta.url).href);
  for (const route of ['/admin', '/admin/works/[workId]', '/admin/authors/[authorId]']) {
    assert.equal(adminCatalogOwner(ADMIN_UID, route), ADMIN_UID);
    assert.equal(adminCatalogOwner('another-reader', route), undefined);
    assert.equal(adminCatalogOwner(undefined, route), undefined);
  }
  for (const route of ['/admin/users', '/', null, '/admin/unknown']) {
    assert.equal(adminCatalogOwner(ADMIN_UID, route), undefined);
  }
});

test('admin layout reacts to scalar ownership changes and returns listener cleanup', () => {
  const source = readFileSync(new URL('../src/routes/admin/+layout.svelte', import.meta.url), 'utf8');
  assert.match(source, /\$derived\(adminCatalogOwner\(\$user\?\.uid, page\.route\.id\)\)/);
  assert.match(source, /\$effect\(\(\) => startAdminPrefetch\(catalogOwner\)\)/);
});

test('/me keeps its history source on same-uid auth emissions and releases it on account changes', async () => {
  const {compileModule} = await import('svelte/compiler');
  const source = readFileSync(new URL('../src/routes/me/+page.svelte', import.meta.url), 'utf8');
  const historyStart = source.indexOf('$effect(() => {', source.indexOf('let allSessions ='));
  const historyEnd = source.indexOf('\n  });', historyStart) + '\n  });'.length;
  assert.ok(historyStart >= 0 && historyEnd > historyStart);
  const historyEffect = source.slice(historyStart, historyEnd).replaceAll('$user', 'authUser');
  const scalarUid = source.match(/const userId = \$derived\(\$user\?\.uid\);/)?.[0].replace('$user', 'authUser') ?? '';
  // Execute the actual page subscription effect through Svelte's rune runtime.
  // No DOM or Firebase connection is involved, only an observable source store.
  const compiled = compileModule(`export function lifecycle(Database) {
    let authUser = $state({uid: 'me-first'});
    let allSessions = $state(undefined);
    ${scalarUid}
    ${historyEffect}
    return {emit(value) {authUser = value;}};
  }`, {filename: 'history-lifecycle.svelte.js', generate: 'client'}).js.code;
  const runtimeUrl = import.meta.resolve('svelte/internal/client');
  const code = compiled.replaceAll("'svelte/internal/client'", JSON.stringify(runtimeUrl));
  const {lifecycle} = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const {effect_root} = await import(runtimeUrl);
  let emit: (value: {uid: string} | undefined) => void = () => assert.fail('effect root was not initialized');
  const destroy = effect_root(() => {emit = lifecycle(Database).emit;}) as () => void;
  await settle();
  const firstStarts = starts.get('history:me-first');
  emit({uid: 'me-first'});
  await settle();
  const startsAfterReemission = starts.get('history:me-first');
  emit({uid: 'me-second'});
  await settle();
  const stopsAfterChange = stops.get('history:me-first');
  emit(undefined);
  await settle();
  destroy();
  assert.equal(firstStarts, 1);
  assert.equal(startsAfterReemission, 1, 'same uid must not re-open the heavy history query');
  assert.equal(stopsAfterChange, 1);
  assert.equal(starts.get('history:me-second'), 1);
  assert.equal(stops.get('history:me-second'), 1);
});
