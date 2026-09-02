// The catalog console's pure half. The pages under src/routes/admin render
// the live scan and open one operation dialog; what that dialog binds to (a
// draft of text fields), the prefill each page button starts from, the
// operation built and validated from a draft, and the lookups the pages
// render all live here, where the root tests reach them without a browser.
import type {
  AdminCatalogAuthorRow,
  AdminCatalogBookRow,
  AdminCatalogBookTarget,
  AdminCatalogEditionRow,
  AdminCatalogFinding,
  AdminCatalogOperation,
  AdminCatalogWorkRow,
  CatalogAuthorInput,
  CatalogAuthorKind,
  CatalogEditionInput,
  CatalogScan,
  CatalogWorkInput,
  EditionFormat,
} from '../interfaces/catalog.ts';
import {
  parseAdminBookTargets,
  parseAdminExternalIds,
  parseAdminStringList,
} from './adminCatalog.ts';
import { normalizeIsbn } from './isbn.ts';

export type WorkDraftStatus = 'active' | 'hidden';
export type FictionDraft = 'unknown' | 'fiction' | 'nonfiction';

// One field per input; a list is one entry per line.
export interface WorkDraftFields {
  workId: string;
  status: WorkDraftStatus;
  canonicalTitle: string;
  alternateTitles: string;
  authorIds: string;
  coverUrl: string;
  subjects: string;
  fiction: FictionDraft;
}

export interface EditionDraftFields {
  editionId: string;
  workId: string;
  isbn: string;
  title: string;
  publisher: string;
  publishedDate: string;
  language: string;
  translatorNames: string;
  format: EditionFormat;
  pageCount: string;
  coverUrl: string;
  externalIds: string;
}

export type OperationDraft =
  | ({type: 'createWork'; bookTargets: string} & WorkDraftFields)
  | ({type: 'editWork'} & WorkDraftFields)
  | {
    type: 'upsertAuthor';
    // Blank for a new author: the dialog derives it from the canonical name
    // the way the add-book flow does (catalogAuthorIdFor), so a reader who
    // later adds the same name lands on the console's document.
    authorId: string;
    canonicalName: string;
    alternateNames: string;
    sortName: string;
    kind: CatalogAuthorKind;
  }
  | {type: 'mergeAuthors'; sourceAuthorId: string; targetAuthorId: string}
  | {type: 'linkBooks'; bookTargets: string; targetWorkId: string; targetEditionId: string}
  | {type: 'mergeWorks'; sourceWorkIds: string; targetWorkId: string}
  | ({type: 'upsertEdition'} & EditionDraftFields)
  | {type: 'repointIsbn'; isbn: string; editionId: string};

const lines = (values: readonly string[]): string => values.join('\n');

export const bookKey = (book: AdminCatalogBookTarget): string => `${book.uid}/${book.bookId}`;

// Ids for the documents the console creates, in the form the add-book flow
// mints them (catalog.create): a prefix and a random UUID.
export function newCatalogId(prefix: 'work' | 'edition'): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function workFields(work: AdminCatalogWorkRow, status: WorkDraftStatus): WorkDraftFields {
  return {
    workId: work.workId,
    status,
    canonicalTitle: work.canonicalTitle,
    alternateTitles: lines(work.alternateTitles),
    authorIds: lines(work.authorIds),
    coverUrl: work.coverUrl,
    subjects: lines(work.subjects),
    fiction: work.fiction === null ? 'unknown' : work.fiction ? 'fiction' : 'nonfiction',
  };
}

export function editWorkDraft(work: AdminCatalogWorkRow): OperationDraft {
  return {type: 'editWork', ...workFields(work, work.status === 'hidden' ? 'hidden' : 'active')};
}

// Hide is the soft delete: the work and its links stay, search and the
// reader page skip it. The same edit with the status flipped.
export function hideWorkDraft(work: AdminCatalogWorkRow): OperationDraft {
  return {type: 'editWork', ...workFields(work, 'hidden')};
}

export function createWorkDraft(books: readonly AdminCatalogBookTarget[] = []): OperationDraft {
  return {
    type: 'createWork',
    workId: newCatalogId('work'),
    status: 'active',
    canonicalTitle: '',
    alternateTitles: '',
    authorIds: '',
    coverUrl: '',
    subjects: '',
    fiction: 'unknown',
    bookTargets: lines(books.map(bookKey)),
  };
}

