// Mirrors CLIENT_ISSUE_EVENTS / decodeIssueReport in functions/src/decoders.ts;
// tests/issue-report.test.ts asserts the two lists are identical.
export const CLIENT_ISSUE_EVENTS = [
  'firestore.listener_failed',
  'firestore.decode_failed',
  'firestore.write_failed',
  'toggl.sync_stuck',
] as const;

export type ClientIssueEvent = (typeof CLIENT_ISSUE_EVENTS)[number];

export interface IssueInput {
  level: 'warn' | 'error';
  event: ClientIssueEvent;
  message: string;
  code?: string | null;
}

// Exactly what telemetry-reportissue accepts: four keys, no more.
export interface IssueReport {
  level: 'warn' | 'error';
  event: ClientIssueEvent;
  message: string;
  code: string | null;
}

// Shapes a report for the callable, or returns null when there is nothing
// to send. No session → null: signed-out clients report nothing (the only
// thing they could truthfully say is that their own sign-in failed, and an
// unauthenticated report path was the SEC-001 hole; the callable would
// refuse it anyway, but the invocation would still be billed). Every field
// is trimmed to the cap the callable enforces, and an empty code becomes
// null, because one rejected field would otherwise lose the whole event.
export function issueReportPayload(
  hasSession: boolean,
  { level, event, message, code = null }: IssueInput,
): IssueReport | null {
  if (!hasSession) return null;
  return {
    level,
    event,
    message: message.slice(0, 1000),
    code: code !== null && code.length > 0 ? code.slice(0, 100) : null,
  };
}
