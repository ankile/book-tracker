import assert from 'node:assert/strict';
import test from 'node:test';
import {Timestamp} from 'firebase-admin/firestore';
import {
  auditReadingProgressSource,
  planReadingProgressSource,
} from '../reading-progress-source-migration.ts';

const update = (id: string, toPage: number, millis: number, type: 'reading' | 'update' = 'reading') => ({
  id,
  data: {type, toPage, createdAt: Timestamp.fromMillis(millis)},
});

test('progress migration selects the newest matching reading or correction deterministically', () => {
  assert.deepEqual(planReadingProgressSource(
    {currentPage: 20},
    [
      update('reading', 20, 1),
      update('correction-a', 20, 2, 'update'),
      update('correction-b', 20, 2, 'update'),
      update('later-other-page', 30, 3),
    ],
  ), {currentPageUpdateId: 'correction-b'});
});

test('progress migration records an explicit baseline when no update establishes the page', () => {
  assert.deepEqual(
    planReadingProgressSource({currentPage: 12}, [update('other', 11, 1)]),
    {currentPageUpdateId: null},
  );
  assert.equal(
    planReadingProgressSource(
      {currentPage: 12, currentPageUpdateId: null},
      [update('other', 11, 1)],
    ),
    null,
  );
});

test('progress migration is idempotent and rejects dangling or mismatched ownership', () => {
  assert.equal(planReadingProgressSource(
    {currentPage: 20, currentPageUpdateId: 'reading'},
    [update('reading', 20, 1)],
  ), null);
  assert.throws(
    () => planReadingProgressSource(
      {currentPage: 20, currentPageUpdateId: 'missing'},
      [update('reading', 20, 1)],
    ),
    /is missing/,
  );
  assert.throws(
    () => planReadingProgressSource(
      {currentPage: 20, currentPageUpdateId: 'reading'},
      [update('reading', 19, 1)],
    ),
    /does not establish/,
  );
});

test('progress audit distinguishes an unread baseline from unexplained nonzero progress', () => {
  assert.deepEqual(
    auditReadingProgressSource(
      {currentPage: 12, currentPageUpdateId: null},
      [update('other', 11, 1)],
    ),
    [{
      cls: 'book.progress-source-null-baseline',
      detail: 'page 12 has no establishing update',
    }],
  );
  assert.deepEqual(
    auditReadingProgressSource({currentPage: 0, currentPageUpdateId: null}, []),
    [],
  );
  assert.deepEqual(
    auditReadingProgressSource(
      {currentPage: 12, currentPageUpdateId: null},
      [update('reading', 12, 1)],
    ),
    [{cls: 'book.progress-source-unclaimed', detail: 'reading'}],
  );
});
