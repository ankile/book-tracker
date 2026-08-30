import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {parse} from 'svelte/compiler';
import ts from 'typescript';

const repository = fileURLToPath(new URL('..', import.meta.url));
const generatedJavaScript = new Set(['public/service-worker.js']);
const skippedPrefixes = ['build/', 'functions/lib/'];

function maintainedFiles(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: repository, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter((path) =>
      path.length > 0
      && existsSync(resolve(repository, path))
      && !skippedPrefixes.some((prefix) => path.startsWith(prefix))
    );
}

test('maintained source is TypeScript-only', () => {
  const stragglers = maintainedFiles().filter((path) =>
    /\.(?:cjs|js|jsx|mjs)$/.test(path) && !generatedJavaScript.has(path));
  assert.deepEqual(stragglers, []);
});

function typeScriptSources(path: string, source: string): {name: string; source: string}[] {
  if (!path.endsWith('.svelte')) return [{name: path, source}];

  const scripts: {name: string; source: string}[] = [];
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  for (const [index, match] of [...source.matchAll(scriptPattern)].entries()) {
    assert.match(match[1], /\blang=["']ts["']/, `${path}: Svelte scripts must use lang="ts"`);
    scripts.push({name: `${path}#script-${index + 1}.ts`, source: match[2]});
  }
  return scripts;
}

function uncheckedSyntax(source: ts.SourceFile): string[] {
  const failures: string[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) failures.push('explicit any type');
    if (ts.isAsExpression(node)) {
      if (node.type.kind === ts.SyntaxKind.NeverKeyword) failures.push('never assertion');
      let expression = node.expression;
      while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
      if (ts.isAsExpression(expression) && expression.type.kind === ts.SyntaxKind.UnknownKeyword) {
        failures.push('double assertion through unknown');
      }
    }
    if (ts.isSatisfiesExpression(node) && node.type.kind === ts.SyntaxKind.NeverKeyword) {
      failures.push('never satisfies escape');
    }
    node.forEachChild(visit);
  };
  visit(source);
  return failures;
}

function syntaxNodeType(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('type' in value)) return null;
  return typeof value.type === 'string' ? value.type : null;
}

function uncheckedSvelteSyntax(source: string, path: string): string[] {
  const failures: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || seen.has(value)) return;
    seen.add(value);
    const type = syntaxNodeType(value);
    if (type === 'TSAnyKeyword') failures.push('explicit any type');
    if (type === 'TSAsExpression') {
      if ('typeAnnotation' in value && syntaxNodeType(value.typeAnnotation) === 'TSNeverKeyword') {
        failures.push('never assertion');
      }
      if ('expression' in value && syntaxNodeType(value.expression) === 'TSAsExpression') {
        const expression = value.expression;
        if (
          typeof expression === 'object'
          && expression !== null
          && 'typeAnnotation' in expression
          && syntaxNodeType(expression.typeAnnotation) === 'TSUnknownKeyword'
        ) {
          failures.push('double assertion through unknown');
        }
      }
    }
    if (
      type === 'TSSatisfiesExpression'
      && 'typeAnnotation' in value
      && syntaxNodeType(value.typeAnnotation) === 'TSNeverKeyword'
    ) {
      failures.push('never satisfies escape');
    }
    const children: unknown[] = Object.values(value);
    for (const child of children) visit(child);
  };
  const withoutStyles = source.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '');
  visit(parse(withoutStyles, {filename: path, modern: true}));
  return failures;
}

test('escape-hatch scanning includes TypeScript and Svelte markup expressions', () => {
  const typeScript = ts.createSourceFile(
    'sample.ts',
    'const first = value as any; const second = value as unknown as string;',
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  assert.deepEqual(
    new Set(uncheckedSyntax(typeScript)),
    new Set(['explicit any type', 'double assertion through unknown']),
  );
  assert.deepEqual(
    uncheckedSvelteSyntax(
      '<script lang="ts">let value: unknown;</script>{value as any}',
      'sample.svelte',
    ),
    ['explicit any type'],
  );
});

test('TypeScript source has no unchecked escape hatches', async () => {
  const textChecks = [
    ['TypeScript suppression', /@ts-(?:expect-error|ignore|nocheck)\b/],
    ['explicit-any lint bypass', /eslint-disable[^\n]*no-explicit-any/],
  ] as const;
  const failures: string[] = [];
  const typeScriptFiles = maintainedFiles().filter((candidate) =>
    /\.(?:cts|mts|svelte|ts|tsx)$/.test(candidate)
  );
  for (const path of typeScriptFiles) {
    const source = await readFile(resolve(repository, path), 'utf8');
    if (path !== 'tests/typescript-only.test.ts') {
      for (const [label, pattern] of textChecks) {
        if (pattern.test(source)) failures.push(`${path}: ${label}`);
      }
    }
    if (path.endsWith('.svelte')) {
      failures.push(...uncheckedSvelteSyntax(source, path).map((failure) => `${path}: ${failure}`));
    }
    for (const script of typeScriptSources(path, source)) {
      const syntax = ts.createSourceFile(
        script.name,
        script.source,
        ts.ScriptTarget.Latest,
        true,
        script.name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      failures.push(...uncheckedSyntax(syntax).map((failure) => `${path}: ${failure}`));
    }
  }
  assert.deepEqual(failures, []);
});
