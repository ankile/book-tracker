import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp } from 'firebase/firestore';
import {
  bookDeletionPolicy,
  executeBookWrite,
  fillMissingItems,
  fillMissingPageCount,
  fillMissingText,
  MAX_BOOK_AUTHORS,
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
  finished: false,
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

test('book form caps the ISBN at the rules limit and trims it', () => {
  const chips: AuthorChip[] = [];
  const long = prepareBookWrite({
    userId: 'user', book: null, authorChips: chips, title: 'Book', pageCount: 100, currentPage: 0,
    isbn: 'ISBN 978-0-316-76948-8 (hardcover)', metadata: EMPTY_METADATA,
  });
  assert.equal(long.valid, false);
  assert.match(long.valid ? '' : long.message, /at most 32 characters/);
  const ok = prepareBookWrite({
    userId: 'user', book: null, authorChips: chips, title: 'Book', pageCount: 100, currentPage: 0,
    isbn: '  978-0-316-76948-8  ', metadata: EMPTY_METADATA,
  });
  assert.equal(ok.valid, true);
  assert.equal(ok.valid ? ok.write.input.isbn : '', '9780316769488');
});

test('book form normalizes valid ISBNs even without a lookup', () => {
  const result = prepareBookWrite({
    userId: 'user', book: null, authorChips: [], title: 'Book', pageCount: 100, currentPage: 0,
    isbn: '0-316-55634-3', metadata: EMPTY_METADATA,
  });
  assert.ok(result.valid);
  assert.equal(result.write.input.isbn, '9780316556347');
});

test('catalog writes are explicit on add and patch-only on edit', () => {
  const selection = {workId: 'work', editionId: 'edition', matchMethod: 'isbn'} as const;
  const added = prepareBookWrite({
    userId: 'user', book: null, authorChips: [], title: 'Book', pageCount: 100, currentPage: 0,
    isbn: '', metadata: EMPTY_METADATA, catalogSelection: selection,
  });
  assert.ok(added.valid && added.write.kind === 'add');
  assert.deepEqual(added.write.input.catalogLink, selection);

  const unchanged = prepareBookWrite({
    userId: 'user', book: {...baseBook, workId: 'work', editionId: 'edition'} as Book,
    authorChips: [], title: 'Book', pageCount: 100, currentPage: 5,
    isbn: '', metadata: EMPTY_METADATA, catalogSelection: selection,
  });
  assert.ok(unchanged.valid && unchanged.write.kind === 'update');
  assert.equal('catalogLink' in unchanged.write.input, false);

  const repairedAdminLink = prepareBookWrite({
    userId: 'user',
    book: {...baseBook, workId: 'work', editionId: 'edition', matchMethod: 'admin'} as Book,
    authorChips: [], title: 'Book', pageCount: 100, currentPage: 5,
    isbn: '', metadata: EMPTY_METADATA, catalogSelection: selection,
    catalogSelectionTouched: true,
  });
  assert.ok(repairedAdminLink.valid && repairedAdminLink.write.kind === 'update');
  assert.deepEqual(repairedAdminLink.write.input.catalogLink, selection);

  const untouchedAdminLink = prepareBookWrite({
    userId: 'user',
    book: {...baseBook, workId: 'work', editionId: 'edition', matchMethod: 'admin'} as Book,
    authorChips: [], title: 'Book', pageCount: 100, currentPage: 5,
    isbn: '', metadata: EMPTY_METADATA, catalogSelection: selection,
  });
  assert.ok(untouchedAdminLink.valid && untouchedAdminLink.write.kind === 'update');
  assert.equal('catalogLink' in untouchedAdminLink.write.input, false);

  const unlinked = prepareBookWrite({
    userId: 'user', book: {...baseBook, workId: 'work', editionId: 'edition'} as Book,
    authorChips: [], title: 'Book', pageCount: 100, currentPage: 5,
    isbn: '', metadata: EMPTY_METADATA, catalogSelection: null,
  });
  assert.ok(unlinked.valid && unlinked.write.kind === 'update');
  assert.equal(unlinked.write.input.catalogLink, null);
});

test('editing ISBN-derived links clears stale provenance or keeps an exact reselection', () => {
  const originalIsbn = '9780441478125';
  const replacementIsbn = '9780316769488';
  const linked = {
    ...baseBook,
    isbn: originalIsbn,
    workId: 'work',
    editionId: 'edition',
    matchMethod: 'isbn',
  finished: false,
  } as Book;
  const storedSelection = {
    workId: 'work', editionId: 'edition', matchMethod: 'catalog-choice',
  } as const;
  const changed = prepareBookWrite({
    userId: 'user', book: linked, authorChips: [], title: 'Book', pageCount: 100,
    currentPage: 5, isbn: replacementIsbn, metadata: EMPTY_METADATA,
    catalogSelection: storedSelection, catalogSelectionIsbn13: originalIsbn,
  });
  assert.ok(changed.valid && changed.write.kind === 'update');
  assert.equal(changed.write.input.catalogLink, null);

  const cleared = prepareBookWrite({
    userId: 'user', book: linked, authorChips: [], title: 'Book', pageCount: 100,
    currentPage: 5, isbn: '', metadata: EMPTY_METADATA,
    catalogSelection: storedSelection, catalogSelectionIsbn13: originalIsbn,
  });
  assert.ok(cleared.valid && cleared.write.kind === 'update');
  assert.equal(cleared.write.input.catalogLink, null);

  const exactReplacement = prepareBookWrite({
    userId: 'user', book: linked, authorChips: [], title: 'Book', pageCount: 100,
    currentPage: 5, isbn: replacementIsbn, metadata: EMPTY_METADATA,
    catalogSelection: {workId: 'new-work', editionId: 'new-edition', matchMethod: 'isbn'},
    catalogSelectionIsbn13: replacementIsbn,
  });
  assert.ok(exactReplacement.valid && exactReplacement.write.kind === 'update');
  assert.deepEqual(exactReplacement.write.input.catalogLink, {
    workId: 'new-work', editionId: 'new-edition', matchMethod: 'isbn',
  });
});

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

test('book form rejects more shared authors than Rules can verify', () => {
  const result = prepare(Array.from(
    {length: MAX_BOOK_AUTHORS + 1},
    (_, index) => ({id: `author-${index}`, name: `Author ${index}`}),
  ));

  assert.deepEqual(result, {
    valid: false,
    message: `A personal book may reference at most ${MAX_BOOK_AUTHORS} authors.`,
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
    previouslyFinished: false,
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

test('ISBN lookup fills missing book fields without overwriting existing ones', () => {
  assert.equal(fillMissingText('Entered title', 'Lookup title'), 'Entered title');
  assert.equal(fillMissingText('   ', 'Lookup title'), 'Lookup title');
  assert.deepEqual(fillMissingItems(['Entered author'], ['Lookup author']), ['Entered author']);
  assert.deepEqual(fillMissingItems([], ['Lookup author']), ['Lookup author']);
  assert.equal(fillMissingPageCount(320, [393, 400]), 320);
  assert.equal(fillMissingPageCount(undefined, [undefined, 393, 400]), 393);
  assert.equal(fillMissingPageCount(null, [undefined, undefined]), null);
});

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
  assert.equal(result.write.input.previouslyFinished, false);
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
  // The stamp is written only when this edit is what finishes the book.
  assert.equal(result.write.input.previouslyFinished, true);
});

test('a title-only edit repairs legacy progress already beyond the unchanged page count', () => {
  const book = {
    ...baseBook,
    authorIds: ['author'],
    title: 'Old title',
    currentPage: 350,
    currentPageUpdateId: 'prior-reading',
    pageCount: 320,
    finished: false,
  } as Book;
  const result = prepareBookWrite({
    userId: 'user',
    book,
    authorChips: [{id: 'author', name: 'Author'}],
    title: 'New title',
    pageCount: 320,
    currentPage: 350,
    isbn: book.isbn,
    metadata: EMPTY_METADATA,
  });

  assert.ok(result.valid);
  assert.equal(result.write.kind, 'update');
  assert.equal(result.write.input.pageCount, 320);
  assert.equal(result.write.input.currentPage, 320);
  assert.equal(result.write.input.pageCountClampFrom, 350);
  assert.equal(result.write.input.previouslyFinished, false);
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
