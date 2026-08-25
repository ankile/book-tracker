import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp } from 'firebase-admin/firestore';
import { isTogglTimer } from '../src/lib/interfaces/book.ts';
import { activeTimerClaim, idleTimerClaim, stoppingTimer } from '../src/lib/utils/timerClaim.ts';
import {
  auditTimerClaimState,
  decodeMigratedTimerClaim,
  planTimerClaim,
  timerClaimPlanIsApplied,
} from '../timer-claim-migration.ts';
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

test('timer claim helpers preserve exact local, remote, and stopping identities', () => {
  const local = activeTimerClaim('book', {
    start: '2026-08-24T12:00:00.000Z', operationId: 'local-operation',
  });
  assert.deepEqual(local, {
    version: 1, state: 'local', bookId: 'book',
    start: '2026-08-24T12:00:00.000Z', operationId: 'local-operation',
  });
  assert.deepEqual(idleTimerClaim(local), {version: 1, state: 'idle', cleared: local});
  assert.throws(
    () => activeTimerClaim('book', {start: '2026-08-24T12:00:00.000Z'}),
    /operation id/,
  );

  const remote = {entryId: 42, start: '2026-08-24T12:00:00.000Z'};
  const stopping = stoppingTimer(remote, 'book_2026-08-24T12:00:00.000Z');
  assert.equal(isTogglTimer(remote), true);
  assert.equal(isTogglTimer(stopping), false);
  assert.deepEqual(activeTimerClaim('book', stopping), {
    version: 1, state: 'stopping', bookId: 'book', entryId: 42,
    start: remote.start, queueId: 'book_2026-08-24T12:00:00.000Z',
  });
});

test('timer claim migration is deterministic, strict, and idempotent after a later stop', () => {
  const start = '2026-08-24T12:00:00.000Z';
  const first = planTimerClaim([{id: 'book', data: {activeTimer: {start}}}]);
  const repeated = planTimerClaim([{id: 'book', data: {activeTimer: {start}}}]);
  assert.deepEqual(repeated, first);
  assert.equal(first.claim.state, 'local');
  assert.ok(first.bookPatch?.activeTimer.operationId.startsWith('legacy-'));
  assert.equal(first.bookPatch?.activeTimer.operationId, first.claim.operationId);

  const idlePlan = planTimerClaim([{id: 'book', data: {activeTimer: null}}]);
  assert.equal(timerClaimPlanIsApplied(idlePlan, {
    version: 1,
    state: 'idle',
    cleared: first.claim,
  }), true);
  assert.equal(timerClaimPlanIsApplied(idlePlan, first.claim), false);
  const remotePlan = planTimerClaim([{
    id: 'remote-book', data: {activeTimer: {entryId: 42, start}},
  }]);
  assert.equal(timerClaimPlanIsApplied(remotePlan, remotePlan.claim), true);
  assert.equal(timerClaimPlanIsApplied(remotePlan, {
    version: 1, state: 'remote', bookId: 'remote-book', entryId: 43, start,
  }), false);
  assert.throws(() => planTimerClaim([
    {id: 'one', data: {activeTimer: {start}}},
    {id: 'two', data: {activeTimer: {entryId: 2, start}}},
  ]), /multiple active timers/);
  assert.throws(() => planTimerClaim([
    {id: 'broken', data: {activeTimer: {entryId: 'not-an-id', start}}},
  ]), /positive safe integer/);
});

test('timer claim migration rejects normalized calendar timestamps', () => {
  for (const start of [
    '2026-02-30T12:00:00.000Z',
    '2025-02-29T12:00:00Z',
    '2026-04-31T12:00:00Z',
    '2026-01-01T24:00:00Z',
  ]) {
    assert.throws(
      () => planTimerClaim([{id: 'book', data: {activeTimer: {start}}}]),
      /must be an ISO timestamp/,
    );
  }

  for (const start of [
    '2024-02-29T23:59:59Z',
    '2024-02-29T23:59:59.123456789+05:30',
  ]) {
    const plan = planTimerClaim([{id: 'book', data: {activeTimer: {start}}}]);
    assert.equal(plan.claim.state, 'local');
    if (plan.claim.state === 'local') assert.equal(plan.claim.start, start);
  }
});

test('stored lifecycle decoder rejects malformed active and cleared claims', () => {
  const claimedAt = Timestamp.now();
  assert.deepEqual(decodeMigratedTimerClaim({
    version: 1, state: 'starting', bookId: 'book', operationId: 'operation',
    start: '2026-08-24T12:00:00.000Z', claimedAt,
  }), {
    version: 1, state: 'starting', bookId: 'book', operationId: 'operation',
    start: '2026-08-24T12:00:00.000Z', claimedAt,
  });
  assert.throws(() => decodeMigratedTimerClaim({
    version: 1, state: 'remote', bookId: 'book', entryId: 0,
    start: '2026-08-24T12:00:00.000Z',
  }), /positive safe integer/);
  assert.throws(() => decodeMigratedTimerClaim({
    version: 1, state: 'idle', cleared: {version: 1, state: 'local'},
  }));
});

test('timer migration preserves every already-versioned book lifecycle state', () => {
  const start = '2026-08-24T12:00:00.000Z';
  const claimedAt = Timestamp.now();
  const timers = [
    {start, operationId: 'local-operation'},
    {start, entryId: 42},
    {state: 'starting', start, operationId: 'starting-operation', claimedAt},
    {
      state: 'outcome-unknown', start, operationId: 'unknown-operation',
      claimedAt, error: 'Check Toggl.',
    },
    {state: 'stopping', start, entryId: 42, queueId: `book_${start}`},
  ];
  assert.deepEqual(
    timers.map((activeTimer) => planTimerClaim([{id: 'book', data: {activeTimer}}]).claim.state),
    ['local', 'remote', 'starting', 'outcome-unknown', 'stopping'],
  );
  for (const activeTimer of timers) {
    assert.equal(
      planTimerClaim([{id: 'book', data: {activeTimer}}]).bookPatch,
      null,
    );
  }
});

test('timer audit reports missing, malformed, conflicting, and multiple state', () => {
  const start = '2026-08-24T12:00:00.000Z';
  const books = [{id: 'book', data: {activeTimer: {entryId: 42, start}}}];
  assert.deepEqual(auditTimerClaimState(books, {exists: false, data: undefined}), [{
    cls: 'timer-lifecycle.missing', detail: 'expected remote',
  }]);
  assert.equal(auditTimerClaimState(books, {
    exists: true, data: {version: 1, state: 'remote'},
  })[0]?.cls, 'timer-lifecycle.malformed');
  assert.deepEqual(auditTimerClaimState(books, {
    exists: true,
    data: {version: 1, state: 'remote', bookId: 'book', entryId: 43, start},
  }), [{
    cls: 'timer-lifecycle.mismatch', detail: 'books=remote lifecycle=remote',
  }]);
  assert.equal(auditTimerClaimState([
    ...books,
    {id: 'other', data: {activeTimer: {start, operationId: 'other'}}},
  ], {exists: true, data: {version: 1, state: 'idle', cleared: null}})[0]?.cls,
  'timer-lifecycle.books-invalid');
  assert.deepEqual(auditTimerClaimState([{id: 'book', data: {activeTimer: null}}], {
    exists: true,
    data: {
      version: 1, state: 'idle',
      cleared: {version: 1, state: 'remote', bookId: 'book', entryId: 42, start},
    },
  }), []);
});