export function editAuthorDraft(author: AdminCatalogAuthorRow): OperationDraft {
  return {
    type: 'upsertAuthor',
    authorId: author.authorId,
    canonicalName: author.canonicalName,
    alternateNames: lines(author.alternateNames),
    sortName: author.sortName,
    kind: author.kind,
  };
}

export function createAuthorDraft(): OperationDraft {
  return {
    type: 'upsertAuthor', authorId: '', canonicalName: '', alternateNames: '', sortName: '',
    kind: 'person',
  };
}

export function mergeAuthorsDraft(sourceAuthorId: string, targetAuthorId = ''): OperationDraft {
  return {type: 'mergeAuthors', sourceAuthorId, targetAuthorId};
}

export function linkBooksDraft(
  books: readonly AdminCatalogBookTarget[],
  target: {workId: string; editionId: string | null} | null,
): OperationDraft {
  return {
    type: 'linkBooks',
    bookTargets: lines(books.map(bookKey)),
    targetWorkId: target?.workId ?? '',
    targetEditionId: target?.editionId ?? '',
  };
}

export function mergeWorksDraft(
  sourceWorkIds: readonly string[],
  targetWorkId: string,
): OperationDraft {
  return {type: 'mergeWorks', sourceWorkIds: lines(sourceWorkIds), targetWorkId};
}

// A duplicate set merges into its oldest member: the one most books
// already point at. Null when there is nothing to merge.
export function mergeIntoOldestDraft(works: readonly AdminCatalogWorkRow[]): OperationDraft | null {
  if (works.length < 2) return null;
  const byAge = [...works].sort((left, right) => left.createdAt - right.createdAt);
  return mergeWorksDraft(byAge.slice(1).map((work) => work.workId), byAge[0].workId);
}

export function editEditionDraft(edition: AdminCatalogEditionRow): OperationDraft {
  return {
    type: 'upsertEdition',
    editionId: edition.editionId,
    workId: edition.workId,
    isbn: edition.isbn13 ?? '',
    title: edition.title,
    publisher: edition.publisher,
    publishedDate: edition.publishedDate,
    language: edition.language,
    translatorNames: lines(edition.translatorNames),
    format: edition.format,
    pageCount: edition.suggestedPageCount?.toString() ?? '',
    coverUrl: edition.coverUrl,
    externalIds: lines(
      Object.entries(edition.externalIds).map(([provider, id]) => `${provider}=${id}`),
    ),
  };
}

// A new edition of a known work starts from the work's title and cover.
export function createEditionDraft(work: AdminCatalogWorkRow | null): OperationDraft {
  return {
    type: 'upsertEdition',
    editionId: newCatalogId('edition'),
    workId: work?.workId ?? '',
    isbn: '',
    title: work?.canonicalTitle ?? '',
    publisher: '',
    publishedDate: '',
    language: '',
    translatorNames: '',
    format: 'unknown',
    pageCount: '',
    coverUrl: work?.coverUrl ?? '',
    externalIds: '',
  };
}

export function repointIsbnDraft(isbn: string, editionId: string): OperationDraft {
  return {type: 'repointIsbn', isbn, editionId};
}

export function operationTitle(draft: OperationDraft): string {
  switch (draft.type) {
    case 'createWork': return 'New work';
    case 'editWork': return 'Edit work';
    case 'upsertAuthor': return draft.authorId === '' ? 'New author' : 'Edit author';
    case 'mergeAuthors': return 'Merge authors';
    case 'linkBooks': return 'Link or unlink books';
    case 'mergeWorks': return 'Merge works';
    case 'upsertEdition': return 'Create or edit edition';
    case 'repointIsbn': return 'Repoint ISBN';
  }
}

function requireId(value: string, label: string): string {
  const id = value.trim();
  if (id === '' || id.includes('/')) {
    throw new TypeError(`${label} must be one Firestore document ID.`);
  }
  return id;
}

