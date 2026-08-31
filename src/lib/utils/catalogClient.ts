import type { Book } from '../interfaces/book.ts';
import type { BookMetadata } from '../interfaces/metadata.ts';
import type {
  CatalogAuthorSummary,
  CatalogCreateRequest,
  CatalogCreateResponse,
  CatalogEditionSummary,
  CatalogSearchRequest,
  CatalogSearchResponse,
  CatalogSearchResult,
  CatalogSelection,
  CatalogWorkSummary,
  WorkReaderAttemptSummary,
  WorkReadersResponse,
} from '../interfaces/catalog.ts';
import { normalizeCatalogAuthorNames, normalizeCatalogTitle } from './catalog.ts';
import {
  boolean,
  editionFormat,
  exactKeys,
  finiteNumber,
  integer,
  nonEmptyString,
  nullableNumber,
  nullableString,
  record,
  string,
  strings,
} from './decodePrimitives.ts';
import { normalizeIsbn } from './isbn.ts';

function calendarDate(value: unknown, context: string): string | null {
  if (value === null) return null;
  const decoded = nonEmptyString(value, context);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(decoded) ||
      new Date(`${decoded}T00:00:00.000Z`).toISOString().slice(0, 10) !== decoded) {
    throw new TypeError(`${context}: expected a valid YYYY-MM-DD calendar date`);
  }
  return decoded;
}

function decodeAuthorSummary(value: unknown, context: string): CatalogAuthorSummary {
  const data = record(value, context);
  exactKeys(data, ['authorId', 'canonicalName', 'sortName', 'kind'], context);
  if (data.kind !== 'person' && data.kind !== 'entity' && data.kind !== 'placeholder') {
    throw new TypeError(`${context}.kind: expected a supported catalog author kind`);
  }
  return {
    authorId: nonEmptyString(data.authorId, `${context}.authorId`),
    canonicalName: nonEmptyString(data.canonicalName, `${context}.canonicalName`),
    sortName: nonEmptyString(data.sortName, `${context}.sortName`),
    kind: data.kind,
  };
}

function decodeWorkSummary(value: unknown, context: string): CatalogWorkSummary {
  const data = record(value, context);
  exactKeys(
    data,
    ['workId', 'canonicalTitle', 'alternateTitles', 'authors', 'coverUrl', 'subjects', 'fiction', 'mergedFrom'],
    context,
  );
  return {
    workId: nonEmptyString(data.workId, `${context}.workId`),
    canonicalTitle: nonEmptyString(data.canonicalTitle, `${context}.canonicalTitle`),
    alternateTitles: strings(data.alternateTitles, `${context}.alternateTitles`),
    authors: Array.isArray(data.authors)
      ? data.authors.map((author, index) => decodeAuthorSummary(author, `${context}.authors[${index}]`))
      : (() => { throw new TypeError(`${context}.authors: expected an array`); })(),
    coverUrl: string(data.coverUrl, `${context}.coverUrl`),
    subjects: strings(data.subjects, `${context}.subjects`),
    fiction: data.fiction === null ? null : boolean(data.fiction, `${context}.fiction`),
    mergedFrom: strings(data.mergedFrom, `${context}.mergedFrom`),
  };
}

function decodeEditionSummary(value: unknown, context: string): CatalogEditionSummary {
  const data = record(value, context);
  exactKeys(data, [
    'editionId', 'workId', 'isbn13', 'title', 'publisher',
    'publishedDate', 'language', 'translatorNames', 'format', 'suggestedPageCount', 'coverUrl',
  ], context);
  const suggestedPageCount = nullableNumber(data.suggestedPageCount, `${context}.suggestedPageCount`);
  if (suggestedPageCount !== null && (!Number.isSafeInteger(suggestedPageCount) || suggestedPageCount <= 0)) {
    throw new TypeError(`${context}.suggestedPageCount: expected a positive safe integer or null`);
  }
  return {
    editionId: nonEmptyString(data.editionId, `${context}.editionId`),
    workId: nonEmptyString(data.workId, `${context}.workId`),
    isbn13: nullableString(data.isbn13, `${context}.isbn13`),
    title: nonEmptyString(data.title, `${context}.title`),
    publisher: string(data.publisher, `${context}.publisher`),
    publishedDate: string(data.publishedDate, `${context}.publishedDate`),
    language: string(data.language, `${context}.language`),
    translatorNames: strings(data.translatorNames, `${context}.translatorNames`),
    format: editionFormat(data.format, `${context}.format`),
    suggestedPageCount,
    coverUrl: string(data.coverUrl, `${context}.coverUrl`),
  };
}

