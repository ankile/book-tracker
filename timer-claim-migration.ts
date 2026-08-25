import { Timestamp } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';

export type MigratedActiveTimerClaim =
  | { version: 1; state: 'local'; bookId: string; operationId: string; start: string }
  | { version: 1; state: 'remote'; bookId: string; entryId: number; start: string }
  | { version: 1; state: 'starting'; bookId: string; operationId: string; start: string; claimedAt: Timestamp }
  | { version: 1; state: 'outcome-unknown'; bookId: string; operationId: string; start: string; claimedAt: Timestamp; error: string }
  | { version: 1; state: 'stopping'; bookId: string; entryId: number; start: string; queueId: string };

export type MigratedTimerClaim =
  | MigratedActiveTimerClaim
  | { version: 1; state: 'idle'; cleared: MigratedActiveTimerClaim | null };

interface StoredBook {
  id: string;
  data: Record<string, unknown>;
}

export interface TimerClaimMigrationPlan {
  claim: MigratedTimerClaim;
  bookPatch: { bookId: string; activeTimer: { start: string; operationId: string } } | null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new TypeError(`${label} has fields ${actual.join(',')}; expected ${sortedExpected.join(',')}`);
  }
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function iso(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(result) ||
      !Number.isFinite(Date.parse(result))) {
    throw new TypeError(`${label} must be an ISO timestamp`);
  }
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function timestamp(value: unknown, label: string): Timestamp {
  if (!(value instanceof Timestamp)) throw new TypeError(`${label} must be a Firestore timestamp`);
  return value;
}

export function claimForStoredTimer(bookId: string, value: unknown): MigratedActiveTimerClaim {
  const timer = record(value, `books/${bookId}.activeTimer`);
  const start = iso(timer.start, `books/${bookId}.activeTimer.start`);
  if (timer.state === undefined) {
    if (timer.entryId === undefined) {
      exactKeys(timer, timer.operationId === undefined ? ['start'] : ['operationId', 'start'], `books/${bookId}.activeTimer`);
      const operationId = timer.operationId === undefined
        ? `legacy-${createHash('sha256').update(`${bookId}\0${start}`).digest('hex')}`
        : text(timer.operationId, `books/${bookId}.activeTimer.operationId`, 100);
      return {
        version: 1,
        state: 'local',
        bookId,
        operationId,
        start,
      };
    }
    exactKeys(timer, ['entryId', 'start'], `books/${bookId}.activeTimer`);
    return {
      version: 1,
      state: 'remote',
      bookId,
      entryId: positiveInteger(timer.entryId, `books/${bookId}.activeTimer.entryId`),
      start,
    };
  }
  if (timer.state === 'stopping') {
    exactKeys(timer, ['state', 'entryId', 'start', 'queueId'], `books/${bookId}.activeTimer`);
    return {
      version: 1,
      state: 'stopping',
      bookId,
      entryId: positiveInteger(timer.entryId, `books/${bookId}.activeTimer.entryId`),
      start,
      queueId: text(timer.queueId, `books/${bookId}.activeTimer.queueId`, 600),
    };
  }
  if (timer.state === 'starting' || timer.state === 'outcome-unknown') {
    const unknown = timer.state === 'outcome-unknown';
    exactKeys(
      timer,
      ['state', 'operationId', 'start', 'claimedAt', ...(unknown ? ['error'] : [])],
      `books/${bookId}.activeTimer`,
    );
    const common = {
      bookId,
      operationId: text(timer.operationId, `books/${bookId}.activeTimer.operationId`, 100),
      start,
      claimedAt: timestamp(timer.claimedAt, `books/${bookId}.activeTimer.claimedAt`),
    };
    return unknown ? {
      version: 1,
      state: 'outcome-unknown',
      ...common,
      error: text(timer.error, `books/${bookId}.activeTimer.error`, 1000),
    } : { version: 1, state: 'starting', ...common };
  }
  throw new TypeError(`books/${bookId}.activeTimer has unknown state ${String(timer.state)}`);
}

export function decodeMigratedTimerClaim(value: unknown): MigratedTimerClaim {
  const claim = record(value, 'timerLifecycle/current');
  if (claim.version !== 1) throw new TypeError('timerLifecycle/current.version must be 1');
  const state = text(claim.state, 'timerLifecycle/current.state', 32);
  if (state === 'idle') {
    exactKeys(claim, ['version', 'state', 'cleared'], 'timerLifecycle/current');
    return {
      version: 1,
      state,
      cleared: claim.cleared === null
        ? null
        : decodeActiveMigratedTimerClaim(claim.cleared),
    };
  }
  return decodeActiveMigratedTimerClaim(claim);
}

