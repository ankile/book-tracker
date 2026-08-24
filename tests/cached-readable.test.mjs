import assert from 'node:assert/strict';
import test from 'node:test';
import { cachedReadable } from '../src/lib/stores/cached-readable.js';

test('cachedReadable retains data while restarting its source listener', () => {
  let starts = 0;
  let stops = 0;
  let update;
  const store = cachedReadable(undefined, (set) => {
    starts += 1;
    update = set;
    return () => {
      stops += 1;
    };
  });

  const firstValues = [];
  const unsubscribeFirst = store.subscribe((value) => firstValues.push(value));
  update(['book']);
  unsubscribeFirst();

  const secondValues = [];
  const unsubscribeSecond = store.subscribe((value) => secondValues.push(value));

  assert.deepEqual(firstValues, [undefined, ['book']]);
  assert.deepEqual(secondValues, [['book']]);
  assert.equal(starts, 2);
  assert.equal(stops, 1);

  unsubscribeSecond();
  assert.equal(stops, 2);
});

test('cachedReadable shares one source listener between subscribers', () => {
  let starts = 0;
  let stops = 0;
  const store = cachedReadable([], () => {
    starts += 1;
    return () => {
      stops += 1;
    };
  });

  const unsubscribeFirst = store.subscribe(() => {});
  const unsubscribeSecond = store.subscribe(() => {});
  assert.equal(starts, 1);

  unsubscribeFirst();
  assert.equal(stops, 0);

  unsubscribeSecond();
  assert.equal(stops, 1);
});
