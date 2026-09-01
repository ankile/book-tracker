import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// The rules suite re-implements the client's profile batches by hand; it
// cannot notice when db.ts stops sending the batch the rules expect. This
// pins the batches structurally: every profile create/update/rename/delete
// moves the ownership record, and every profile write server-pins
// updatedAt.

function find(node: ts.Node, predicate: (n: ts.Node) => boolean, out: ts.Node[] = []): ts.Node[] {
  if (predicate(node)) out.push(node);
  node.forEachChild((child) => {
    find(child, predicate, out);
  });
  return out;
}

async function loadDatabase(): Promise<{ source: ts.SourceFile; method: (name: string) => ts.MethodDeclaration }> {
  const text = await readFile(new URL('../src/lib/firebase/db.ts', import.meta.url), 'utf8');
  const source = ts.createSourceFile('db.ts', text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const methods = find(source, (n) => ts.isMethodDeclaration(n)) as ts.MethodDeclaration[];
  return {
    source,
    method: (name) => {
      const found = methods.filter((m) => m.name.getText(source) === name);
      assert.equal(found.length, 1, `exactly one method ${name}`);
      return found[0];
    },
  };
}

// Calls of the form batch.<verb>(<ref>, ...) inside a method, where <ref>
// is doc(db, '<collection>', ...) inline or a const bound to such a call
// in the same method; keyed by collection and verb.
function batchWrites(source: ts.SourceFile, method: ts.MethodDeclaration): { collection: string; verb: string; args: ts.Expression[] }[] {
  const isDocCall = (n: ts.Node): n is ts.CallExpression =>
    ts.isCallExpression(n) && n.expression.getText(source) === 'doc';
  const collectionOf = (target: ts.CallExpression): string => {
    const collection = target.arguments[1];
    return ts.isStringLiteral(collection) ? collection.text : collection.getText(source);
  };
  const bound = new Map<string, string>();
  for (const declaration of find(method, (n) => ts.isVariableDeclaration(n)) as ts.VariableDeclaration[]) {
    if (declaration.initializer && isDocCall(declaration.initializer) && ts.isIdentifier(declaration.name)) {
      bound.set(declaration.name.text, collectionOf(declaration.initializer));
    }
  }
  const resolve = (ref: ts.Expression): string | null => {
    if (isDocCall(ref)) return collectionOf(ref);
    if (ts.isIdentifier(ref)) return bound.get(ref.text) ?? null;
    return null;
  };
  return (find(method, (n) => ts.isCallExpression(n)) as ts.CallExpression[])
    .filter((call) => ts.isPropertyAccessExpression(call.expression)
      && ['set', 'delete', 'update'].includes(call.expression.name.text)
      && call.arguments.length > 0
      && resolve(call.arguments[0]) !== null)
    .map((call) => ({
      collection: resolve(call.arguments[0])!,
      verb: (call.expression as ts.PropertyAccessExpression).name.text,
      args: [...call.arguments],
    }));
}

test('every profile batch moves the ownership record the rules require', async () => {
  const { source, method } = await loadDatabase();
  for (const name of ['createProfile', 'updateProfile', 'renameProfile']) {
    const writes = batchWrites(source, method(name));
    const record = writes.filter((w) => w.collection === 'profileOwners' && w.verb === 'set');
    assert.equal(record.length, 1, `${name} sets profileOwners once`);
    assert.match(record[0].args[1].getText(source), /^\{ username(: \w+)? \}$/, `${name} writes exactly { username }`);
    assert.ok(writes.some((w) => w.collection === 'profiles' && w.verb === 'set'), `${name} writes the profile in the same batch`);
    assert.ok(!method(name).getText(source).includes('setDoc('), `${name} uses a batch, never a lone setDoc`);
  }
  const deletion = batchWrites(source, method('deleteProfile'));
  assert.deepEqual(
    deletion.map((w) => `${w.verb} ${w.collection}`).sort(),
    ['delete profileDiscovery', 'delete profileOwners', 'delete profiles'],
  );
  // The rename deletes the old profile and its old marker, and the record
  // names the new username.
  const rename = batchWrites(source, method('renameProfile'));
  assert.ok(rename.some((w) => w.collection === 'profiles' && w.verb === 'delete'));
  assert.ok(rename.filter((w) => w.collection === 'profileDiscovery' && w.verb === 'delete').length === 1);
  const renameRecord = rename.find((w) => w.collection === 'profileOwners')!;
  assert.equal(renameRecord.args[1].getText(source), '{ username: newUsername }');
});

test('profile writes server-pin updatedAt', async () => {
  const { source, method } = await loadDatabase();
  for (const name of ['createProfile', 'updateProfile', 'renameProfile', 'addProfileLink']) {
    const text = method(name).getText(source);
    assert.ok(!text.includes('Timestamp.now()'), `${name} must not stamp updatedAt with the device clock`);
    assert.match(text, /updatedAt: serverTimestamp\(\)/, `${name} writes updatedAt: serverTimestamp()`);
  }
  // The own-profile listener must tolerate the pending server timestamp.
  const listener = method('getMyProfile').getText(source);
  assert.match(listener, /profileDoc\.data\(\{ serverTimestamps: 'estimate' \}\)/);

  const sharingListener = method('getBookSharingSettings').getText(source);
  assert.match(sharingListener, /snapshot\.data\(\{ serverTimestamps: 'estimate' \}\)/);
  const sharingWrite = method('setBookSharing').getText(source);
  assert.match(sharingWrite, /createdAt: serverTimestamp\(\)/);
  assert.match(sharingWrite, /updatedAt: serverTimestamp\(\)/);
});

// Sharing is independent of the profile: no profile write may touch the
// owner-scoped setting, in either direction.
test('book sharing stays outside every profile write', async () => {
  const { source, method } = await loadDatabase();
  for (const name of ['createProfile', 'updateProfile', 'renameProfile', 'deleteProfile']) {
    assert.doesNotMatch(method(name).getText(source), /bookSharing|'settings'/, name);
  }
  const sharing = method('setBookSharing').getText(source);
  assert.match(sharing, /updateDoc\(ref, \{ enabled, timeZone, updatedAt: serverTimestamp\(\) \}\)/);
  assert.doesNotMatch(sharing, /profileUsername/);
});

test('client caps mirror the rules literals for books', async () => {
  const rules = await readFile(new URL('../firestore.rules', import.meta.url), 'utf8');
  const shape = rules.slice(rules.indexOf('function validBookShape('));
  const body = shape.slice(0, shape.indexOf('\n    }'));
  // The exempt set of a progress update is exactly the fields the
  // transition rules and validBookProgressFields type — adding one here is
  // opening an uncapped channel (review, books face: a mutation that
  // appended a field admitted a 900 KB publisher).
  const update = rules.slice(rules.indexOf("match /users/{userId}/books/{bookId}"));
  const exempt = update.match(/affectedKeys\(\)\.hasOnly\(\[\s*([^\]]+)\]\)\s*&& validBookProgressFields\(\)/);
  assert.ok(exempt, 'the progress exemption is guarded by validBookProgressFields()');
  assert.deepEqual(
    exempt![1].split(',').map((field) => field.trim().replace(/'/g, '')).filter(Boolean).sort(),
    ['activeTimer', 'currentPage', 'currentPageUpdateId', 'finished', 'finishedAt', 'pagesRead', 'timeRead', 'updatedAt'],
  );
  // The pre-migration author fields stay out of the allowlist.
  assert.equal(/'author'|'authors'/.test(body), false);
  // The stopping timer's queue id may not carry a path separator (SEC-040),
  // in the timer and in the claim.
  assert.equal((rules.match(/queueId\.matches\('\[\^\/\]\{1,600\}'\)/g) ?? []).length, 2);
  const metadata = await readFile(new URL('../src/lib/utils/bookMetadata.ts', import.meta.url), 'utf8');
  const maxSubjects = Number(metadata.match(/const MAX_SUBJECTS = (\d+);/)![1]);
  assert.match(body, new RegExp(`book\\.subjects\\.size\\(\\) <= ${maxSubjects}\\b`));
  const form = await readFile(new URL('../src/lib/utils/bookForm.ts', import.meta.url), 'utf8');
  const maxIsbn = Number(form.match(/const MAX_ISBN_LENGTH = (\d+);/)![1]);
  assert.match(body, new RegExp(`book\\.isbn\\.size\\(\\) <= ${maxIsbn}\\b`));
});
