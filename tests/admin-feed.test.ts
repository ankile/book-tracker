import assert from 'node:assert/strict';
import test from 'node:test';
import { feedNotes, groupIssues, readFailed, type IssueCaps } from '../src/lib/utils/adminFeed.ts';
import type { AdminIssueRow } from '../src/lib/firebase/functions.ts';

const caps = (over: Partial<IssueCaps> = {}): IssueCaps => ({
  perAccount: 10,
  cappedAccounts: 0,
  anonymous: 25,
  anonymousCapped: false,
  shown: 0,
  total: 0,
  groupsWithRows: 0,
  groupsShown: 0,
  unreadAccounts: 0,
  anonymousUnread: false,
  cappedAccountEmails: [],
  ...over,
});

test('an empty feed is all clear only when every read succeeded', () => {
  assert.equal(readFailed(null), false);
  assert.equal(readFailed(caps()), false);
  assert.equal(readFailed(caps({ unreadAccounts: 1 })), true);
  assert.equal(readFailed(caps({ anonymousUnread: true })), true);
  assert.equal(readFailed(caps({ unreadAccounts: 17, anonymousUnread: true })), true);
  // Caps that were cut or capped but fully read are not a failure.
  assert.equal(readFailed(caps({ cappedAccounts: 3, shown: 200, total: 340 })), false);
});

test('every way the feed can be incomplete produces exactly one note', () => {
  assert.deepEqual(feedNotes(null), []);
  assert.deepEqual(feedNotes(caps()), []);
  assert.deepEqual(feedNotes(caps({ shown: 12, total: 12, groupsWithRows: 3, groupsShown: 3 })), []);
  const single: [Partial<IssueCaps>, RegExp][] = [
    [{ cappedAccounts: 1 }, /^1 account has more than 10 rows/],
    [{ cappedAccounts: 4 }, /^4 accounts have more than 10 rows/],
    [{ anonymousCapped: true }, /^only the newest 25 anonymous/],
    [{ shown: 200, total: 340 }, /^showing 200 of 340 rows/],
    [{ groupsWithRows: 230, groupsShown: 200 }, /^30 accounts have rows in this window that did not fit at all/],
    [{ groupsWithRows: 201, groupsShown: 200 }, /^1 account has rows in this window that did not fit at all/],
    [{ unreadAccounts: 1 }, /^1 account could not be read — its rows are missing$/],
    [{ unreadAccounts: 3 }, /^3 accounts could not be read — their rows are missing$/],
    [{ anonymousUnread: true }, /^the anonymous sign-in failures could not be read$/],
  ];
  for (const [over, pattern] of single) {
    const notes = feedNotes(caps(over));
    assert.equal(notes.length, 1, JSON.stringify(over));
    assert.match(notes[0], pattern);
  }
  assert.equal(
    feedNotes(caps({ cappedAccounts: 2, anonymousCapped: true, shown: 200, total: 340, groupsWithRows: 210, groupsShown: 200, unreadAccounts: 3, anonymousUnread: true })).length,
    6,
  );
});

test('the capped-accounts note names the accounts when the server sends them', () => {
  assert.match(feedNotes(caps({ cappedAccounts: 1, cappedAccountEmails: ['a@example.test'] }))[0], /listed \(a@example.test\)$/);
  assert.match(feedNotes(caps({ cappedAccounts: 2, cappedAccountEmails: ['a@example.test', 'b@example.test'] }))[0], /\(a@example.test, b@example.test\)$/);
  // A server that predates the field still states the count.
  const legacy = { ...caps({ cappedAccounts: 1 }) } as Partial<IssueCaps>;
  delete legacy.cappedAccountEmails;
  assert.match(feedNotes(legacy as IssueCaps)[0], /listed$/);
});

const issue = (at: number, over: Partial<AdminIssueRow> = {}): AdminIssueRow => ({
  id: `id-${at}`, at, level: 'error', event: 'firestore.write_failed', code: 'permission-denied',
  message: 'updateProfile failed', uid: 'u1', email: 'a@example.test', emailVerified: true,
  malformed: false, ...over,
});

test('identical consecutive rows collapse into one line that keeps the newest time and the span', () => {
  const rows = [
    issue(5000), issue(4000), issue(3000),
    issue(2500, { message: 'other' }),
    issue(2000), issue(1000, { email: 'b@example.test' }),
  ];
  const groups = groupIssues(rows);
  assert.deepEqual(groups.map(({ row, count, earliestAt }) => [row.at, count, earliestAt]), [
    [5000, 3, 3000], [2500, 1, 2500], [2000, 1, 2000], [1000, 1, 1000],
  ]);
  // A different level or code is a different line even with the same message.
  assert.equal(groupIssues([issue(2), issue(1, { level: 'warn' })]).length, 2);
  assert.equal(groupIssues([issue(2), issue(1, { code: null })]).length, 2);
  assert.deepEqual(groupIssues([]), []);
});
