import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {Timestamp} from 'firebase-admin/firestore';
import {planFinishedAt} from '../finished-at-migration.ts';

const row = (id: string, millis: number, pagesRead: number) => ({
  id,
  data: {createdAt: Timestamp.fromMillis(millis), pagesRead},
});

test('a finished book is stamped with its last forward progress, not a later correction', () => {
  const plan = planFinishedAt({finished: true}, [
    row('first', 1_000, 150),
    row('last-progress', 2_000, 50),
    row('correction', 9_000, -20),
    row('zero', 9_500, 0),
  ]);
  assert.equal(plan?.finishedAt.toMillis(), 2_000);
  assert.equal(plan?.via, 'progress');
  // The later correction is surfaced for the operator, not used.
  assert.equal(plan?.laterRowAt?.toMillis(), 9_500);
  const clean = planFinishedAt({finished: true}, [row('only', 1_000, 10)]);
  assert.equal(clean?.laterRowAt, null);
});

test('equal timestamps resolve by id, and a history without progress uses its newest row', () => {
  assert.equal(planFinishedAt({finished: true}, [
    row('b', 2_000, 10),
    row('a', 2_000, 10),
  ])?.finishedAt.toMillis(), 2_000);
  const rowsOnly = planFinishedAt({finished: true}, [
    row('clamp', 3_000, -5),
    row('older', 1_000, 0),
  ]);
  assert.equal(rowsOnly?.finishedAt.toMillis(), 3_000);
  assert.equal(rowsOnly?.via, 'row');
});

test('a book with no history is stamped from createdAt, never updatedAt', () => {
  // updatedAt is deliberately newer: a metadata edit moved it (the
  // 2026-08-28 incident). A planner that fell back to it turns this red.
  const plan = planFinishedAt({
    finished: true,
    createdAt: Timestamp.fromMillis(7_000),
    updatedAt: Timestamp.fromMillis(9_000),
  }, []);
  assert.equal(plan?.finishedAt.toMillis(), 7_000);
  assert.equal(plan?.via, 'createdAt');
  assert.throws(
    () => planFinishedAt({finished: true, updatedAt: Timestamp.fromMillis(9_000)}, []),
    /createdAt must be a timestamp/,
  );
});

test('unfinished and already-stamped books are left alone; malformed rows crash', () => {
  assert.equal(planFinishedAt({finished: false}, [row('r', 1, 5)]), null);
  assert.equal(planFinishedAt({}, [row('r', 1, 5)]), null);
  assert.equal(planFinishedAt({finished: true, finishedAt: Timestamp.fromMillis(5)}, [row('r', 1, 5)]), null);
  assert.throws(() => planFinishedAt({finished: true, finishedAt: 'yesterday'}, []), /finishedAt must be a timestamp/);
  assert.throws(() => planFinishedAt({finished: true}, [{id: 'bad', data: {createdAt: Timestamp.fromMillis(1)}}]), /pagesRead/);
});

// The driver cannot run without a database; pin the two properties the
// planner cannot see: tombstoned accounts are skipped before any book is
// read, and the transaction writes the one field and nothing else.
test('the driver skips tombstoned accounts and writes only finishedAt', () => {
  const driver = readFileSync(new URL('../migrate-finished-at.ts', import.meta.url), 'utf8');
  const guard = driver.indexOf("account.get('deletedAt') !== undefined");
  const books = driver.indexOf("user.collection('books')");
  assert.notEqual(guard, -1, 'the driver must skip a tombstoned account');
  assert.ok(guard < books, 'the tombstone check must precede the book traversal');
  assert.match(driver, /SKIP tombstoned-account/);
  const updates = [...driver.matchAll(/tx\.update\(book\.ref, (\{[^}]*\})\)/g)].map((match) => match[1]);
  assert.deepEqual(updates, ['{finishedAt: fresh.finishedAt}']);
  assert.equal(/updatedAt/.test(driver.replace(/^\/\/.*$/gm, '')), false, 'the driver never mentions updatedAt outside comments');
});