function decodeActiveMigratedTimerClaim(value: unknown): MigratedActiveTimerClaim {
  const claim = record(value, 'active timer claim');
  if (claim.version !== 1) throw new TypeError('active timer claim version must be 1');
  const state = text(claim.state, 'active timer claim state', 32);
  const bookId = text(claim.bookId, 'active timer claim bookId', 500);
  if (bookId === '.' || bookId === '..' || bookId.includes('/')) {
    throw new TypeError('active timer claim bookId must be one document id');
  }
  if (state === 'local') {
    exactKeys(claim, ['version', 'state', 'bookId', 'operationId', 'start'], 'active timer claim');
    return claimForStoredTimer(bookId, {
      start: claim.start,
      operationId: claim.operationId,
    });
  }
  if (state === 'remote') {
    exactKeys(claim, ['version', 'state', 'bookId', 'entryId', 'start'], 'active timer claim');
    return claimForStoredTimer(bookId, {
      entryId: claim.entryId,
      start: claim.start,
    });
  }
  if (state === 'stopping') {
    exactKeys(claim, ['version', 'state', 'bookId', 'entryId', 'start', 'queueId'], 'active timer claim');
    return claimForStoredTimer(bookId, {
      state,
      entryId: claim.entryId,
      start: claim.start,
      queueId: claim.queueId,
    });
  }
  if (state === 'starting' || state === 'outcome-unknown') {
    const unknown = state === 'outcome-unknown';
    exactKeys(
      claim,
      ['version', 'state', 'bookId', 'operationId', 'start', 'claimedAt', ...(unknown ? ['error'] : [])],
      'active timer claim',
    );
    return claimForStoredTimer(bookId, {
      state,
      operationId: claim.operationId,
      start: claim.start,
      claimedAt: claim.claimedAt,
      ...(unknown ? { error: claim.error } : {}),
    });
  }
  throw new TypeError(`active timer claim has unknown state ${state}`);
}

export function planTimerClaim(books: StoredBook[]): TimerClaimMigrationPlan {
  const active = books.filter(({ data }) => data.activeTimer !== null && data.activeTimer !== undefined);
  if (active.length > 1) {
    throw new Error(`multiple active timers: ${active.map(({ id }) => id).sort().join(', ')}`);
  }
  if (active.length === 0) {
    return { claim: { version: 1, state: 'idle', cleared: null }, bookPatch: null };
  }
  const claim = claimForStoredTimer(active[0].id, active[0].data.activeTimer);
  const timer = active[0].data.activeTimer as Record<string, unknown>;
  const bookPatch = claim.state === 'local' && timer.operationId === undefined
    ? { bookId: active[0].id, activeTimer: { start: claim.start, operationId: claim.operationId } }
    : null;
  return { claim, bookPatch };
}

export function timerClaimsEqual(
  left: MigratedTimerClaim | null,
  right: MigratedTimerClaim | null,
): boolean {
  if (left === null || right === null) return left === right;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) {
    return false;
  }
  return leftKeys.every((key) => {
    const leftValue: unknown = (left as unknown as Record<string, unknown>)[key];
    const rightValue: unknown = (right as unknown as Record<string, unknown>)[key];
    if (leftValue instanceof Timestamp && rightValue instanceof Timestamp) return leftValue.isEqual(rightValue);
    if (typeof leftValue === 'object' && leftValue !== null &&
        typeof rightValue === 'object' && rightValue !== null) {
      return timerClaimsEqual(leftValue as MigratedTimerClaim, rightValue as MigratedTimerClaim);
    }
    return leftValue === rightValue;
  });
}

export function timerClaimPlanIsApplied(
  plan: TimerClaimMigrationPlan,
  current: MigratedTimerClaim | null,
): boolean {
  if (plan.bookPatch !== null || current === null) return false;
  if (plan.claim.state === 'idle') return current.state === 'idle';
  return timerClaimsEqual(plan.claim, current);
}

export interface TimerClaimAuditFinding {
  cls: 'timer-lifecycle.missing' | 'timer-lifecycle.malformed' |
    'timer-lifecycle.books-invalid' | 'timer-lifecycle.mismatch';
  detail: string;
}

export function auditTimerClaimState(
  books: StoredBook[],
  lifecycle: { exists: boolean; data: unknown },
): TimerClaimAuditFinding[] {
  let plan: TimerClaimMigrationPlan;
  try {
    plan = planTimerClaim(books);
  } catch (error) {
    return [{
      cls: 'timer-lifecycle.books-invalid',
      detail: error instanceof Error ? error.message : String(error),
    }];
  }
  if (!lifecycle.exists) {
    return [{cls: 'timer-lifecycle.missing', detail: `expected ${plan.claim.state}`}];
  }
  let current: MigratedTimerClaim;
  try {
    current = decodeMigratedTimerClaim(lifecycle.data);
  } catch (error) {
    return [{
      cls: 'timer-lifecycle.malformed',
      detail: error instanceof Error ? error.message : String(error),
    }];
  }
  if (!timerClaimPlanIsApplied(plan, current)) {
    return [{
      cls: 'timer-lifecycle.mismatch',
      detail: `books=${plan.claim.state} lifecycle=${current.state}`,
    }];
  }
  return [];
}
