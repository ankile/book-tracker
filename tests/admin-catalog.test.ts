import assert from 'node:assert/strict';
import test from 'node:test';
import { FunctionsError } from 'firebase/functions';

import {
  classifyAdminCatalogFailure,
  adminCatalogCandidatesForBook,
  decodeAdminCatalogApplyResponse,
  decodeAdminCatalogPreviewResponse,
  decodeAdminCatalogScanResponse,
  parseAdminBookTargets,
  parseAdminExternalIds,
  parseAdminStringList,
} from '../src/lib/utils/adminCatalog.ts';

const work = {
  workId: 'work', canonicalTitle: 'Book', alternateTitles: [], authorIds: ['author'],
  coverUrl: '', subjects: [], fiction: null, status: 'hidden',
  mergedFrom: [], createdBy: null, createdAt: 900,
  editionCount: 1, linkedBookCount: 1, warnings: [],
};
const edition = {
  editionId: 'edition', workId: 'work', isbn13: '9780316769488', title: 'Book',
  publisher: '', publishedDate: '', language: '',
  translatorNames: [], format: 'unknown', suggestedPageCount: 200, coverUrl: '',
  externalIds: {'open-library': 'OL1M'},
};
const author = {
  authorId: 'author', canonicalName: 'Author', alternateNames: [],
  sortName: 'Author', kind: 'person', status: 'active',
  mergedFrom: [], workCount: 1, warnings: [],
};
const limits = {catalogAuthors: 500, works: 200, books: 100};
const book = {
  uid: 'user', bookId: 'book', title: 'Personal title', authorNames: ['Author'],
  isbn13: '9780316769488', rawIsbn: null, pageCount: 201, publisher: '',
  coverUrl: '', workId: 'work', editionId: 'edition', anomaly: null,
};

test('admin catalog scan decoder accepts the bounded identity-only projection', () => {
  const decoded = decodeAdminCatalogScanResponse({
    authors: [author], works: [work], editions: [edition], books: [book], nextBookCursor: null,
    bookCountsComplete: true, findings: [{
      code: 'unmatched-isbn-candidate', severity: 'warning', message: 'Review link',
      workIds: ['work'], editionIds: ['edition'], books: [{uid: 'user', bookId: 'book'}],
    }],
    limits,
  });
  assert.equal(decoded.works[0].canonicalTitle, 'Book');
  assert.equal(decoded.books[0].pageCount, 201);
  assert.equal('currentPage' in decoded.books[0], false);
  assert.equal('timeRead' in decoded.books[0], false);
  assert.equal('activeTimer' in decoded.books[0], false);
});

// A book with no usable page count is the reason the scan reports null: an
// older row may carry none at all, and dropping the whole page over it left
// the console blank (the decoder used to refuse anything but a positive
// integer).
test('admin catalog scan decoder keeps a book that has no page count', () => {
  const response = {
    authors: [author], works: [work], editions: [edition], nextBookCursor: null,
    bookCountsComplete: true, findings: [], limits,
  };
  const decoded = decodeAdminCatalogScanResponse({
    ...response, books: [{...book, pageCount: null}],
  });
  assert.equal(decoded.books[0].pageCount, null);
  assert.throws(() => decodeAdminCatalogScanResponse({
    ...response, books: [{...book, pageCount: 0}],
  }), /positive safe integer or null/);
});

// The console labels findings by code, so a code it does not know is a
// deploy mismatch, not a row to render blank.
test('admin catalog scan decoder rejects an unknown finding code', () => {
  assert.throws(() => decodeAdminCatalogScanResponse({
    authors: [author], works: [work], editions: [edition], books: [book],
    nextBookCursor: null, bookCountsComplete: true,
    findings: [{
      code: 'title-conflict', severity: 'warning', message: 'Review title',
      workIds: [], editionIds: [], books: [],
    }],
    limits,
  }), /known catalog finding code/);
});

test('admin catalog scan decoder rejects extra personal and nested fields', () => {
  const response = {
    authors: [author], works: [work], editions: [edition], books: [{...book, currentPage: 50}],
    nextBookCursor: 'users/user/books/book', bookCountsComplete: false, findings: [],
    limits,
  };
  assert.throws(() => decodeAdminCatalogScanResponse(response), /expected only/);
  assert.throws(() => decodeAdminCatalogScanResponse({
    ...response, books: [book], editions: [{...edition, externalIds: {openlibrary: 3}}],
  }), /expected a string/);
});

test('admin catalog candidates prioritize exact identity evidence and prefill exact editions', () => {
  const unmatched = {...book, workId: null, editionId: null};
  const scan = decodeAdminCatalogScanResponse({
    authors: [author], works: [work], editions: [edition], books: [unmatched], nextBookCursor: null,
    bookCountsComplete: true,
    findings: [
      {code: 'likely-title-author-candidate', severity: 'warning', message: 'Likely', workIds: ['work'], editionIds: [], books: [{uid: 'user', bookId: 'book'}]},
      {code: 'unmatched-isbn-candidate', severity: 'warning', message: 'Exact', workIds: ['work'], editionIds: ['edition'], books: [{uid: 'user', bookId: 'book'}]},
    ],
    limits,
  });
  assert.deepEqual(adminCatalogCandidatesForBook(scan, unmatched), [{
    workId: 'work', editionId: 'edition', label: 'Exact ISBN', title: 'Book',
  }]);
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