function workInput(draft: WorkDraftFields): CatalogWorkInput {
  const canonicalTitle = draft.canonicalTitle.trim();
  const authorIds = parseAdminStringList(draft.authorIds);
  if (canonicalTitle === '') throw new TypeError('Canonical title is required.');
  if (authorIds.length === 0) throw new TypeError('At least one catalog author ID is required.');
  return {
    canonicalTitle,
    alternateTitles: parseAdminStringList(draft.alternateTitles),
    authorIds,
    coverUrl: draft.coverUrl.trim(),
    subjects: parseAdminStringList(draft.subjects),
    fiction: draft.fiction === 'unknown' ? null : draft.fiction === 'fiction',
  };
}

function authorInput(draft: OperationDraft & {type: 'upsertAuthor'}): CatalogAuthorInput {
  const canonicalName = draft.canonicalName.trim();
  const sortName = draft.sortName.trim();
  if (canonicalName === '' || sortName === '') {
    throw new TypeError('Canonical and sort names are required.');
  }
  return {
    canonicalName,
    alternateNames: parseAdminStringList(draft.alternateNames),
    sortName,
    kind: draft.kind,
  };
}

function editionInput(draft: EditionDraftFields): CatalogEditionInput {
  const rawIsbn = draft.isbn.trim();
  const isbn13 = rawIsbn === '' ? null : normalizeIsbn(rawIsbn);
  if (rawIsbn !== '' && isbn13 === null) {
    throw new TypeError('Edition ISBN must have a valid checksum.');
  }
  const title = draft.title.trim();
  if (title === '') throw new TypeError('Edition title is required.');
  const pageCount = draft.pageCount.trim() === '' ? null : Number(draft.pageCount);
  if (pageCount !== null && (!Number.isSafeInteger(pageCount) || pageCount <= 0)) {
    throw new TypeError('Suggested page count must be a positive whole number or blank.');
  }
  return {
    isbn13,
    title,
    publisher: draft.publisher.trim(),
    publishedDate: draft.publishedDate.trim(),
    language: draft.language.trim(),
    translatorNames: parseAdminStringList(draft.translatorNames),
    format: draft.format,
    suggestedPageCount: pageCount,
    coverUrl: draft.coverUrl.trim(),
    externalIds: parseAdminExternalIds(draft.externalIds),
  };
}

// The operation a draft describes. Validation failures are TypeErrors with
// the message the dialog shows; nothing else is caught.
export function buildOperation(draft: OperationDraft): AdminCatalogOperation {
  switch (draft.type) {
    case 'upsertAuthor':
      return {
        type: 'upsertAuthor',
        authorId: requireId(draft.authorId, 'Author ID'),
        author: authorInput(draft),
      };
    case 'mergeAuthors':
      return {
        type: 'mergeAuthors',
        sourceAuthorId: requireId(draft.sourceAuthorId, 'Source author ID'),
        targetAuthorId: requireId(draft.targetAuthorId, 'Target author ID'),
      };
    case 'createWork':
      return {
        type: 'createWork',
        workId: requireId(draft.workId, 'Work ID'),
        status: draft.status,
        work: workInput(draft),
        books: parseAdminBookTargets(draft.bookTargets),
      };
    case 'editWork':
      return {
        type: 'editWork',
        workId: requireId(draft.workId, 'Work ID'),
        status: draft.status,
        work: workInput(draft),
      };
    case 'linkBooks': {
      const books = parseAdminBookTargets(draft.bookTargets);
      if (books.length === 0) throw new TypeError('Select at least one personal book.');
      const targetWorkId = draft.targetWorkId.trim();
      return {
        type: 'linkBooks',
        books,
        target: targetWorkId === '' ? null : {
          workId: requireId(targetWorkId, 'Target work ID'),
          editionId: draft.targetEditionId.trim() === '' ?
            null : requireId(draft.targetEditionId, 'Target edition ID'),
        },
      };
    }
    case 'mergeWorks': {
      const sourceWorkIds = parseAdminStringList(draft.sourceWorkIds)
        .map((id) => requireId(id, 'Source work ID'));
      if (sourceWorkIds.length === 0) throw new TypeError('Enter at least one source work ID.');
      return {
        type: 'mergeWorks',
        sourceWorkIds,
        targetWorkId: requireId(draft.targetWorkId, 'Target work ID'),
      };
    }
    case 'upsertEdition':
      return {
        type: 'upsertEdition',
        editionId: requireId(draft.editionId, 'Edition ID'),
        workId: requireId(draft.workId, 'Edition work ID'),
        edition: editionInput(draft),
      };
    case 'repointIsbn': {
      const isbn13 = normalizeIsbn(draft.isbn);
      if (isbn13 === null) throw new TypeError('Repointed ISBN must have a valid checksum.');
      return {
        type: 'repointIsbn',
        isbn13,
        editionId: requireId(draft.editionId, 'Edition ID'),
      };
    }
  }
}

