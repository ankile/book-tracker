// The catalog console's pure half. The pages under src/routes/admin render
// the live scan and open one operation dialog; what that dialog binds to (a
// draft of text fields), the prefill each page button starts from, the
// operation built and validated from a draft, and the lookups the pages
// render all live here, where the root tests reach them without a browser.
import { isLanguageCode } from '../../../shared/language.ts';
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
  language: string;
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
  | {type: 'mergeEditions'; workId: string; sourceEditionIds: string; targetEditionId: string}
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
    language: work.language,
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
    language: '',
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

// Two records of one edition of a work: the sources become aliases of the
// target and their readers' books move to it.
export function mergeEditionsDraft(
  workId: string,
  sourceEditionIds: readonly string[],
  targetEditionId = '',
): OperationDraft {
  return {type: 'mergeEditions', workId, sourceEditionIds: lines(sourceEditionIds), targetEditionId};
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
    case 'mergeEditions': return 'Merge editions';
    case 'upsertEdition': return 'Create or edit edition';
    case 'repointIsbn': return 'Repoint ISBN';
  }
}

// Typed as a code (en, no); blank is unknown on a work and inherit on an
// edition. The server rejects anything else too.
function languageCode(value: string): string {
  const code = value.trim().toLowerCase();
  if (!isLanguageCode(code)) {
    throw new TypeError('Language must be a two- or three-letter code such as en or no, or blank.');
  }
  return code;
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
    language: languageCode(draft.language),
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
    language: languageCode(draft.language),
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
    case 'mergeEditions': {
      const sourceEditionIds = parseAdminStringList(draft.sourceEditionIds)
        .map((id) => requireId(id, 'Source edition ID'));
      if (sourceEditionIds.length === 0) throw new TypeError('Enter at least one source edition ID.');
      const targetEditionId = requireId(draft.targetEditionId, 'Surviving edition ID');
      if (sourceEditionIds.includes(targetEditionId)) {
        throw new TypeError('The surviving edition cannot also be a source.');
      }
      return {
        type: 'mergeEditions',
        workId: requireId(draft.workId, 'Work ID'),
        sourceEditionIds,
        targetEditionId,
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

// ---- The overview's view state lives in the URL: which tab, the search
// text, the page, the review and creator filters and whether merged and
// hidden records are shown (?tab=&q=&page=&review=&creator=&inactive=1), so
// a list can be linked to and the browser's history steps back through it.
// Defaults are left out of the URL.

export type ConsoleTab = 'works' | 'authors' | 'books' | 'findings';
export type ReviewFilter = 'all' | 'needs' | 'done';
export type CreatorFilter = 'all' | 'others' | 'me';

export interface ConsoleQuery {
  tab: ConsoleTab;
  q: string;
  page: number;
  review: ReviewFilter;
  creator: CreatorFilter;
  // A merged work or author is an alias of its survivor and a hidden work
  // is soft-deleted; the lists leave both out unless asked (owner decision
  // 2026-09-02).
  inactive: boolean;
}

export const CONSOLE_PAGE_SIZE = 50;
export const DEFAULT_CONSOLE_QUERY: ConsoleQuery = {
  tab: 'works', q: '', page: 1, review: 'all', creator: 'all', inactive: false,
};
const CONSOLE_TABS: readonly ConsoleTab[] = ['works', 'authors', 'books', 'findings'];
const REVIEW_FILTERS: readonly ReviewFilter[] = ['all', 'needs', 'done'];
const CREATOR_FILTERS: readonly CreatorFilter[] = ['all', 'others', 'me'];

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

// Anything unrecognised falls back to the default rather than failing: a
// stale or hand-edited URL still opens the console.
export function parseConsoleQuery(params: URLSearchParams): ConsoleQuery {
  const page = Number(params.get('page') ?? '1');
  return {
    tab: oneOf(params.get('tab'), CONSOLE_TABS, DEFAULT_CONSOLE_QUERY.tab),
    q: params.get('q') ?? '',
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
    review: oneOf(params.get('review'), REVIEW_FILTERS, DEFAULT_CONSOLE_QUERY.review),
    creator: oneOf(params.get('creator'), CREATOR_FILTERS, DEFAULT_CONSOLE_QUERY.creator),
    inactive: params.get('inactive') === '1',
  };
}

// The href of a changed view. A change to anything but the page itself
// starts over at page 1, since the old page number means nothing in a
// different list.
export function consoleHref(query: ConsoleQuery, patch: Partial<ConsoleQuery> = {}): string {
  const next: ConsoleQuery = { ...query, ...patch };
  const restarts = (['tab', 'q', 'review', 'creator', 'inactive'] as const)
    .some((key) => patch[key] !== undefined && patch[key] !== query[key]);
  if (restarts && patch.page === undefined) next.page = 1;
  const params = new URLSearchParams();
  for (const key of ['tab', 'q', 'page', 'review', 'creator'] as const) {
    if (next[key] !== DEFAULT_CONSOLE_QUERY[key]) params.set(key, String(next[key]));
  }
  if (next.inactive) params.set('inactive', '1');
  const search = params.toString();
  return search === '' ? '/admin' : `/admin?${search}`;
}

// ---- Review marks. A record is reviewed once the operator marks it and
// nothing has landed on it since; activity after the mark (a new edition,
// a linked book, a new work naming the author) puts it back in the queue.

export interface ReviewMarks {
  reviewedAt: number | null;
  activityAt: number;
}

export type ReviewStatus = 'never' | 'changed' | 'done';

export function reviewStatus(row: ReviewMarks): ReviewStatus {
  if (row.reviewedAt === null) return 'never';
  return row.activityAt > row.reviewedAt ? 'changed' : 'done';
}

export function reviewLabel(row: ReviewMarks): string {
  if (row.reviewedAt === null) return 'needs review';
  const day = isoDay(row.reviewedAt);
  return row.activityAt > row.reviewedAt ? `changed since review ${day}` : `reviewed ${day}`;
}

export function activeOnly<T extends { status: string }>(rows: readonly T[], showInactive: boolean): T[] {
  return showInactive ? [...rows] : rows.filter((row) => row.status === 'active');
}

export function filterByReview<T extends ReviewMarks>(rows: readonly T[], filter: ReviewFilter): T[] {
  if (filter === 'all') return [...rows];
  return rows.filter((row) => (reviewStatus(row) === 'done') === (filter === 'done'));
}

// "me" is the operator; a record without a creator counts as someone
// else's, since the point of the filter is what the operator did not add.
export function filterByCreator<T extends { createdBy: string | null }>(
  rows: readonly T[],
  filter: CreatorFilter,
  operatorUid: string,
): T[] {
  if (filter === 'all') return [...rows];
  return rows.filter((row) => (row.createdBy === operatorUid) === (filter === 'me'));
}

export interface ConsolePage<T> {
  rows: T[];
  page: number;
  pages: number;
  total: number;
  // 1-based positions of the first and last row shown; 0 when empty.
  from: number;
  to: number;
}

// A page past the end shows the last page rather than nothing, so a link
// kept from a longer list still lands somewhere.
export function paginate<T>(rows: readonly T[], page: number, size = CONSOLE_PAGE_SIZE): ConsolePage<T> {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, page), pages);
  const slice = rows.slice((current - 1) * size, current * size);
  const from = slice.length === 0 ? 0 : (current - 1) * size + 1;
  return { rows: slice, page: current, pages, total, from, to: slice.length === 0 ? 0 : from + slice.length - 1 };
}

// ---- Picker options. The operation dialog chooses records through a
// searchable list (RecordPicker) rather than a select: each row says enough
// to tell two records apart, and the search covers what an operator knows
// about a record (title, names, id, ISBN).

export interface PickerOption {
  id: string;
  title: string;
  detail: string;
  meta: string;
  // Lowercased text the picker's search box matches against.
  search: string;
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

export function workPickerOptions(
  works: readonly AdminCatalogWorkRow[],
  names: ReadonlyMap<string, string>,
): PickerOption[] {
  return works.map((work) => {
    const authors = catalogAuthorNames(names, work.authorIds);
    return {
      id: work.workId,
      title: work.canonicalTitle,
      detail: `${authors} · ${work.workId}`,
      meta: `${count(work.linkedBookCount, 'reader')} · ${count(work.editionCount, 'edition')} · created ${isoDay(work.createdAt)}` +
        (work.status === 'hidden' ? ' · hidden' : ''),
      search: [work.canonicalTitle, ...work.alternateTitles, authors, work.workId].join(' ').toLowerCase(),
    };
  });
}

export function authorPickerOptions(authors: readonly AdminCatalogAuthorRow[]): PickerOption[] {
  return authors.map((author) => ({
    id: author.authorId,
    title: author.canonicalName,
    detail: `${author.sortName} · ${author.kind} · ${author.authorId}`,
    meta: count(author.workCount, 'work') +
      (author.alternateNames.length > 0 ? ` · also ${author.alternateNames.join(', ')}` : ''),
    search: [author.canonicalName, author.sortName, ...author.alternateNames, author.authorId].join(' ').toLowerCase(),
  }));
}

export function editionPickerOptions(
  editions: readonly AdminCatalogEditionRow[],
  workTitles: ReadonlyMap<string, string>,
): PickerOption[] {
  return editions.map((edition) => {
    const workTitle = workTitles.get(edition.workId) ?? edition.workId;
    return {
      id: edition.editionId,
      title: edition.title,
      detail: [edition.isbn13 ?? 'no ISBN', edition.publisher, edition.publishedDate].filter(Boolean).join(' · ') +
        ` · ${edition.editionId}`,
      meta: workTitle + (edition.language !== '' ? ` · ${edition.language}` : ''),
      search: [edition.title, edition.isbn13 ?? '', edition.publisher, workTitle, edition.editionId].join(' ').toLowerCase(),
    };
  });
}