export function decodeCatalogSearchResponse(value: unknown): CatalogSearchResponse {
  const data = record(value, 'catalog-search response');
  exactKeys(data, ['results'], 'catalog-search response');
  if (!Array.isArray(data.results)) throw new TypeError('catalog-search response.results: expected an array');
  return {results: data.results.map((entry, index): CatalogSearchResult => {
    const context = `catalog-search response.results[${index}]`;
    const result = record(entry, context);
    exactKeys(result, ['workId', 'editionId', 'confidence', 'reason', 'work', 'edition'], context);
    if (
      result.confidence !== 'exact-edition' &&
      result.confidence !== 'strong-work' &&
      result.confidence !== 'possible-work'
    ) {
      throw new TypeError(`${context}.confidence: expected a supported confidence`);
    }
    const work = decodeWorkSummary(result.work, `${context}.work`);
    const edition = result.edition === null
      ? null
      : decodeEditionSummary(result.edition, `${context}.edition`);
    const workId = nonEmptyString(result.workId, `${context}.workId`);
    const editionId = nullableString(result.editionId, `${context}.editionId`);
    if (work.workId !== workId || edition?.editionId !== editionId || (edition && edition.workId !== workId)) {
      throw new TypeError(`${context}: summary ids do not agree`);
    }
    return {
      workId,
      editionId,
      confidence: result.confidence,
      reason: nonEmptyString(result.reason, `${context}.reason`),
      work,
      edition,
    };
  })};
}

export function decodeCatalogCreateResponse(value: unknown): CatalogCreateResponse {
  const data = record(value, 'catalog-create response');
  exactKeys(data, ['workId', 'editionId', 'created'], 'catalog-create response');
  return {
    workId: nonEmptyString(data.workId, 'catalog-create response.workId'),
    editionId: nonEmptyString(data.editionId, 'catalog-create response.editionId'),
    created: boolean(data.created, 'catalog-create response.created'),
  };
}

// The work and edition a book with no catalog match creates: the personal
// book's own bibliographic fields, nothing inferred. Books without a
// resolved author cannot seed a work (a work needs at least one author).
export function buildCatalogCreateRequest({title, authorIds, isbn, pageCount, metadata}: {
  title: string;
  authorIds: readonly string[];
  isbn: string;
  pageCount: number;
  metadata: BookMetadata;
}): CatalogCreateRequest | null {
  if (authorIds.length === 0) return null;
  const coverUrl = metadata.coverUrl.startsWith('https://') ? metadata.coverUrl : '';
  return {
    work: {
      canonicalTitle: title,
      alternateTitles: [],
      authorIds: [...authorIds],
      coverUrl,
      subjects: metadata.subjects,
      fiction: metadata.fiction,
    },
    edition: {
      isbn13: normalizeIsbn(isbn) ?? null,
      title,
      publisher: metadata.publisher,
      publishedDate: metadata.publishedDate,
      language: '',
      translatorNames: [],
      format: 'unknown',
      suggestedPageCount: pageCount,
      coverUrl,
      externalIds: {},
    },
  };
}

