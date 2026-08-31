import assert from 'node:assert/strict';
import test from 'node:test';
import {Timestamp} from 'firebase-admin/firestore';
import {planFinishedAt} from '../finished-at-migration.ts';

const row = (id: string, millis: number, pagesRead: number) => ({
  id,
  data: {createdAt: Timestamp.fromMillis(millis), pagesRead},
});

test('a finished book is stamped with its last forward progress, not a later correction', () => {
  const patch = planFinishedAt({finished: true}, [
    row('first', 1_000, 150),
    row('last-progress', 2_000, 50),
    row('correction', 9_000, -20),
    row('zero', 9_500, 0),
  ]);
  assert.equal(patch?.finishedAt.toMillis(), 2_000);
});

test('equal timestamps resolve by id, and a history without progress uses its newest row', () => {
  assert.equal(planFinishedAt({finished: true}, [
    row('b', 2_000, 10),
    row('a', 2_000, 10),
  ])?.finishedAt.toMillis(), 2_000);
  assert.equal(planFinishedAt({finished: true}, [
    row('clamp', 3_000, -5),
    row('older', 1_000, 0),
  ])?.finishedAt.toMillis(), 3_000);
});

test('a book with no history falls back to its own updatedAt', () => {
  assert.equal(
    planFinishedAt({finished: true, updatedAt: Timestamp.fromMillis(7_000)}, [])?.finishedAt.toMillis(),
    7_000,
  );
  assert.throws(() => planFinishedAt({finished: true}, []), /updatedAt must be a timestamp/);
});

test('unfinished and already-stamped books are left alone; malformed rows crash', () => {
  assert.equal(planFinishedAt({finished: false}, [row('r', 1, 5)]), null);
  assert.equal(planFinishedAt({}, [row('r', 1, 5)]), null);
  assert.equal(planFinishedAt({finished: true, finishedAt: Timestamp.fromMillis(5)}, [row('r', 1, 5)]), null);
  assert.throws(() => planFinishedAt({finished: true, finishedAt: 'yesterday'}, []), /finishedAt must be a timestamp/);
  assert.throws(() => planFinishedAt({finished: true}, [{id: 'bad', data: {createdAt: Timestamp.fromMillis(1)}}]), /pagesRead/);
});
