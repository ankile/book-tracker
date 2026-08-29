import type { AdminOverview } from '../firebase/functions.ts';

export type IssueCaps = AdminOverview['issueCaps'];

// An empty feed means "nothing happened" only when every read succeeded;
// after a total read failure (a missing index, an IAM change) it would
// otherwise render as a green all-clear. Null caps (a server that predates
// them) cannot claim a failure.
export function readFailed(caps: IssueCaps | null): boolean {
  return caps !== null && (caps.unreadAccounts > 0 || caps.anonymousUnread);
}

// A capped feed that looks complete is worse than one that admits it is
// incomplete, so everything that hid a row is named with its real number.
export function feedNotes(caps: IssueCaps | null): string[] {
  if (caps === null) return [];
  const notes: string[] = [];
  if (caps.cappedAccounts > 0) {
    notes.push(
      `${caps.cappedAccounts} ${caps.cappedAccounts === 1 ? 'account has' : 'accounts have'} more than ${caps.perAccount} rows in this window — only the newest ${caps.perAccount} of each are listed`
    );
  }
  if (caps.anonymousCapped) {
    notes.push(`only the newest ${caps.anonymous} anonymous sign-in failures are listed`);
  }
  if (caps.shown < caps.total) {
    notes.push(`showing ${caps.shown} of ${caps.total} rows, shared evenly between accounts`);
  }
  if (caps.groupsShown < caps.groupsWithRows) {
    const dropped = caps.groupsWithRows - caps.groupsShown;
    notes.push(
      `${dropped} ${dropped === 1 ? 'account has' : 'accounts have'} rows in this window that did not fit at all — the feed holds one row per account up to ${caps.groupsShown} accounts`
    );
  }
  if (caps.unreadAccounts > 0) {
    notes.push(
      `${caps.unreadAccounts} ${caps.unreadAccounts === 1 ? 'account' : 'accounts'} could not be read — ${caps.unreadAccounts === 1 ? 'its' : 'their'} rows are missing`
    );
  }
  if (caps.anonymousUnread) {
    notes.push('the anonymous sign-in failures could not be read');
  }
  return notes;
}