function decodeAttempt(value: unknown, context: string): WorkReaderAttemptSummary {
  const data = record(value, context);
  exactKeys(data, [
    'username', 'displayName', 'status', 'pageCount', 'editionIsbn13',
    'firstProgressAt', 'firstReadAt', 'finishedAt', 'calendarDays', 'activeDays',
    'trackedMinutes', 'sessionCount', 'qualifiedPagesPerHour', 'percentPerHour',
    'trackingCoverage',
  ], context);
  if (data.status !== 'reading' && data.status !== 'finished') {
    throw new TypeError(`${context}.status: expected reading or finished`);
  }
  const pageCount = integer(data.pageCount, `${context}.pageCount`);
  const activeDays = integer(data.activeDays, `${context}.activeDays`);
  const trackedMinutes = finiteNumber(data.trackedMinutes, `${context}.trackedMinutes`);
  const sessionCount = integer(data.sessionCount, `${context}.sessionCount`);
  const calendarDays = nullableNumber(data.calendarDays, `${context}.calendarDays`);
  const qualifiedPagesPerHour = nullableNumber(
    data.qualifiedPagesPerHour,
    `${context}.qualifiedPagesPerHour`,
  );
  const percentPerHour = nullableNumber(data.percentPerHour, `${context}.percentPerHour`);
  const trackingCoverage = nullableNumber(data.trackingCoverage, `${context}.trackingCoverage`);
  if (pageCount <= 0 || activeDays < 0 || trackedMinutes < 0 || sessionCount < 0) {
    throw new TypeError(`${context}: counts must be non-negative and pageCount positive`);
  }
  if ([calendarDays, qualifiedPagesPerHour, percentPerHour, trackingCoverage]
    .some((metric) => metric !== null && metric < 0)) {
    throw new TypeError(`${context}: optional metrics must be null or non-negative`);
  }
  return {
    username: nonEmptyString(data.username, `${context}.username`),
    displayName: nonEmptyString(data.displayName, `${context}.displayName`),
    status: data.status,
    pageCount,
    editionIsbn13: nullableString(data.editionIsbn13, `${context}.editionIsbn13`),
    firstProgressAt: calendarDate(data.firstProgressAt, `${context}.firstProgressAt`),
    firstReadAt: calendarDate(data.firstReadAt, `${context}.firstReadAt`),
    finishedAt: calendarDate(data.finishedAt, `${context}.finishedAt`),
    calendarDays,
    activeDays,
    trackedMinutes,
    sessionCount,
    qualifiedPagesPerHour,
    percentPerHour,
    trackingCoverage,
  };
}

export function decodeWorkReadersResponse(value: unknown): WorkReadersResponse {
  const data = record(value, 'work-readers response');
  exactKeys(
    data,
    ['work', 'editions', 'attempts', 'incomplete', 'omittedAttempts', 'nextCursor'],
    'work-readers response',
  );
  if (!Array.isArray(data.editions) || !Array.isArray(data.attempts)) {
    throw new TypeError('work-readers response: editions and attempts must be arrays');
  }
  const work = decodeWorkSummary(data.work, 'work-readers response.work');
  const editions = data.editions.map((edition, index) =>
    decodeEditionSummary(edition, `work-readers response.editions[${index}]`));
  if (editions.some((edition) => edition.workId !== work.workId)) {
    throw new TypeError('work-readers response: edition belongs to another work');
  }
  const omittedAttempts = integer(data.omittedAttempts, 'work-readers response.omittedAttempts');
  if (omittedAttempts < 0) {
    throw new TypeError('work-readers response.omittedAttempts: expected a non-negative safe integer');
  }
  return {
    work,
    editions,
    attempts: data.attempts.map((attempt, index) =>
      decodeAttempt(attempt, `work-readers response.attempts[${index}]`)),
    incomplete: boolean(data.incomplete, 'work-readers response.incomplete'),
    omittedAttempts,
    nextCursor: nullableString(data.nextCursor, 'work-readers response.nextCursor'),
  };
}

export function buildCatalogSearchRequest({
  isbn,
  title,
  authorNames,
}: {
  isbn: string;
  title: string;
  authorNames: readonly string[];
}): CatalogSearchRequest | null {
  const isbn13 = normalizeIsbn(isbn);
  const trimmedTitle = title.trim();
  const normalizedAuthors = normalizeCatalogAuthorNames(authorNames);
  if (isbn13 !== null) {
    return {
      isbn13,
      ...(normalizeCatalogTitle(trimmedTitle).length >= 3 ? {title: trimmedTitle} : {}),
      ...(normalizedAuthors.length > 0 ? {authorNames: authorNames.map((name) => name.trim()).filter(Boolean)} : {}),
    };
  }
  if (normalizeCatalogTitle(trimmedTitle).length < 3 || normalizedAuthors.length === 0) return null;
  return {title: trimmedTitle, authorNames: authorNames.map((name) => name.trim()).filter(Boolean)};
}

