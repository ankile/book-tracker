import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isTogglSweepTransactionCandidate,
  parseTogglReportedIds,
  readTogglReportedIds,
  togglQueueId,
  writeTogglReportedIds,
} from '../src/lib/utils/toggl.ts';

test('Toggl queue ids stably correlate one book timer start', () => {
  const first = togglQueueId('book-123', '2026-08-24T12:00:00.000Z');
  const repeated = togglQueueId('book-123', '2026-08-24T12:00:00.000Z');

  assert.equal(first, 'book-123_2026-08-24T12:00:00.000Z');
  assert.equal(repeated, first);
  assert.notEqual(
    togglQueueId('book-123', '2026-08-24T12:00:01.000Z'),
    first,
  );
});

test('corrupt Toggl report dedup state resets without blocking the sweep', () => {
  assert.deepEqual(parseTogglReportedIds(null), []);
  assert.deepEqual(parseTogglReportedIds('{broken'), []);
  assert.deepEqual(parseTogglReportedIds('{"id":"queue"}'), []);
  assert.deepEqual(parseTogglReportedIds('["queue", 42]'), []);
  assert.deepEqual(parseTogglReportedIds('["first","second"]'), ['first', 'second']);

  const unavailable = {
    getItem(): string | null {
      throw new Error('storage unavailable');
    },
    setItem(): void {
      throw new Error('storage unavailable');
    },
  };
  assert.deepEqual(readTogglReportedIds(unavailable, 'reported'), []);
  assert.doesNotThrow(() => writeTogglReportedIds(unavailable, 'reported', ['queue']));
});

test('the sweep opens transactions only for retryable lifecycle rows', () => {
  assert.equal(isTogglSweepTransactionCandidate({status: 'pending', attempts: 0}), true);
  assert.equal(isTogglSweepTransactionCandidate({status: 'error', attempts: 4}), true);
  assert.equal(isTogglSweepTransactionCandidate({status: 'outcome-unknown', attempts: 1}), false);
  assert.equal(isTogglSweepTransactionCandidate({status: 'error', attempts: 5}), false);
});
