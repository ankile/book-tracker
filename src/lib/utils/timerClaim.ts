import type { ActiveTimer, TogglActiveTimer } from '../interfaces/book.ts';
import type { Timestamp } from 'firebase/firestore';

export type ActiveTimerClaim =
  | { version: 1; state: 'local'; bookId: string; operationId: string; start: string }
  | { version: 1; state: 'remote'; bookId: string; entryId: number; start: string }
  | { version: 1; state: 'starting'; bookId: string; operationId: string; start: string; claimedAt: Timestamp }
  | { version: 1; state: 'outcome-unknown'; bookId: string; operationId: string; start: string; claimedAt: Timestamp; error: string }
  | { version: 1; state: 'stopping'; bookId: string; entryId: number; start: string; queueId: string };

export type IdleTimerClaim = { version: 1; state: 'idle'; cleared: ActiveTimerClaim | null };

export function activeTimerClaim(bookId: string, timer: ActiveTimer): ActiveTimerClaim {
  if (!('state' in timer)) {
    if (timer.entryId !== undefined) {
      return { version: 1, state: 'remote', bookId, entryId: timer.entryId, start: timer.start };
    }
    if (timer.operationId === undefined) throw new Error('Local timer is missing its operation id.');
    return { version: 1, state: 'local', bookId, operationId: timer.operationId, start: timer.start };
  }
  return { version: 1, ...timer, bookId };
}

export function idleTimerClaim(cleared: ActiveTimerClaim | null): IdleTimerClaim {
  return { version: 1, state: 'idle', cleared };
}

export function stoppingTimer(
  timer: TogglActiveTimer,
  queueId: string,
): ActiveTimer & { state: 'stopping' } {
  return {
    state: 'stopping',
    entryId: timer.entryId,
    start: timer.start,
    queueId,
  };
}
