import assert from 'node:assert/strict';
import test from 'node:test';
import {Timestamp} from 'firebase-admin/firestore';
import {planLastReadAt} from '../last-read-at-migration.ts';

const row = (id: string, millis: number, type: 'reading' | 'update', pagesRead: number) => ({
  id,
  data: {type, pagesRead, createdAt: Timestamp.fromMillis(millis)},
});

test('an unstamped book takes its newest reading row, not a later clamp and never updatedAt', () => {
  const plan = planLastReadAt({updatedAt: Timestamp.fromMillis(99_000)}, [
    row('first', 1_000, 'reading', 30),
    row('read', 2_000, 'update', 4),
    row('clamp', 9_000, 'update', -20),
  ]);
  assert.equal(plan?.lastReadAt?.toMillis(), 2_000);
  assert.equal(plan?.via, 'row');
});

test('a book with no reading row is explicitly never read, so a rerun plans nothing', () => {
  assert.deepEqual(planLastReadAt({}, []), {lastReadAt: null, via: 'never'});
  assert.deepEqual(planLastReadAt({}, [row('clamp', 1, 'update', 0)]), {lastReadAt: null, via: 'never'});
  assert.equal(planLastReadAt({lastReadAt: null}, [row('r', 1, 'reading', 5)]), null);
  assert.equal(planLastReadAt({lastReadAt: Timestamp.fromMillis(5)}, [row('r', 9, 'reading', 5)]), null);
});

test('malformed rows and stamps crash instead of guessing', () => {
  assert.throws(() => planLastReadAt({lastReadAt: 'yesterday'}, []), /lastReadAt must be a timestamp/);
  assert.throws(() => planLastReadAt({}, [{id: 'r', data: {type: 'reading', pagesRead: 5}}]), /r\.createdAt must be a timestamp/);
  assert.throws(() => planLastReadAt({}, [{id: 'r', data: {type: 'reading', pagesRead: '5', createdAt: Timestamp.fromMillis(1)}}]), /pagesRead/);
});
