import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
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

// Source-level pins for cross-file invariants no import can check: the
// server allowlist lives in another package's tsconfig, db.ts cannot be
// imported here (module-load initializeFirestore / persistentLocalCache
// needs IndexedDB), and the admin page is a Svelte component. Assert on the
// AST rather than the source text, so reformatting, comments and quote
// style are free and only a semantic change fails.
function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
}

// forEachChild stops at the first truthy return, so the recursive call must
// not return the accumulator.
function find(node: ts.Node, predicate: (n: ts.Node) => boolean, out: ts.Node[] = []): ts.Node[] {
  if (predicate(node)) out.push(node);
  node.forEachChild((child) => {
    find(child, predicate, out);
  });
  return out;
}

test('the client event allowlist is the server allowlist', async () => {
  const source = await readFile(new URL('../functions/src/decoders.ts', import.meta.url), 'utf8');
  const declarations = find(parse(source), (n) =>
    ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'CLIENT_ISSUE_EVENTS');
  assert.equal(declarations.length, 1, 'expected exactly one CLIENT_ISSUE_EVENTS declaration');
  const initializer = (declarations[0] as ts.VariableDeclaration).initializer;
  assert.ok(initializer);
  const array = ts.isAsExpression(initializer) ? initializer.expression : initializer;
  assert.ok(
    ts.isArrayLiteralExpression(array),
    'CLIENT_ISSUE_EVENTS must stay a literal array — a spread or a call hides events from this test',
  );
  const serverEvents = array.elements.map((element) => {
    assert.ok(ts.isStringLiteral(element), `CLIENT_ISSUE_EVENTS element is not a string literal: ${element.getText()}`);
    return element.text;
  });
  assert.deepEqual([...CLIENT_ISSUE_EVENTS], serverEvents);
});

test('logIssue reports once, on the live session, and swallows its own failure', async () => {
  const source = await readFile(new URL('../src/lib/firebase/db.ts', import.meta.url), 'utf8');
  const declarations = find(parse(source), (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'logIssue');
  assert.equal(declarations.length, 1);
  const calls = find(declarations[0], ts.isCallExpression) as ts.CallExpression[];

  // The live session, not a constant, decides whether to report.
  assert.deepEqual(
    calls
      .filter((call) => call.expression.getText() === 'issueReportPayload')
      .map((call) => call.arguments[0].getText()),
    ['auth.currentUser !== null'],
  );

  // Exactly one send, and its rejection goes nowhere but the console: an
  // addError here would put the callable's rejection text in the user's
  // banner on every backend hiccup, and a missing catch is an unhandled
  // rejection (src/ has no no-floating-promises lint).
  const sends = calls.filter((call) => call.expression.getText() === 'reportIssue');
  assert.equal(sends.length, 1, 'logIssue must make exactly one reportIssue call');
  const access = sends[0].parent;
  assert.ok(ts.isPropertyAccessExpression(access) && access.name.text === 'catch', 'the reportIssue call is not caught');
  const handler = (access.parent as ts.CallExpression).arguments[0];
  assert.ok(ts.isArrowFunction(handler), 'the catch handler must be an arrow function');
  const body =
    ts.isBlock(handler.body) && handler.body.statements.length === 1 && ts.isExpressionStatement(handler.body.statements[0])
      ? handler.body.statements[0].expression
      : handler.body;
  assert.ok(
    ts.isCallExpression(body) && body.expression.getText() === 'console.error',
    'the catch handler must do nothing but console.error',
  );
  assert.doesNotMatch(declarations[0].getText(), /addError/);
});

test('the admin page reads issueCaps only through the guarded derived and names every cap', async () => {
  const page = await readFile(new URL('../src/routes/admin/+page.svelte', import.meta.url), 'utf8');
  assert.match(page, /const caps = \$derived\(overview\?\.issueCaps \?\? null\)/);
  // Exactly one mention of issueCaps: the derived itself. A bare
  // overview.issueCaps.x crashes the page against a server that predates it.
  assert.equal(page.split('issueCaps').length - 1, 1);
  for (const field of ['cappedAccounts', 'anonymousCapped', 'shown', 'unreadAccounts', 'anonymousUnread']) {
    assert.ok(page.includes(`caps.${field}`), `no feed note reads caps.${field}`);
  }
  // An empty feed after a failed read must not render as all clear.
  const allClear = page.indexOf('No warnings or errors — all clear.');
  assert.notEqual(allClear, -1);
  const guard = page.lastIndexOf('{#if overview.issues.length === 0 && readFailed}', allClear);
  assert.notEqual(guard, -1, 'the all-clear line is not preceded by the read-failure guard');
  assert.match(page.slice(guard, allClear), /{:else if overview\.issues\.length === 0}/);
});
