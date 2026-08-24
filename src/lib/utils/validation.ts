export type NumericInput = number | string | null | undefined;

export type ValidationResult<T> =
  | ({ valid: true } & T)
  | { valid: false; message: string };

export interface ReadingValidationInput {
  inputTime: NumericInput;
  inputPages: NumericInput;
  previousPage: number;
  pageCount: number;
}

export interface NormalizedReading {
  time: number;
  pages: number;
}

export function validateReading({
  inputTime,
  inputPages,
  previousPage,
  pageCount,
}: ReadingValidationInput): ValidationResult<NormalizedReading> {
  const time = normalizeInteger(inputTime);
  const pages = normalizeInteger(inputPages);

  if (time === null) {
    return { valid: false, message: 'Number of minutes spent reading must be an integer.' };
  }
  if (pages === null) {
    return { valid: false, message: 'Current page must be an integer.' };
  }
  if (time <= 0) {
    return { valid: false, message: 'Time read must be greater than 0.' };
  }
  if (pages < previousPage) {
    return {
      valid: false,
      message:
        "You can't read backwards. If you have to adjust the current page press the current page on the book card.",
    };
  }
  if (pages > pageCount) {
    return {
      valid: false,
      message: "You can't read more pages than there are in the book.",
    };
  }
  return { valid: true, time, pages };
}

export interface CurrentPageValidationInput {
  inputPages: NumericInput;
  pageCount: number;
}

export function validateCurrentPage({
  inputPages,
  pageCount,
}: CurrentPageValidationInput): ValidationResult<{ page: number }> {
  const page = normalizeInteger(inputPages);
  if (page === null) {
    return { valid: false, message: 'Page number must be an integer.' };
  }
  if (page < 0 || page > pageCount) {
    return {
      valid: false,
      message: 'Page number must be between 0 and the total number of pages in the book.',
    };
  }
  return { valid: true, page };
}

export function validateBookPages({
  pageCount,
  currentPage,
}: {
  pageCount: NumericInput;
  currentPage: NumericInput;
}): ValidationResult<{ pageCount: number; currentPage: number }> {
  const count = normalizeInteger(pageCount);
  if (count === null || count <= 0) {
    return { valid: false, message: 'Page count must be a positive integer.' };
  }
  const page = validateCurrentPage({ inputPages: currentPage, pageCount: count });
  return page.valid
    ? { valid: true, pageCount: count, currentPage: page.page }
    : page;
}

export function validateBookTitle(value: string): ValidationResult<{ title: string }> {
  const title = value.trim().replace(/\s+/g, ' ');
  if (title.length === 0) return { valid: false, message: 'Book title is required.' };
  if (title.length > 500) {
    return { valid: false, message: 'Book title must be at most 500 characters.' };
  }
  return { valid: true, title };
}

export function normalizeInteger(value: NumericInput): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
