import type { AuthorChip } from '../interfaces/author.ts';
import type { Book } from '../interfaces/book.ts';
import type { CatalogSelection } from '../interfaces/catalog.ts';
import type { BookMetadata } from '../interfaces/metadata.ts';
import { normalizeIsbn } from './isbn.ts';
import { validateBookPages, validateBookTitle } from './validation.ts';

interface BookWriteBase {
  userId: string;
  authorChips: AuthorChip[];
  title: string;
  pageCount: number;
  currentPage: number;
  isbn: string;
  metadata: BookMetadata;
}

export type CatalogLinkWrite = CatalogSelection | null;

interface AddBookWriteInput extends BookWriteBase {
  catalogLink: CatalogLinkWrite;
}

interface UpdateBookWriteInput extends BookWriteBase {
  bookId: string;
  pageCountClampFrom: number | null;
  catalogLink?: CatalogLinkWrite;
}

export type PreparedBookWrite =
  | { kind: 'add'; input: AddBookWriteInput }
  | { kind: 'update'; input: UpdateBookWriteInput };

export type PreparedBookWriteResult =
  | { valid: true; write: PreparedBookWrite }
  | { valid: false; message: string };

export interface BookWriter {
  addBook(input: AddBookWriteInput): Promise<void>;
  updateBook(input: UpdateBookWriteInput): Promise<void>;
}

export type BookDeletionPolicy =
  | { allowed: true; confirmationWarning: string | null }
  | { allowed: false; guidance: string };

export function fillMissingText(currentText: string, lookupText: string): string {
  return currentText.trim() === '' ? lookupText : currentText;
}

export function fillMissingItems<T>(currentItems: T[], lookupItems: T[]): T[] {
  return currentItems.length === 0 ? lookupItems : currentItems;
}

export function fillMissingPageCount(
  currentPageCount: number | null | undefined,
  lookupPageCounts: readonly (number | undefined)[],
): number | null | undefined {
  if (currentPageCount !== null && currentPageCount !== undefined) return currentPageCount;
  return lookupPageCounts.find((pageCount) => pageCount !== undefined) ?? currentPageCount;
}

export function bookDeletionPolicy(activeTimer: Book['activeTimer']): BookDeletionPolicy {
  if (activeTimer === null) {
    return { allowed: true, confirmationWarning: null };
  }
  if (!('state' in activeTimer)) {
    if (activeTimer.entryId === undefined) {
      return {
        allowed: true,
        confirmationWarning:
          'This book has a local timer running. Its elapsed time has not been saved and will be lost.',
      };
    }
    return {
      allowed: false,
      guidance:
        'Stop this book\'s Toggl timer before deleting it, so the remote timer is not left running.',
    };
  }
  if (activeTimer.state === 'starting') {
    return {
      allowed: false,
      guidance:
        'Wait for the Toggl timer start to finish. If it stalls, resolve the start before deleting this book.',
    };
  }
  if (activeTimer.state === 'stopping') {
    return {
      allowed: false,
      guidance:
        'This Toggl stop is queued. Reconnect and wait for it to finish before deleting the book.',
    };
  }
  return {
    allowed: false,
    guidance:
      'Check Toggl, stop or delete any timer created there, then clear the unresolved timer before deleting this book.',
  };
}

// Mirrors the rules cap on `isbn` (validBookShape); the modal closes
// optimistically, so a rules denial here would discard the whole edit
// behind a generic banner instead of a field message.
const MAX_ISBN_LENGTH = 32;

export function prepareBookWrite({
  userId,
  book,
  authorChips,
  title,
  pageCount,
  currentPage,
  isbn,
  metadata,
  catalogSelection,
  catalogSelectionTouched = false,
  catalogSelectionIsbn13 = null,
}: {
  userId: string;
  book: Book | null;
  authorChips: AuthorChip[];
  title: string;
  pageCount: number | null | undefined;
  currentPage: number | null | undefined;
  isbn: string;
  metadata: BookMetadata;
  catalogSelection?: CatalogSelection | null;
  catalogSelectionTouched?: boolean;
  catalogSelectionIsbn13?: string | null;
}): PreparedBookWriteResult {
  if (authorChips.some((chip) => chip.id !== null && 'unresolved' in chip)) {
    return {
      valid: false,
      message: 'Remove each unresolved author and select or create a replacement before saving.',
    };
  }

  const titleResult = validateBookTitle(title);
  if (!titleResult.valid) return titleResult;
  const trimmedIsbn = isbn.trim();
  if (trimmedIsbn.length > MAX_ISBN_LENGTH) {
    return {
      valid: false,
      message: `ISBN must be at most ${MAX_ISBN_LENGTH} characters — enter just the number.`,
    };
  }
  const pageCountResult = book === null
    ? null
    : validateBookPages({ pageCount, currentPage: 0 });
  if (pageCountResult !== null && !pageCountResult.valid) return pageCountResult;
  const storedPageResult = book === null
    ? null
    : validateBookPages({
      pageCount: Number.MAX_SAFE_INTEGER,
      currentPage: book.currentPage,
    });
  if (storedPageResult !== null && !storedPageResult.valid) return storedPageResult;
  const editCurrentPage = book === null || pageCountResult === null
    ? currentPage
    : Math.min(book.currentPage, pageCountResult.pageCount);
  const pages = validateBookPages({ pageCount, currentPage: editCurrentPage });
  if (!pages.valid) return pages;

  const normalizedIsbn = normalizeIsbn(trimmedIsbn);
  const input: BookWriteBase = {
    userId,
    authorChips,
    title: titleResult.title,
    pageCount: pages.pageCount,
    currentPage: pages.currentPage,
    isbn: normalizedIsbn ?? trimmedIsbn,
    metadata,
  };
  const isbnDerivedLinkChanged = book !== null && book.matchMethod === 'isbn' &&
    normalizeIsbn(book.isbn) !== normalizedIsbn && !catalogSelectionTouched &&
    catalogSelectionIsbn13 !== normalizedIsbn;
  const effectiveCatalogSelection = isbnDerivedLinkChanged ? null : catalogSelection;
  const sameCatalogLink = book !== null && effectiveCatalogSelection !== undefined &&
    book.workId === effectiveCatalogSelection?.workId &&
    book.editionId === (effectiveCatalogSelection?.editionId ?? null) &&
    (!catalogSelectionTouched || book.matchMethod === effectiveCatalogSelection?.matchMethod);
  return book === null
    ? {
      valid: true,
      write: {kind: 'add', input: {...input, catalogLink: catalogSelection ?? null}},
    }
    : {
      valid: true,
      write: {
        kind: 'update',
        input: {
          ...input,
          bookId: book.id,
          pageCountClampFrom: pages.currentPage < book.currentPage
            ? book.currentPage
            : null,
          ...(effectiveCatalogSelection === undefined || sameCatalogLink
            ? {}
            : {catalogLink: effectiveCatalogSelection}),
        },
      },
    };
}

export function executeBookWrite(writer: BookWriter, write: PreparedBookWrite): Promise<void> {
  return write.kind === 'add'
    ? writer.addBook(write.input)
    : writer.updateBook(write.input);
}