export function selectionForResult(result: CatalogSearchResult): CatalogSelection {
  return {
    workId: result.workId,
    editionId: result.editionId,
    matchMethod: result.confidence === 'exact-edition' ? 'isbn' : 'catalog-choice',
  };
}

export function exactEditionPreselection(results: readonly CatalogSearchResult[]): CatalogSearchResult | null {
  const exact = results.filter((result) => result.confidence === 'exact-edition');
  return exact.length === 1 ? exact[0] : null;
}

export function automaticIsbnSelectionStillApplies(
  selectedIsbn13: string | null,
  request: CatalogSearchRequest,
): boolean {
  return selectedIsbn13 === null || request.isbn13 === selectedIsbn13;
}

export function linkedBooksForWork(
  books: readonly Book[],
  work: Pick<CatalogWorkSummary, 'workId' | 'mergedFrom'>,
  excludingBookId: string | null = null,
): Book[] {
  const ids = new Set([work.workId, ...work.mergedFrom]);
  return books.filter((book) => book.id !== excludingBookId && book.workId !== null && ids.has(book.workId));
}

export function catalogWorkHref(
  book: Pick<Book, 'workId' | 'matchMethod'>,
): string | null {
  if (book.workId === null ||
      (book.matchMethod !== 'isbn' && book.matchMethod !== 'external-id' &&
       book.matchMethod !== 'catalog-choice' && book.matchMethod !== 'migration')) {
    return null;
  }
  return `/books/${encodeURIComponent(book.workId)}`;
}

export function appendDistinctReaderPage(
  current: readonly WorkReaderAttemptSummary[],
  next: readonly WorkReaderAttemptSummary[],
): WorkReaderAttemptSummary[] {
  const currentUsernames = new Set(current.map((attempt) => attempt.username));
  return [...current, ...next.filter((attempt) => !currentUsernames.has(attempt.username))];
}

export interface ReaderAttemptGroup {
  username: string;
  displayName: string;
  attempts: WorkReaderAttemptSummary[];
}

export function groupReaderAttempts(attempts: readonly WorkReaderAttemptSummary[]): ReaderAttemptGroup[] {
  const groups = new Map<string, ReaderAttemptGroup>();
  for (const attempt of attempts) {
    const group = groups.get(attempt.username);
    if (group) group.attempts.push(attempt);
    else groups.set(attempt.username, {
      username: attempt.username,
      displayName: attempt.displayName,
      attempts: [attempt],
    });
  }
  for (const group of groups.values()) {
    group.attempts.sort((left, right) => {
      const leftDate = left.firstProgressAt ?? left.firstReadAt;
      const rightDate = right.firstProgressAt ?? right.firstReadAt;
      if (leftDate === rightDate) return 0;
      if (leftDate === null) return 1;
      if (rightDate === null) return -1;
      return leftDate < rightDate ? -1 : 1;
    });
  }
  return [...groups.values()].sort((left, right) => {
    if (left.displayName !== right.displayName) {
      return left.displayName < right.displayName ? -1 : 1;
    }
    return left.username < right.username ? -1 : left.username > right.username ? 1 : 0;
  });
}

export function displayTrackingCoverage(value: number | null): string {
  if (value === null) return 'Not enough data';
  return `${Math.round(Math.min(1, value) * 100)}%`;
}

export interface LatestRequestGate {
  begin(): number;
  isCurrent(requestId: number): boolean;
  invalidate(): void;
}

export function createLatestRequestGate(): LatestRequestGate {
  let current = 0;
  return {
    begin: () => ++current,
    isCurrent: (requestId) => requestId === current,
    invalidate: () => { current += 1; },
  };
}
