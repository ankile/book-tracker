export type PendingReadingSessionMutation =
  | { operationId: number; kind: 'delete'; sessionId: string }
  | { operationId: number; kind: 'edit'; sessionId: string; priorVersion: string };

interface VersionedSession {
  id: string;
  updatedAt: { seconds: number; nanoseconds: number };
}

export function readingSessionVersion(session: VersionedSession): string {
  return `${session.updatedAt.seconds}:${session.updatedAt.nanoseconds}`;
}

// Cached stores synchronously replay their last value on subscription. Such
// an echo is not acknowledgement of a new write: deletion is confirmed only
// by absence, and an edit only by an updatedAt version change for that row.
export function readingSessionMutationConfirmed(
  pending: PendingReadingSessionMutation,
  sessions: readonly VersionedSession[],
): boolean {
  const current = sessions.find((session) => session.id === pending.sessionId);
  if (pending.kind === 'delete') return current === undefined;
  return current !== undefined && readingSessionVersion(current) !== pending.priorVersion;
}
