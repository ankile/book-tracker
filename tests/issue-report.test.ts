import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CLIENT_ISSUE_EVENTS, issueReportPayload } from '../src/lib/utils/issueReport.ts';

const input = {
  level: 'error' as const,
  event: 'firestore.listener_failed' as const,
  message: "Couldn't load books",
  code: 'permission-denied',
};

test('no session means no report, whatever the input', () => {
  assert.equal(issueReportPayload(false, input), null);
  assert.equal(issueReportPayload(false, { ...input, code: null }), null);
});

test('a signed-in report carries exactly the four callable fields', () => {
  const payload = issueReportPayload(true, input);
  assert.deepEqual(payload, {
    level: 'error',
    event: 'firestore.listener_failed',
    message: "Couldn't load books",
    code: 'permission-denied',
  });
  assert.deepEqual(Object.keys(payload!), ['level', 'event', 'message', 'code']);
});

test('fields are trimmed to the callable caps and an empty code becomes null', () => {
  const payload = issueReportPayload(true, {
    ...input,
    message: 'm'.repeat(1500),
    code: 'c'.repeat(150),
  });
  assert.equal(payload?.message.length, 1000);
  assert.equal(payload?.code?.length, 100);
  assert.equal(issueReportPayload(true, { ...input, code: '' })?.code, null);
  assert.equal(issueReportPayload(true, { ...input, code: null })?.code, null);
  assert.equal(issueReportPayload(true, { level: 'warn', event: 'toggl.sync_stuck', message: 'm' })?.code, null);
});

test('the client event allowlist is the server allowlist', async () => {
  const decoders = await readFile(new URL('../functions/src/decoders.ts', import.meta.url), 'utf8');
  assert.equal(
    decoders.indexOf('CLIENT_ISSUE_EVENTS = ['),
    decoders.lastIndexOf('CLIENT_ISSUE_EVENTS = ['),
    'more than one CLIENT_ISSUE_EVENTS literal in decoders.ts',
  );
  // Parse the shape, not the tokens: a one-per-line double-quoted literal,
  // so a comment, a quote-style change or a spread cannot slip an event
  // past this test in either direction.
  const literal = decoders.match(
    /export const CLIENT_ISSUE_EVENTS = \[\n((?:  "[^"\n]+",\n)+)\] as const;\n/,
  );
  assert.ok(literal, 'CLIENT_ISSUE_EVENTS is not a plain one-per-line double-quoted array literal');
  const serverEvents = literal[1].trimEnd().split('\n').map((line) => {
    const entry = line.match(/^  "([^"\n]+)",$/);
    assert.ok(entry, `unparsable entry: ${line}`);
    return entry[1];
  });
  assert.deepEqual([...CLIENT_ISSUE_EVENTS], serverEvents);
});

// db.ts cannot be imported here (it initialises Firestore's persistent
// cache at module load), so the two lines of logIssue that the pure module
// cannot see are pinned at the source level: the live session is what
// decides whether to report, and a failed report is console-only.
test('logIssue passes the live session and never surfaces its own failure', async () => {
  const db = await readFile(new URL('../src/lib/firebase/db.ts', import.meta.url), 'utf8');
  const start = db.indexOf('export function logIssue');
  assert.notEqual(start, -1);
  const body = db.slice(start, db.indexOf('\n}\n', start));
  assert.match(body, /issueReportPayload\(auth\.currentUser !== null, input\)/);
  assert.match(body, /\.catch\(\(error\) => console\.error\('logIssue failed', error\)\)/);
  assert.doesNotMatch(body, /addError/);
});
