import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isReadingActivity,
  lastReadAtAfterDelete,
  lastReadAtOf,
  readOrderMillis,
} from '../src/lib/utils/lastRead.ts';

const at = (millis: number) => ({ toMillis: () => millis });
const row = (id: string, millis: number, type: 'reading' | 'update', pagesRead: number) => ({
  id, type, pagesRead, createdAt: at(millis),
});

test('a timed session or a forward page update is reading; a clamp or backward correction is not', () => {
  assert.equal(isReadingActivity({ type: 'reading', pagesRead: 0 }), true);
  assert.equal(isReadingActivity({ type: 'update', pagesRead: 12 }), true);
  assert.equal(isReadingActivity({ type: 'update', pagesRead: 0 }), false);
  assert.equal(isReadingActivity({ type: 'update', pagesRead: -30 }), false);
  assert.throws(() => isReadingActivity({ type: 'update', pagesRead: '5' }), /pagesRead/);
});

test('lastReadAtOf is the newest reading row, skipping later corrections, and null when never read', () => {
  assert.equal(lastReadAtOf([
    row('first', 1_000, 'reading', 30),
    row('latest-read', 5_000, 'update', 8),
    row('clamp', 9_000, 'update', -120),
    row('zero', 9_500, 'update', 0),
  ])?.toMillis(), 5_000);
  // Equal instants resolve by id so two clients agree.
  assert.equal(lastReadAtOf([row('a', 2_000, 'reading', 1), row('b', 2_000, 'reading', 1)])?.toMillis(), 2_000);
  assert.equal(lastReadAtOf([row('clamp', 9_000, 'update', -5)]), null);
  assert.equal(lastReadAtOf([]), null);
});

test('deleting the newest session hands the stamp to the previous one; deleting an older one keeps it', () => {
  const rows = [row('old', 1_000, 'reading', 10), row('mid', 2_000, 'reading', 10), row('new', 3_000, 'reading', 10)];
  assert.deepEqual(lastReadAtAfterDelete(rows, 'new', at(3_000)), { lastReadAt: rows[1].createdAt });
  assert.deepEqual(lastReadAtAfterDelete(rows, 'old', at(3_000)), {});
  // The only session goes: the book is unread again.
  assert.deepEqual(lastReadAtAfterDelete([rows[0]], 'old', at(1_000)), { lastReadAt: null });
  // A never-read book stays null without a patch.
  assert.deepEqual(lastReadAtAfterDelete([row('clamp', 1, 'update', -1)], 'clamp', null), {});
});

test('the reading list orders by lastReadAt, then createdAt for an unread book, and never by updatedAt', () => {
  // The 2026-09-05 report: the Bible's record was edited on 08-29 (updatedAt)
  // but last read in 2025; The God Test was read on 08-26.
  const bible = { title: 'Holy Bible', lastReadAt: at(1_764_500_000_000), createdAt: at(1_693_800_000_000), updatedAt: at(1_787_000_000_000) };
  const godTest = { title: 'The God Test', lastReadAt: at(1_787_600_000_000), createdAt: at(1_780_000_000_000), updatedAt: at(1_787_600_000_000) };
  const unread = { title: 'Just added', lastReadAt: null, createdAt: at(1_788_000_000_000), updatedAt: at(1_788_000_000_000) };
  const ordered = [bible, godTest, unread].toSorted((a, b) => readOrderMillis(b) - readOrderMillis(a));
  assert.deepEqual(ordered.map((book) => book.title), ['Just added', 'The God Test', 'Holy Bible']);
});
