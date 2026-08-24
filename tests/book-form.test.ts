import assert from 'node:assert/strict';
import test from 'node:test';
import { executeBookWrite, prepareBookWrite, type BookWriter } from '../src/lib/utils/bookForm.ts';
import type { AuthorChip } from '../src/lib/interfaces/author.ts';
import type { Book } from '../src/lib/interfaces/book.ts';
import { EMPTY_METADATA } from '../src/lib/utils/bookMetadata.ts';

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
    isbn: '',
    metadata: EMPTY_METADATA,
  } }]);
});

test('a concurrently repaired author with the same id is no longer blocked', () => {
  const result = prepare([{ id: 'missing', name: 'Restored Author' }]);
  assert.equal(result.valid, true);
});
