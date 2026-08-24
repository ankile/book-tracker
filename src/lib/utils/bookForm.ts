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

export type PreparedBookWrite =
  | { kind: 'add'; input: BookWriteInput }
  | { kind: 'update'; input: BookWriteInput & { bookId: string } };

export type PreparedBookWriteResult =
  | { valid: true; write: PreparedBookWrite }
  | { valid: false; message: string };

export interface BookWriter {
  addBook(input: BookWriteInput): Promise<void>;
  updateBook(input: BookWriteInput & { bookId: string }): Promise<void>;
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
  const pages = validateBookPages({
    pageCount,
    currentPage: book?.currentPage ?? currentPage,
  });
  if (!pages.valid) return pages;

  const input: BookWriteInput = {
    userId,
    authorChips,
    title: titleResult.title,
    pageCount: pages.pageCount,
    currentPage: book?.currentPage ?? pages.currentPage,
    isbn,
    metadata,
  };
  return book === null
    ? { valid: true, write: { kind: 'add', input } }
    : { valid: true, write: { kind: 'update', input: { ...input, bookId: book.id } } };
}

export function executeBookWrite(writer: BookWriter, write: PreparedBookWrite): Promise<void> {
  return write.kind === 'add'
    ? writer.addBook(write.input)
    : writer.updateBook(write.input);
}
