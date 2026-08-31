import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// The retired Hosting site redirects every path to book.ankile.com — except
// the reserved /__/ namespace. Firebase Auth's hosted email-action page
// (web.app/__/auth/action) fetches /__/firebase/init.json from the same
// site, and a catch-all redirect sent that file to the Pages SPA shell, so
// every verification link ended in "Error encountered" (2026-08-31). The
// rule is a regex because RE2 has no lookahead and a negated glob cannot
// carry the path into the destination.
interface Redirect { source?: string; regex?: string; destination: string; type: number }
const hosting = JSON.parse(readFileSync('firebase.json', 'utf8')).hosting as { redirects: Redirect[] };
const pathRule = hosting.redirects.find((rule) => rule.regex !== undefined);
if (pathRule === undefined) throw new Error('firebase.json has no regex redirect');
// RE2 named groups are (?P<name>); JavaScript spells them (?<name>).
const rule = new RegExp(pathRule.regex!.replace('(?P<', '(?<'));

function redirectedTo(path: string): string | null {
  const match = rule.exec(path);
  return match === null ? null : pathRule!.destination.replace(':path', match.groups!.path);
}

test('the retired site keeps the reserved /__/ namespace out of its catch-all redirect', () => {
  assert.equal(pathRule!.type, 301);
  for (const reserved of ['/__/firebase/init.json', '/__/auth/action', '/__/auth/handler', '/__/', '/__']) {
    assert.equal(redirectedTo(reserved), null, reserved);
  }
});

test('every other path redirects to the same path on book.ankile.com', () => {
  assert.equal(redirectedTo('/profiles/lars'), 'https://book.ankile.com/profiles/lars');
  assert.equal(redirectedTo('/profiles/lars.json'), 'https://book.ankile.com/profiles/lars.json');
  assert.equal(redirectedTo('/sitemap.xml'), 'https://book.ankile.com/sitemap.xml');
  assert.equal(redirectedTo('/_app/immutable/x.js'), 'https://book.ankile.com/_app/immutable/x.js');
  assert.equal(redirectedTo('/__x/y'), 'https://book.ankile.com/__x/y');
  assert.equal(redirectedTo('/me'), 'https://book.ankile.com/me');
  // The bare root has its own rule.
  assert.ok(hosting.redirects.some((r) => r.source === '/' && r.destination === 'https://book.ankile.com/'));
});
