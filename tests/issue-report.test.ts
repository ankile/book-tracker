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
  const file = parse(source);
  const declarations = find(file, (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'logIssue');
  assert.equal(declarations.length, 1);
  const calls = find(declarations[0], ts.isCallExpression) as ts.CallExpression[];

  // The live session, not a constant, decides whether to report. Compared
  // structurally: `auth.currentUser !== null`, `null != auth.currentUser`
  // and friends are the same predicate.
  const checks = calls.filter((call) => call.expression.getText() === 'issueReportPayload').map((call) => call.arguments[0]);
  assert.equal(checks.length, 1);
  const [check] = checks;
  assert.ok(ts.isBinaryExpression(check), 'the session check is not a comparison');
  assert.deepEqual([check.left.getText(), check.right.getText()].sort(), ['auth.currentUser', 'null']);
  assert.ok(
    [ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(check.operatorToken.kind),
    'the session check must be a not-equal against null',
  );
  assert.ok(
    find(declarations[0], (n) => ts.isIfStatement(n) && /payload === null|null === payload/.test(n.expression.getText())).length === 1,
    'a null payload must return before anything is sent',
  );

  // Exactly one send in the whole module, and its rejection goes nowhere
  // but the console: an addError here would put the callable's rejection
  // text in the user's banner on every backend hiccup, and a missing catch
  // is an unhandled rejection (src/ has no no-floating-promises lint).
  const sendsInFile = (find(file, ts.isCallExpression) as ts.CallExpression[]).filter((c) => c.expression.getText() === 'reportIssue');
  assert.equal(sendsInFile.length, 1, 'reportIssue may only be called from logIssue, once');
  const sends = calls.filter((call) => call.expression.getText() === 'reportIssue');
  assert.equal(sends.length, 1);
  // Walk the chain to the .catch, whatever is chained before it.
  let node: ts.Node = sends[0];
  while (ts.isPropertyAccessExpression(node.parent) && ts.isCallExpression(node.parent.parent) && node.parent.name.text !== 'catch') {
    node = node.parent.parent;
  }
  const access = node.parent;
  assert.ok(ts.isPropertyAccessExpression(access) && access.name.text === 'catch', 'the reportIssue call is not caught');
  const catchCall = access.parent as ts.CallExpression;
  const handler = catchCall.arguments[0];
  assert.ok(ts.isArrowFunction(handler), 'the catch handler must be an arrow function');
  const body =
    ts.isBlock(handler.body) && handler.body.statements.length === 1 && ts.isExpressionStatement(handler.body.statements[0])
      ? handler.body.statements[0].expression
      : handler.body;
  assert.ok(ts.isCallExpression(body) && body.expression.getText() === 'console.error', 'the catch handler must do nothing but console.error');
  // Nothing may be chained after the catch: a .then/.finally there can
  // produce a fresh unhandled rejection.
  assert.ok(ts.isExpressionStatement(catchCall.parent) || ts.isVoidExpression(catchCall.parent), 'nothing may be chained after the .catch');
  assert.doesNotMatch(declarations[0].getText(), /addError/);
});

test('the admin page reads issueCaps only through the guarded derived and gates all clear on it', async () => {
  const page = await readFile(new URL('../src/routes/admin/+page.svelte', import.meta.url), 'utf8');
  const code = page.replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
  assert.match(code, /const caps = \$derived\(overview\?\.issueCaps \?\? null\)/);
  // Exactly one mention of issueCaps outside comments: the derived itself.
  // A bare overview.issueCaps.x crashes the page against a server that
  // predates it.
  assert.equal(code.split('issueCaps').length - 1, 1, 'issueCaps must be read exactly once, through the guarded derived');
  // The notes and the failure predicate come from the tested module, not
  // from inline logic.
  assert.match(code, /const feedNotes = \$derived\(feedNotesFor\(caps\)\)/);
  assert.match(code, /const readFailed = \$derived\(readFailedFor\(caps\)\)/);
  assert.match(code, /import \{ feedNotes as feedNotesFor, readFailed as readFailedFor \} from '\$lib\/utils\/adminFeed\.ts'/);
  // An empty feed after a failed read must not render as all clear.
  const allClear = code.indexOf('No warnings or errors — all clear.');
  assert.notEqual(allClear, -1);
  const guard = code.lastIndexOf('{#if overview.issues.length === 0 && readFailed}', allClear);
  assert.notEqual(guard, -1, 'the all-clear line is not preceded by the read-failure guard');
  assert.match(code.slice(guard, allClear), /{:else if overview\.issues\.length === 0}/);
  assert.match(code.slice(guard, allClear), /Nothing could be shown for this window/);
  // Every note is rendered as its own list item.
  assert.match(code, /{#each feedNotes as note}\s*<li>{note}\.<\/li>/);
});