export const newestFirst = (left: {createdAt: number}, right: {createdAt: number}): number =>
  right.createdAt - left.createdAt;

export function sortAuthors(authors: readonly AdminCatalogAuthorRow[]): AdminCatalogAuthorRow[] {
  return [...authors].sort((left, right) =>
    left.sortName.localeCompare(right.sortName) ||
    left.canonicalName.localeCompare(right.canonicalName));
}

export function authorNamesById(scan: Pick<CatalogScan, 'authors'>): Map<string, string> {
  return new Map(scan.authors.map((author) => [author.authorId, author.canonicalName]));
}

export function catalogAuthorNames(
  names: ReadonlyMap<string, string>,
  ids: readonly string[],
): string {
  return ids.map((id) => names.get(id) ?? `[Missing ${id}]`).join(', ');
}

// Personal books grouped under the work they resolve to: a book still
// linked to a merged alias counts for the survivor, as linkedBookCount does.
export function booksByWork(
  scan: Pick<CatalogScan, 'works' | 'books'>,
): Map<string, AdminCatalogBookRow[]> {
  const workById = new Map(scan.works.map((work) => [work.workId, work]));
  const byWork = new Map<string, AdminCatalogBookRow[]>();
  for (const book of scan.books) {
    if (book.workId === null) continue;
    const work = workById.get(book.workId);
    const resolved = work?.status === 'merged' && work.mergedInto !== null ?
      work.mergedInto : book.workId;
    byWork.set(resolved, [...(byWork.get(resolved) ?? []), book]);
  }
  return byWork;
}

// Works naming the author by its own id or by any alias merged into it,
// newest first. Merged works are aliases themselves and are left out; their
// survivors are listed.
export function worksByAuthor(
  scan: Pick<CatalogScan, 'works' | 'authors'>,
  authorId: string,
): AdminCatalogWorkRow[] {
  const author = scan.authors.find((row) => row.authorId === authorId);
  const ids = new Set([authorId, ...(author?.mergedFrom ?? [])]);
  return scan.works
    .filter((work) => work.status !== 'merged' && work.authorIds.some((id) => ids.has(id)))
    .sort(newestFirst);
}

export function duplicateFindingsFor(
  scan: Pick<CatalogScan, 'findings'>,
  workId: string,
): AdminCatalogFinding[] {
  return scan.findings.filter((finding) =>
    finding.code === 'suspected-duplicate-works' && finding.workIds.includes(workId));
}

// Every whitespace-separated token of the query must appear somewhere in
// the row's text, case-insensitively; a blank query keeps every row.
export function filterRows<T>(rows: readonly T[], query: string, text: (row: T) => string): T[] {
  const tokens = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return [...rows];
  return rows.filter((row) => {
    const haystack = text(row).toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

export function workSearchText(
  work: AdminCatalogWorkRow,
  names: ReadonlyMap<string, string>,
): string {
  return [
    work.canonicalTitle, ...work.alternateTitles, catalogAuthorNames(names, work.authorIds),
    work.workId, work.status, work.createdBy ?? '',
  ].join(' ');
}

export function authorSearchText(author: AdminCatalogAuthorRow): string {
  return [
    author.canonicalName, author.sortName, ...author.alternateNames, author.authorId,
    author.kind, author.status,
  ].join(' ');
}

// Works record the account that created them through the add-book flow;
// the migration and the console leave the field absent.
export function creatorLabel(createdBy: string | null, emails: ReadonlyMap<string, string>): string {
  if (createdBy === null) return 'unknown';
  const email = emails.get(createdBy);
  return email === undefined || email === '' ? createdBy : email;
}

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
