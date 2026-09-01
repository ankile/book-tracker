import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { FunctionsError } from 'firebase/functions';

import {
  adminCatalogCandidatesByBook,
  adminCatalogCandidatesForBook,
  classifyAdminCatalogFailure,
  decodeAdminCatalogApplyResponse,
  decodeAdminCatalogPreviewResponse,
  externalIndexId,
  parseAdminBookTargets,
  parseAdminExternalIds,
  parseAdminStringList,
} from '../src/lib/utils/adminCatalog.ts';
import type {
  AdminCatalogBookRow,
  AdminCatalogWorkRow,
  CatalogScan,
} from '../src/lib/interfaces/catalog.ts';

const work: AdminCatalogWorkRow = {
  workId: 'work', canonicalTitle: 'Book', alternateTitles: [], authorIds: ['author'],
  coverUrl: '', subjects: [], fiction: null, status: 'hidden',
  mergedFrom: [], createdBy: null, createdAt: 900,
  editionCount: 1, linkedBookCount: 1, warnings: [],
};
const book: AdminCatalogBookRow = {
  uid: 'user', bookId: 'book', title: 'Personal title', authorNames: ['Author'],
  isbn13: '9780316769488', rawIsbn: null, pageCount: 201, publisher: '',
  coverUrl: '', workId: 'work', editionId: 'edition', anomaly: null,
};

test('admin catalog candidates prioritize exact identity evidence and prefill exact editions', () => {
  const unmatched: AdminCatalogBookRow = {...book, workId: null, editionId: null};
  const scan: Pick<CatalogScan, 'works' | 'books' | 'findings'> = {
    works: [work],
    books: [unmatched],
    findings: [
      {code: 'likely-title-author-candidate', severity: 'warning', message: 'Likely', workIds: ['work'], editionIds: [], books: [{uid: 'user', bookId: 'book'}]},
      {code: 'unmatched-isbn-candidate', severity: 'warning', message: 'Exact', workIds: ['work'], editionIds: ['edition'], books: [{uid: 'user', bookId: 'book'}]},
      {code: 'unmatched-isbn-candidate', severity: 'warning', message: 'Other', workIds: ['work'], editionIds: ['edition'], books: [{uid: 'user', bookId: 'other'}]},
    ],
  };
  assert.deepEqual(adminCatalogCandidatesForBook(scan, unmatched), [{
    workId: 'work', editionId: 'edition', label: 'Exact ISBN', title: 'Book',
  }]);
  // The per-page map keys unmatched books only and never invents a
  // candidate for a work the scan does not know.
  const byBook = adminCatalogCandidatesByBook({...scan, books: [unmatched, {...book, bookId: 'linked'}]});
  assert.deepEqual([...byBook.keys()], ['user/book']);
  assert.deepEqual(adminCatalogCandidatesForBook({...scan, works: []}, unmatched), []);
});

// The browser computes externalIdIndex ids to check every index row; it
// must agree byte for byte with the server's node:crypto digest.
test('the browser-side external index id is the server digest', async () => {
  const expected = createHash('sha256').update('open-library\0OL1M').digest('hex');
  assert.equal(await externalIndexId('open-library', 'OL1M'), expected);
  assert.notEqual(await externalIndexId('open-library', 'OL1N'), expected);
});

test('admin preview and apply decoders retain exact before/after differences', () => {
  const expected = {
    catalog: [{kind: 'work', id: 'work', exists: true, updatedAt: 1000}],
    books: [{
      uid: 'user', bookId: 'book', workId: null, editionId: null,
      matchMethod: null, linkedAt: null, decisionIsbn13: null,
    }],
  };
  const preview = decodeAdminCatalogPreviewResponse({
    operationId: 'operation', operationHash: 'hash', expected,
    changes: [{
      kind: 'book', id: 'user/book', action: 'update',
      before: {workId: null}, after: {workId: 'work', editionId: null},
    }],
    touchedDocuments: 2,
  });
  assert.deepEqual(preview.changes[0].after, {workId: 'work', editionId: null});
  assert.deepEqual(decodeAdminCatalogApplyResponse({
    operationId: 'operation', applied: true, touchedDocuments: 2,
  }), {operationId: 'operation', applied: true, touchedDocuments: 2});
  assert.throws(() => decodeAdminCatalogPreviewResponse({
    ...preview, changes: [{...preview.changes[0], after: {bad: Number.NaN}}],
  }), /finite number/);
});

test('admin catalog error classifier recognizes only dedicated code and detail pairs', () => {
  assert.deepEqual(classifyAdminCatalogFailure(new FunctionsError(
    'failed-precondition', 'Sign in again', {reason: 'recent-auth-required', maxAgeSeconds: 900},
  )), {kind: 'recent-auth-required', maxAgeSeconds: 900});
  assert.deepEqual(classifyAdminCatalogFailure(new FunctionsError(
    'aborted', 'Stale', {reason: 'stale-preview'},
  )), {kind: 'stale-preview'});
  assert.deepEqual(classifyAdminCatalogFailure(new FunctionsError(
    'resource-exhausted', 'Large', {reason: 'operation-too-large', maxTouchedDocuments: 200},
  )), {kind: 'operation-too-large', maxTouchedDocuments: 200});
  assert.deepEqual(classifyAdminCatalogFailure(new FunctionsError(
    'resource-exhausted', 'Full', {reason: 'catalog-capacity', collection: 'works', maximum: 200},
  )), {kind: 'catalog-capacity', collection: 'works', maximum: 200});
  assert.deepEqual(classifyAdminCatalogFailure(new FunctionsError(
    'failed-precondition', 'Wrong pairing', {reason: 'stale-preview'},
  )), {kind: 'unknown'});
  assert.deepEqual(classifyAdminCatalogFailure(new Error('recent-auth-required')), {kind: 'unknown'});
});

test('admin form parsers accept bounded line-oriented targets and metadata', () => {
  assert.deepEqual(parseAdminBookTargets('user-a/book-a\nuser-b/book-b\n'), [
    {uid: 'user-a', bookId: 'book-a'}, {uid: 'user-b', bookId: 'book-b'},
  ]);
  assert.throws(() => parseAdminBookTargets('users/user/books/book'), /uid\/bookId/);
  assert.deepEqual(parseAdminStringList('One\nTwo\nOne'), ['One', 'Two']);
  assert.deepEqual(parseAdminExternalIds('openlibrary=OL1M\ngoogle=abc=def'), {
    openlibrary: 'OL1M', google: 'abc=def',
  });
  assert.throws(() => parseAdminExternalIds('missing-separator'), /provider=id/);
});
