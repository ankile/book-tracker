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
  const start = decoders.indexOf('export const CLIENT_ISSUE_EVENTS = [');
  assert.notEqual(start, -1);
  const literal = decoders.slice(start, decoders.indexOf('] as const;', start));
  const serverEvents = [...literal.matchAll(/"([a-z_.]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...CLIENT_ISSUE_EVENTS], serverEvents);
});
