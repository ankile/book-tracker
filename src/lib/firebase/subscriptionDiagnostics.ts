// Deliberately no query paths, document identifiers, data, or error messages.
export const queryLabels = ['authors', 'user', 'books', 'profile', 'discovery', 'sharing', 'book-updates', 'history', 'admin-authors', 'admin-works', 'admin-editions', 'admin-isbn', 'admin-external', 'admin-books', 'admin-users'] as const;
export type QueryLabel = typeof queryLabels[number];
type Kind = 'start' | 'stop' | 'snapshot' | 'error';
type Details = { count?: number; fromCache?: boolean; hasPendingWrites?: boolean; code?: string };
const codes = new Set(['cancelled', 'unknown', 'invalid-argument', 'deadline-exceeded', 'not-found', 'already-exists', 'permission-denied', 'resource-exhausted', 'failed-precondition', 'aborted', 'out-of-range', 'unimplemented', 'internal', 'unavailable', 'data-loss', 'unauthenticated']);
export function createSubscriptionDiagnostics(now = Date.now, context = () => ({online: true, visibility: 'unknown'})) {
  const events: Array<{at: number; label: QueryLabel; kind: Kind; online: boolean; visibility: string} & Details> = [];
  let expiresAt = 0;
  let session = '';
  return {
    start() { events.length = 0; session = crypto.randomUUID(); expiresAt = now() + 600_000; },
    stop() { expiresAt = 0; },
    clear() { events.length = 0; expiresAt = 0; session = ''; },
    record(label: QueryLabel, kind: Kind, details: Details = {}) {
      if (now() >= expiresAt || !queryLabels.includes(label)) return;
      const {online, visibility} = context();
      const event = {at: now(), label, kind, online: online === true, visibility: ['visible', 'hidden'].includes(visibility) ? visibility : 'unknown',
        ...(typeof details.count === 'number' && Number.isSafeInteger(details.count) && details.count >= 0 ? {count: details.count} : {}),
        ...(typeof details.fromCache === 'boolean' ? {fromCache: details.fromCache} : {}),
        ...(typeof details.hasPendingWrites === 'boolean' ? {hasPendingWrites: details.hasPendingWrites} : {}),
        ...(details.code !== undefined ? {code: codes.has(details.code) ? details.code : 'unknown'} : {}),
      };
      if (events.length === 500) events.shift();
      events.push(event);
    },
    export() { return {version: 1, session, active: now() < expiresAt, expiresAt, events: events.map(event => ({...event}))}; },
  };
}

export function instrumentSubscription<Snapshot, Failure extends {code: string}>(
  capture: ReturnType<typeof createSubscriptionDiagnostics>, label: QueryLabel,
  subscribe: (next: (snapshot: Snapshot) => void, error: (error: Failure) => void) => () => void,
  metadata: (snapshot: Snapshot) => Details,
  next: (snapshot: Snapshot) => void, error: (error: Failure) => void,
) {
  capture.record(label, 'start');
  let stopped = false;
  const stop = subscribe(snapshot => {
    capture.record(label, 'snapshot', metadata(snapshot));
    next(snapshot);
  }, failure => {
    capture.record(label, 'error', {code: failure.code});
    error(failure);
  });
  return () => {
    if (stopped) return;
    stopped = true;
    capture.record(label, 'stop');
    stop();
  };
}
