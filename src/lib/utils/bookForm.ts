import type { AuthorChip } from '../interfaces/author.ts';
import type { Book } from '../interfaces/book.ts';
import type { BookMetadata } from '../interfaces/metadata.ts';
import { validateBookPages, validateBookTitle } from './validation.ts';

interface BookWriteInput {
  userId: string;
  authorChips: AuthorChip[];
  title: string;
  pageCount: number;
  currentPage: number;
  isbn: string;
  metadata: BookMetadata;
}

interface UpdateBookWriteInput extends BookWriteInput {
  bookId: string;
  pageCountClampFrom: number | null;
}

export type PreparedBookWrite =
  | { kind: 'add'; input: BookWriteInput }
  | { kind: 'update'; input: UpdateBookWriteInput };

export type PreparedBookWriteResult =
  | { valid: true; write: PreparedBookWrite }
  | { valid: false; message: string };

export interface BookWriter {
  addBook(input: BookWriteInput): Promise<void>;
  updateBook(input: UpdateBookWriteInput): Promise<void>;
}

export type BookDeletionPolicy =
  | { allowed: true; confirmationWarning: string | null }
  | { allowed: false; guidance: string };

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

export function prepareBookWrite({
  userId,
  book,
  authorChips,
  title,
  pageCount,
  currentPage,
  isbn,
  metadata,
}: {
  userId: string;
  book: Book | null;
  authorChips: AuthorChip[];
  title: string;
  pageCount: number | null | undefined;
  currentPage: number | null | undefined;
  isbn: string;
  metadata: BookMetadata;
}): PreparedBookWriteResult {
  if (authorChips.some((chip) => chip.id !== null && 'unresolved' in chip)) {
    return {
      valid: false,
      message: 'Remove each unresolved author and select or create a replacement before saving.',
    };
  }

  const titleResult = validateBookTitle(title);
  if (!titleResult.valid) return titleResult;
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

  const input: BookWriteInput = {
    userId,
    authorChips,
    title: titleResult.title,
    pageCount: pages.pageCount,
    currentPage: pages.currentPage,
    isbn,
    metadata,
  };
  return book === null
    ? { valid: true, write: { kind: 'add', input } }
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
        },
      },
    };
}

export function executeBookWrite(writer: BookWriter, write: PreparedBookWrite): Promise<void> {
  return write.kind === 'add'
    ? writer.addBook(write.input)
    : writer.updateBook(write.input);
}
