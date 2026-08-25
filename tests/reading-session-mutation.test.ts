import assert from 'node:assert/strict';
import test from 'node:test';
import {
  planReadingSessionDelete,
  planReadingSessionUpdate,
} from '../src/lib/utils/readingSessionMutation.ts';

const session = {
  fromPage: 10,
  toPage: 20,
  pagesRead: 10,
  timeRead: 30,
};

test('editing the exact current-page source updates deltas and finished progress', () => {
  assert.deepEqual(
    planReadingSessionUpdate(
      session,
      { fromPage: 10, toPage: 40, timeRead: 45 },
      { currentPage: 20, currentPageUpdateId: 'session', pageCount: 40 },
      'session',
    ),
    {
      deltaPages: 20,
      deltaTime: 15,
      progress: { currentPage: 40, currentPageUpdateId: 'session', finished: true },
    },
  );
});

test('editing a historical session preserves later book progress', () => {
  assert.deepEqual(
    planReadingSessionUpdate(
      session,
      { fromPage: 10, toPage: 18, timeRead: 25 },
      { currentPage: 35, currentPageUpdateId: 'later', pageCount: 40 },
      'session',
    ),
    { deltaPages: -2, deltaTime: -5, progress: null },
  );
});

test('editing a session that shares a later correction endpoint preserves progress', () => {
  assert.deepEqual(
    planReadingSessionUpdate(
      session,
      { fromPage: 10, toPage: 18, timeRead: 25 },
      { currentPage: 20, currentPageUpdateId: 'correction', pageCount: 40 },
      'session',
    ),
    { deltaPages: -2, deltaTime: -5, progress: null },
  );
});

test('editing a legacy session without an exact progress source preserves progress', () => {
  assert.deepEqual(
    planReadingSessionUpdate(
      session,
      { fromPage: 10, toPage: 18, timeRead: 25 },
      { currentPage: 20, currentPageUpdateId: null, pageCount: 40 },
      'session',
    ),
    { deltaPages: -2, deltaTime: -5, progress: null },
  );
});

test('deleting the exact current-page source rolls progress back and clears ownership', () => {
  assert.deepEqual(
    planReadingSessionDelete(
      session,
      { currentPage: 20, currentPageUpdateId: 'session', pageCount: 40 },
      'session',
    ),
    {
      deltaPages: -10,
      deltaTime: -30,
      progress: { currentPage: 10, currentPageUpdateId: null, finished: false },
    },
  );
});

test('deleting a historical session preserves later book progress', () => {
  assert.deepEqual(
    planReadingSessionDelete(
      session,
      { currentPage: 35, currentPageUpdateId: 'later', pageCount: 40 },
      'session',
    ),
    { deltaPages: -10, deltaTime: -30, progress: null },
  );
});

test('deleting a session that shares a later correction endpoint preserves progress', () => {
  assert.deepEqual(
    planReadingSessionDelete(
      session,
      { currentPage: 20, currentPageUpdateId: 'correction', pageCount: 40 },
      'session',
    ),
    { deltaPages: -10, deltaTime: -30, progress: null },
  );
});
