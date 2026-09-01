import type { AdminIssueRow, AdminOverview } from '../firebase/functions.ts';

export type IssueCaps = AdminOverview['issueCaps'];

// One feed line per run of identical rows: the same account, event, level,
// code and message repeated (a listener that fails five times in a minute)
// reads as one line with a count and the span it covers, not five lines
// that hide the rows around them. Rows arrive newest first and stay so.
export interface IssueGroup {
  row: AdminIssueRow;
  count: number;
  earliestAt: number;
}

export function groupIssues(rows: readonly AdminIssueRow[]): IssueGroup[] {
  const groups: IssueGroup[] = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last !== undefined && last.row.email === row.email && last.row.event === row.event &&
        last.row.level === row.level && last.row.code === row.code &&
        last.row.message === row.message) {
      last.count += 1;
      last.earliestAt = Math.min(last.earliestAt, row.at);
      continue;
    }
    groups.push({ row, count: 1, earliestAt: row.at });
  }
  return groups;
}

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
    // The names arrive with servers from 2026-09-01 on; an older answer
    // still states the count.
    const names = caps.cappedAccountEmails ?? [];
    notes.push(
      `${caps.cappedAccounts} ${caps.cappedAccounts === 1 ? 'account has' : 'accounts have'} more than ${caps.perAccount} rows in this window — only the newest ${caps.perAccount} of each are listed${names.length > 0 ? ` (${names.join(', ')})` : ''}`
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
