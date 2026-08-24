import assert from 'node:assert/strict';
import test from 'node:test';
import { togglQueueId } from '../src/lib/utils/toggl.ts';

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
