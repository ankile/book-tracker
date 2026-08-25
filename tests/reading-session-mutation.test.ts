import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {acceptReportedWrite} from '../src/lib/utils/offlineWrite.ts';
import {
  readingSessionMutationConfirmed,
  readingSessionVersion,
} from '../src/lib/utils/readingSessionLatch.ts';
import {
  planReadingSessionDelete,
  planReadingSessionUpdate,
  precedingProgressUpdate,
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
      null,
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
      null,
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
      null,
    ),
    { deltaPages: -10, deltaTime: -30, progress: null },
  );
});

test('deleting the progress owner hands ownership to the newest matching survivor', () => {
  const timestamp = (millis: number) => ({toMillis: () => millis});
  const previous = precedingProgressUpdate([
    {id: 'older-reading', toPage: 10, createdAt: timestamp(1)},
    {id: 'newer-correction', toPage: 10, createdAt: timestamp(2)},
    {id: 'unrelated', toPage: 9, createdAt: timestamp(3)},
    {id: 'session', toPage: 20, createdAt: timestamp(4)},
  ], {id: 'session', fromPage: 10});
  assert.equal(previous?.id, 'newer-correction');
  assert.deepEqual(
    planReadingSessionDelete(
      session,
      {currentPage: 20, currentPageUpdateId: 'session', pageCount: 40},
      'session',
      previous,
    ).progress,
    {currentPage: 10, currentPageUpdateId: 'newer-correction', finished: false},
  );
});

test('progress predecessor selection is deterministic and rejects a wrong endpoint', () => {
  const createdAt = {toMillis: () => 1};
  assert.equal(precedingProgressUpdate([
    {id: 'a', toPage: 10, createdAt},
    {id: 'b', toPage: 10, createdAt},
  ], {id: 'session', fromPage: 10})?.id, 'b');
  assert.throws(
    () => planReadingSessionDelete(
      session,
      {currentPage: 20, currentPageUpdateId: 'session', pageCount: 40},
      'session',
      {id: 'wrong', toPage: 9},
    ),
    /does not establish/,
  );
});

test('stale snapshot echoes keep edit and delete mutation latches closed', () => {
  const version = (seconds: number, nanoseconds = 0) => ({seconds, nanoseconds});
  const stale = {id: 'session', updatedAt: version(1)};
  const unrelated = {id: 'other', updatedAt: version(2)};
  const edit = {
    operationId: 1,
    kind: 'edit' as const,
    sessionId: 'session',
    priorVersion: readingSessionVersion(stale),
  };
  const deletion = {operationId: 2, kind: 'delete' as const, sessionId: 'session'};

  assert.equal(readingSessionMutationConfirmed(edit, [{...stale}, unrelated]), false);
  assert.equal(readingSessionMutationConfirmed(edit, [
    {id: 'session', updatedAt: version(1, 1)}, unrelated,
  ]), true);
  assert.equal(readingSessionMutationConfirmed(deletion, [{...stale}, unrelated]), false);
  assert.equal(readingSessionMutationConfirmed(deletion, [unrelated]), true);

  const latch = {accepted: true};
  let duplicateWrites = 0;
  if (readingSessionMutationConfirmed(deletion, [{...stale}])) latch.accepted = false;
  assert.equal(acceptReportedWrite(
    latch,
    async () => { duplicateWrites += 1; },
    () => {},
    () => {},
  ), null);
  assert.equal(duplicateWrites, 0);
});

test('the sessions listener does not track mutation-latch state', async () => {
  const source = await readFile(
    new URL('../src/lib/components/ReadingSessionsModal.svelte', import.meta.url),
    'utf8',
  );
  assert.match(source, /import \{ untrack \} from ['"]svelte['"]/);
  assert.match(
    source,
    /updatesStore\.subscribe\(\(data\) => \{[\s\S]*?untrack\(\(\) => \{[\s\S]*?pendingSessionWrite/,
  );
});
