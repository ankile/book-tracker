import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

// SEC-014: the enforcement flip will refuse any client that does not
// attest, so the one place that initializes App Check is pinned here —
// reverting it would strand every production client the moment
// enforcement lands, with no compile error.
const indexSource = readFileSync('src/lib/firebase/index.ts', 'utf8');

test('the browser client initializes App Check with the reCAPTCHA Enterprise key', () => {
  assert.match(
    indexSource,
    /initializeAppCheck\(app,\s*\{\s*provider:\s*new ReCaptchaEnterpriseProvider\('6Ldbm58tAAAAAGj4KhxJlm4yagS848O6dBg47p8_'\),\s*isTokenAutoRefreshEnabled:\s*true,\s*\}\)/,
  );
});

test('App Check runs in every browser context except emulator runs', () => {
  // The emulator suite never verifies tokens, so those runs skip App
  // Check; every other browser context (prod, preview, plain dev) must
  // attest or enforcement will refuse it.
  assert.match(
    indexSource,
    /if \(browser && !\(import\.meta\.env\.DEV && import\.meta\.env\.VITE_EMULATOR\)\) \{/,
  );
});

test('only dev builds use the App Check debug token, sourced from the environment', () => {
  // In production the debug flag would let anyone mint tokens from the
  // console; it must stay behind the DEV check. The token value comes from
  // VITE_APPCHECK_DEBUG_TOKEN (.env.local, gitignored) — a literal token in
  // this public repo would hand attestation bypass to whoever reads it.
  const flag = /FIREBASE_APPCHECK_DEBUG_TOKEN/g;
  assert.equal(indexSource.match(flag)?.length, 2, 'the debug flag appears in its type and its assignment only');
  assert.match(
    indexSource,
    /if \(import\.meta\.env\.DEV\) \{\s*\(globalThis as \{ FIREBASE_APPCHECK_DEBUG_TOKEN\?: boolean \| string \}\)\.FIREBASE_APPCHECK_DEBUG_TOKEN =\s*import\.meta\.env\.VITE_APPCHECK_DEBUG_TOKEN \?\? true;\s*\}/,
  );
  assert.doesNotMatch(
    indexSource,
    /FIREBASE_APPCHECK_DEBUG_TOKEN =\s*['"]/,
    'a debug token literal must never be committed',
  );
});

// Server side of the same flip: every callable refuses an unattested call
// before its handler runs. A callable declared without `enforceAppCheck:
// true` compiles, deploys and bills the handler for anonymous traffic
// again (SEC-068) with no other test going red, so each onCall chain is
// checked for the option in its own runWith.
// Eight on master plus catalog.search, catalog.ensureauthors and
// catalog.workreaders, which share one runWith chain in catalog.ts.
const CALLABLE_COUNT = 11;

function callableChains(): { file: string; chain: string }[] {
  const dir = 'functions/src';
  const chains: { file: string; chain: string }[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts')) continue;
    const source = readFileSync(`${dir}/${name}`, 'utf8');
    let from = 0;
    for (;;) {
      const at = source.indexOf('.https.onCall(', from);
      if (at === -1) break;
      const start = source.lastIndexOf('functions\n', at);
      assert.notEqual(start, -1, `${name}: onCall at ${at} is not part of a functions.* chain`);
      chains.push({ file: name, chain: source.slice(start, at) });
      from = at + 1;
    }
  }
  return chains;
}

test('every callable enforces App Check in its runWith options', () => {
  const chains = callableChains();
  assert.equal(chains.length, CALLABLE_COUNT, 'a callable was added or removed — re-verify enforcement, then update the count');
  for (const { file, chain } of chains) {
    assert.match(chain, /\.runWith\(\{[^}]*\benforceAppCheck: true,?[^}]*\}\)/, `${file}: ${chain.trim().split('\n')[0]}`);
  }
});
