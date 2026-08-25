import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp } from 'firebase/firestore';
import {
  bookDeletionPolicy,
  executeBookWrite,
  prepareBookWrite,
  type BookWriter,
} from '../src/lib/utils/bookForm.ts';
import type { Author, AuthorChip } from '../src/lib/interfaces/author.ts';
import type { Book } from '../src/lib/interfaces/book.ts';
import { EMPTY_METADATA } from '../src/lib/utils/bookMetadata.ts';
import { editableBookAuthorChips } from '../src/lib/utils/authors.ts';

const baseBook = {
  id: 'book',
  title: 'Book',
  authorIds: ['missing'],
  currentPage: 5,
  pageCount: 100,
  isbn: '',
} as Book;

function prepare(authorChips: AuthorChip[]) {
  return prepareBookWrite({
    userId: 'user',
    book: baseBook,
    authorChips,
    title: ' Book ',
    pageCount: 100,
    currentPage: 5,
    isbn: '',
    metadata: EMPTY_METADATA,
  });
}

test('book form blocks writes while an unresolved repair chip remains', () => {
  const result = prepare([{
    id: 'missing',
    name: '[Unresolved author] missing',
    unresolved: true,
  }]);

  assert.deepEqual(result, {
    valid: false,
    message: 'Remove each unresolved author and select or create a replacement before saving.',
  });
});

test('edit seeding exposes missing, broken, and cyclic ids as write-blocking repair chips', () => {
  const broken: Author = {
    id: 'broken', name: 'Broken Author', nameLower: 'broken author', kind: 'person', familyName: 'Author',
    retirement: { reason: 'merged', targetId: 'missing-target' },
  };
  const first: Author = {
    id: 'first', name: 'First Author', nameLower: 'first author', kind: 'person', familyName: 'Author',
    retirement: { reason: 'merged', targetId: 'second' },
  };
  const second: Author = {
    id: 'second', name: 'Second Author', nameLower: 'second author', kind: 'person', familyName: 'Author',
    retirement: { reason: 'merged', targetId: 'first' },
  };
  const seeded = editableBookAuthorChips(
    { authorIds: ['missing', 'broken', 'first'] },
    [broken, first, second],
  );

  assert.deepEqual(seeded.chips, [
    { id: 'missing', name: '[Unresolved author] missing', unresolved: true },
    { id: 'broken', name: '[Unresolved author] Broken Author', unresolved: true },
    { id: 'first', name: '[Unresolved author] First Author', unresolved: true },
  ]);
  assert.equal(prepare(seeded.chips).valid, false);
});

test('removing an unresolved chip and selecting a replacement enables the update', async () => {
  const result = prepare([{ id: 'replacement', name: 'Replacement Author' }]);
  assert.ok(result.valid);

  const calls: unknown[] = [];
  const writer: BookWriter = {
    addBook: async (input) => { calls.push({ kind: 'add', input }); },
    updateBook: async (input) => { calls.push({ kind: 'update', input }); },
  };
  await executeBookWrite(writer, result.write);

  assert.equal(result.write.kind, 'update');
  assert.deepEqual(calls, [{ kind: 'update', input: {
    userId: 'user',
    bookId: 'book',
    authorChips: [{ id: 'replacement', name: 'Replacement Author' }],
    title: 'Book',
    pageCount: 100,
    currentPage: 5,
    pageCountClampFrom: null,
    isbn: '',
    metadata: EMPTY_METADATA,
} }]);
});

function preparePageCountEdit(book: Book, pageCount: number | null | undefined) {
  return prepareBookWrite({
    userId: 'user',
    book,
    authorChips: [{ id: 'author', name: 'Author' }],
    title: book.title,
    pageCount,
    currentPage: book.currentPage,
    isbn: book.isbn,
    metadata: EMPTY_METADATA,
  });
}

test('shrinking below an inflated current page prepares an atomic page correction', () => {
  const book = {
    ...baseBook,
    authorIds: ['author'],
    currentPage: 350,
    currentPageUpdateId: 'prior-reading',
    pageCount: 400,
    finished: false,
  } as Book;
  const result = preparePageCountEdit(book, 320);
  assert.ok(result.valid);
  assert.equal(result.write.kind, 'update');
  assert.equal(result.write.input.pageCount, 320);
  assert.equal(result.write.input.currentPage, 320);
  assert.equal(result.write.input.pageCountClampFrom, 350);
});

test('shrinking a finished book prepares the same explicit correction', () => {
  const book = {
    ...baseBook,
    authorIds: ['author'],
    currentPage: 350,
    currentPageUpdateId: 'prior-reading',
    pageCount: 350,
    finished: true,
  } as Book;
  const result = preparePageCountEdit(book, 320);
  assert.ok(result.valid);
  assert.equal(result.write.kind, 'update');
  assert.equal(result.write.input.currentPage, 320);
  assert.equal(result.write.input.pageCountClampFrom, 350);
});

test('unchanged, growing, and non-clamping page counts preserve progress', () => {
  for (const pageCount of [100, 200, 50]) {
    const result = preparePageCountEdit({
      ...baseBook,
      authorIds: ['author'],
      currentPageUpdateId: 'prior-reading',
    } as Book, pageCount);
    assert.ok(result.valid);
    assert.equal(result.write.kind, 'update');
    assert.equal(result.write.input.currentPage, 5);
    assert.equal(result.write.input.pageCountClampFrom, null);
  }
});

test('page-count edits still reject missing, non-positive, and fractional counts', () => {
  for (const pageCount of [null, undefined, 0, -1, 100.5]) {
    assert.equal(preparePageCountEdit(baseBook, pageCount).valid, false);
  }
  assert.equal(preparePageCountEdit({
    ...baseBook,
    currentPage: 5.5,
  } as Book, 5).valid, false);
});

test('a concurrently repaired author with the same id is no longer blocked', () => {
  const result = prepare([{ id: 'missing', name: 'Restored Author' }]);
  assert.equal(result.valid, true);
});

test('book deletion distinguishes local timer loss from remote timer risk', () => {
  assert.deepEqual(bookDeletionPolicy(null), {
    allowed: true,
    confirmationWarning: null,
  });
  assert.deepEqual(bookDeletionPolicy({
    start: '2026-08-24T12:00:00.000Z',
  }), {
    allowed: true,
    confirmationWarning:
      'This book has a local timer running. Its elapsed time has not been saved and will be lost.',
  });
  assert.deepEqual(bookDeletionPolicy({
    entryId: 42,
    start: '2026-08-24T12:00:00.000Z',
  }), {
    allowed: false,
    guidance:
      'Stop this book\'s Toggl timer before deleting it, so the remote timer is not left running.',
  });
  assert.deepEqual(bookDeletionPolicy({
    state: 'starting',
    operationId: 'operation',
    start: '2026-08-24T12:00:00.000Z',
    claimedAt: Timestamp.fromMillis(1),
  }), {
    allowed: false,
    guidance:
      'Wait for the Toggl timer start to finish. If it stalls, resolve the start before deleting this book.',
  });
  assert.deepEqual(bookDeletionPolicy({
    state: 'outcome-unknown',
    operationId: 'operation',
    start: '2026-08-24T12:00:00.000Z',
    claimedAt: Timestamp.fromMillis(1),
    error: 'Check Toggl.',
  }), {
    allowed: false,
    guidance:
      'Check Toggl, stop or delete any timer created there, then clear the unresolved timer before deleting this book.',
  });
});
