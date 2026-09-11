import assert from 'node:assert/strict';
import test from 'node:test';
import { createSubscriptionDiagnostics } from '../src/lib/firebase/subscriptionDiagnostics.ts';

test('capture is opt-in, bounded, expires, and whitelists metadata', () => {
  let now = 100;
  const capture = createSubscriptionDiagnostics(() => now, () => ({online: true, visibility: 'visible'}));
  capture.record('books', 'start');
  assert.equal(capture.export().events.length, 0);
  capture.start();
  const untrustedMetadata = {count: 4, fromCache: true, hasPendingWrites: false, secret: 'PRIVATE'};
  capture.record('books', 'snapshot', untrustedMetadata);
  capture.record('books', 'error', {code: 'PRIVATE'});
  assert.equal(JSON.stringify(capture.export()).includes('PRIVATE'), false);
  assert.equal(capture.export().events[0].count, 4);
  for (let i = 0; i < 600; i++) capture.record('books', 'snapshot', {count: i});
  assert.equal(capture.export().events.length, 500);
  now += 600_001;
  capture.record('books', 'stop');
  assert.equal(capture.export().events.length, 500);
  assert.equal(capture.export().active, false);
  capture.clear();
  assert.equal(capture.export().events.length, 0);
});

test('underlying subscription records one start/stop and preserves callback values and errors', async () => {
  const {instrumentSubscription} = await import('../src/lib/firebase/subscriptionDiagnostics.ts');
  const capture = createSubscriptionDiagnostics();
  capture.start();
  let stops = 0;
  const original = {privateData: 'PRIVATE', size: 10};
  const failure = {code: 'permission-denied', message: 'PRIVATE'};
  const received: unknown[] = [];
  const stop = instrumentSubscription(capture, 'history', (next, error) => {
    next(original);
    error(failure);
    return () => {stops++;};
  }, (value: typeof original) => ({count: value.size}), value => received.push(value), error => received.push(error));
  stop(); stop();
  assert.deepEqual(received, [original, failure]);
  assert.equal(stops, 1);
  assert.deepEqual(capture.export().events.map(event => event.kind), ['start', 'snapshot', 'error', 'stop']);
  assert.equal(JSON.stringify(capture.export()).includes('PRIVATE'), false);
});
