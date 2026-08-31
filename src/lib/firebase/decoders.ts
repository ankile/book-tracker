import {
  DocumentReference,
  Timestamp,
  type DocumentData,
} from 'firebase/firestore';
import type {
  Author,
  AuthorKind,
  AuthorRetirement,
  LegacyEmbeddedAuthor,
} from '../interfaces/author.ts';
import type {
  Book,
  ActiveTimer,
  CurrentBook,
  LegacyEmbeddedAuthorsBook,
  LegacyStringAuthorBook,
} from '../interfaces/book.ts';
import type { CatalogLink, CatalogMatchMethod } from '../interfaces/catalog.ts';
import type { BookMetadata } from '../interfaces/metadata.ts';
import {
  PROFILE_LINK_TYPES,
  type Momentum,
  type ProfileDay,
  type ProfileLink,
  type Profile,
  type ProfileDiscovery,
  type ProfileRecords,
  type ProfileStats,
  type ProfileView,
  type ProfileYear,
  type PublishedSuperlatives,
} from '../interfaces/profile.ts';
import type { BookUpdate, ReadingSession } from '../interfaces/reading.ts';
import { splitPersonName, joinPersonName } from '../utils/authors.ts';
import { isFinished } from '../utils/finished.ts';

type Data = Record<string, unknown>;

export class DataDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataDecodeError';
  }
}

export interface UserDocument {
  uid: string;
  email: string;
  // Status-only (SEC-004): the credential lives server-side in the
  // secrets database and never reaches the client or its IndexedDB
  // mirror. Presence of this map means "connected".
  toggl?: {
    workspaceId: number;
    projectId: number;
    connectedAt: Timestamp;
  };
}

export type QueueStatus = 'pending' | 'processing' | 'error';

interface QueueBase {
  id: string;
  bookId?: string;
  timerClaimVersion?: 1;
  bookTitle: string;
  start: string;
  stop: string;
  status: QueueStatus | 'outcome-unknown';
  createdAt: Timestamp;
  attempts: number;
  claimedAt: Timestamp | null;
  error: string | null;
  retryRequestedAt: Timestamp | null;
  // Server-pinned end of the quota window that deferred a pending row. The
  // rules refuse a retry marker before it, so the sweep must not ask.
  deferredUntil: Timestamp | null;
  // Windows that have deferred the row; the server makes it terminal past
  // its cap. Informational on the client.
  deferrals: number;
}

export interface CreateQueueItem extends QueueBase {
  type: 'create';
  entryId?: never;
}

export interface StopQueueItem extends QueueBase {
  type: 'stop';
  entryId: number;
}

export type RetryableQueueItem = (CreateQueueItem | StopQueueItem) & { status: QueueStatus };

export interface OutcomeUnknownQueueItem extends Omit<CreateQueueItem, 'status'> {
  status: 'outcome-unknown';
}

export type QueueSweepItem = RetryableQueueItem | OutcomeUnknownQueueItem;

export type NewQueueOperation =
  | Pick<CreateQueueItem, 'type' | 'bookTitle' | 'start' | 'stop'>
  | Pick<StopQueueItem, 'type' | 'bookTitle' | 'start' | 'stop' | 'entryId'>;

function fail(context: string, expected: string): never {
  throw new DataDecodeError(`${context}: expected ${expected}`);
}

function record(value: unknown, context: string): Data {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(context, 'an object');
  }
  return value as Data;
}

function string(value: unknown, context: string): string {
  if (typeof value !== 'string') return fail(context, 'a string');
  return value;
}

function nonEmptyString(value: unknown, context: string): string {
  const decoded = string(value, context);
  if (decoded.length === 0) return fail(context, 'a non-empty string');
  return decoded;
}

function boundedString(value: unknown, context: string, maxLength: number): string {
  const decoded = nonEmptyString(value, context);
  if (decoded.length > maxLength) return fail(context, `at most ${maxLength} characters`);
  return decoded;
}

const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function calendarValidIsoTimestamp(value: string): boolean {
  const match = ISO_TIMESTAMP.exec(value);
  if (match === null || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  return calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day &&
    calendar.getUTCHours() === hour &&
    calendar.getUTCMinutes() === minute &&
    calendar.getUTCSeconds() === second;
}

function isoTimestamp(value: unknown, context: string): string {
  const decoded = boundedString(value, context, 64);
  if (!calendarValidIsoTimestamp(decoded)) return fail(context, 'an ISO timestamp');
  return decoded;
}

function number(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail(context, 'a finite number');
  }
  return value;
}

function integer(value: unknown, context: string): number {
  const decoded = number(value, context);
  if (!Number.isInteger(decoded)) return fail(context, 'an integer');
  return decoded;
}

function boolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') return fail(context, 'a boolean');
  return value;
}

function timestamp(value: unknown, context: string): Timestamp {
  if (!(value instanceof Timestamp)) return fail(context, 'a Firestore Timestamp');
  return value;
}

function reference(value: unknown, context: string): DocumentReference<DocumentData> {
  if (!(value instanceof DocumentReference)) {
    return fail(context, 'a Firestore DocumentReference');
  }
  return value;
}

function strings(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) return fail(context, 'an array');
  return value.map((entry, index) => string(entry, `${context}[${index}]`));
}

function nullableNonEmptyString(value: unknown, context: string): string | null {
  return value === undefined || value === null ? null : nonEmptyString(value, context);
}

function catalogMatchMethod(value: unknown, context: string): CatalogMatchMethod | null {
  if (value === undefined || value === null) return null;
  const decoded = string(value, context);
  if (
    decoded !== 'isbn' &&
    decoded !== 'external-id' &&
    decoded !== 'catalog-choice' &&
    decoded !== 'migration' &&
    decoded !== 'admin'
  ) {
    return fail(context, 'isbn, external-id, catalog-choice, migration, admin, or null');
  }
  return decoded;
}

function catalogLink(data: Data, context: string): CatalogLink {
  const link: CatalogLink = {
    workId: nullableNonEmptyString(data.workId, `${context}.workId`),
    editionId: nullableNonEmptyString(data.editionId, `${context}.editionId`),
    matchMethod: catalogMatchMethod(data.matchMethod, `${context}.matchMethod`),
    linkedAt: data.linkedAt === undefined || data.linkedAt === null
      ? null
      : timestamp(data.linkedAt, `${context}.linkedAt`),
  };
  if (link.workId === null) {
    if (link.editionId !== null || link.matchMethod !== null || link.linkedAt !== null) {
      return fail(context, 'editionId, matchMethod, and linkedAt to be null when workId is null');
    }
    return link;
  }
  if (link.matchMethod === null || link.linkedAt === null) {
    return fail(context, 'matchMethod and linkedAt for a linked work');
  }
  return link;
}

function exactKeys(value: Data, allowed: readonly string[], context: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) fail(context, `only keys ${allowed.join(', ')}`);
}

function metadata(data: Data, context: string): BookMetadata {
  const subjectsValue = data.subjects ?? [];
  const fictionValue = data.fiction ?? null;
  if (fictionValue !== null && typeof fictionValue !== 'boolean') {
    fail(`${context}.fiction`, 'boolean or null');
  }
  return {
    coverUrl: string(data.coverUrl ?? '', `${context}.coverUrl`),
    publisher: string(data.publisher ?? '', `${context}.publisher`),
    publishedDate: string(data.publishedDate ?? '', `${context}.publishedDate`),
    subjects: strings(subjectsValue, `${context}.subjects`),
    fiction: fictionValue,
  };
}

function activeTimer(value: unknown, context: string): ActiveTimer | null {
  if (value === undefined || value === null) return null;
  const data = record(value, context);
  if (data.state === 'stopping') {
    exactKeys(data, ['state', 'entryId', 'start', 'queueId'], context);
    const entryId = integer(data.entryId, `${context}.entryId`);
    if (entryId <= 0) fail(`${context}.entryId`, 'a positive integer');
    return {
      state: 'stopping',
      entryId,
      start: isoTimestamp(data.start, `${context}.start`),
      queueId: boundedString(data.queueId, `${context}.queueId`, 600),
    };
  }
  if (data.state === 'starting' || data.state === 'outcome-unknown') {
    exactKeys(
      data,
      ['state', 'operationId', 'start', 'claimedAt', ...(data.state === 'outcome-unknown' ? ['error'] : [])],
      context,
    );
    const shared = {
      state: data.state,
      operationId: boundedString(data.operationId, `${context}.operationId`, 100),
      start: isoTimestamp(data.start, `${context}.start`),
      claimedAt: timestamp(data.claimedAt, `${context}.claimedAt`),
    };
    return data.state === 'starting'
      ? shared
      : { ...shared, error: boundedString(data.error, `${context}.error`, 1000) };
  }
  if (data.state !== undefined) fail(`${context}.state`, 'starting, stopping, outcome-unknown, or absent');
  exactKeys(data, ['entryId', 'operationId', 'start'], context);
  const start = isoTimestamp(data.start, `${context}.start`);
  if (data.entryId === undefined) return data.operationId === undefined
    ? { start }
    : { start, operationId: boundedString(data.operationId, `${context}.operationId`, 100) };
  const entryId = integer(data.entryId, `${context}.entryId`);
  if (entryId <= 0) fail(`${context}.entryId`, 'a positive integer');
  return { start, entryId };
}

function embeddedAuthors(value: unknown, context: string): LegacyEmbeddedAuthor[] {
  if (!Array.isArray(value)) return fail(context, 'an array');
  return value.map((entry, index) => {
    const author = record(entry, `${context}[${index}]`);
    return {
      id: nonEmptyString(author.id, `${context}[${index}].id`),
      name: nonEmptyString(author.name, `${context}[${index}].name`),
    };
  });
}

export function decodeBook(id: string, value: unknown, path: string): Book {
  const data = record(value, path);
  const currentPage = number(data.currentPage, `${path}.currentPage`);
  const pageCount = number(data.pageCount, `${path}.pageCount`);
  const shared = {
    id,
    currentPage,
    currentPageUpdateId: data.currentPageUpdateId === undefined || data.currentPageUpdateId === null
      ? null
      : nonEmptyString(data.currentPageUpdateId, `${path}.currentPageUpdateId`),
    pageCount,
    pagesRead: number(data.pagesRead ?? 0, `${path}.pagesRead`),
    timeRead: number(data.timeRead ?? 0, `${path}.timeRead`),
    title: nonEmptyString(data.title, `${path}.title`),
    finished: data.finished === undefined
      ? isFinished(currentPage, pageCount)
      : boolean(data.finished, `${path}.finished`),
    // Absent on documents written before the field existed; null is the
    // stored value for an unfinished book.
    finishedAt: data.finishedAt === undefined || data.finishedAt === null
      ? null
      : timestamp(data.finishedAt, `${path}.finishedAt`),
    isbn: string(data.isbn ?? '', `${path}.isbn`),
    owner: reference(data.owner, `${path}.owner`),
    createdAt: timestamp(data.createdAt, `${path}.createdAt`),
    updatedAt: timestamp(data.updatedAt, `${path}.updatedAt`),
    activeTimer: activeTimer(data.activeTimer, `${path}.activeTimer`),
    ...catalogLink(data, path),
    ...metadata(data, path),
  };

  const authorIds = data.authorIds === undefined
    ? undefined
    : strings(data.authorIds, `${path}.authorIds`);
  const legacyAuthor = data.author === undefined
    ? undefined
    : string(data.author, `${path}.author`);
  const legacyAuthors = data.authors === undefined
    ? undefined
    : embeddedAuthors(data.authors, `${path}.authors`);

  if (legacyAuthor !== undefined) {
    const book: LegacyStringAuthorBook = {
      ...shared,
      author: legacyAuthor,
      ...(authorIds === undefined ? {} : { authorIds }),
    };
    if (legacyAuthors !== undefined) book.authors = legacyAuthors;
    return book;
  }
  if (legacyAuthors !== undefined) {
    const book: LegacyEmbeddedAuthorsBook = {
      ...shared,
      authors: legacyAuthors,
      ...(authorIds === undefined ? {} : { authorIds }),
    };
    return book;
  }
  if (authorIds === undefined) fail(path, 'authorIds or a documented legacy author field');
  const book: CurrentBook = { ...shared, authorIds };
  return book;
}

export function decodeAuthor(id: string, value: unknown, path: string): Author {
  const data = record(value, path);
  const name = nonEmptyString(data.name, `${path}.name`);
  const nameLower = string(data.nameLower ?? name.toLowerCase(), `${path}.nameLower`);
  if (nameLower !== name.toLowerCase()) fail(`${path}.nameLower`, name.toLowerCase());
  let retirement: AuthorRetirement | undefined;
  if (data.retirement !== undefined) {
    const retired = record(data.retirement, `${path}.retirement`);
    const reason = string(retired.reason, `${path}.retirement.reason`);
    if (reason === 'deleted') {
      exactKeys(retired, ['reason'], `${path}.retirement`);
      retirement = { reason };
    } else if (reason === 'merged') {
      exactKeys(retired, ['reason', 'targetId'], `${path}.retirement`);
      retirement = {
        reason,
        targetId: nonEmptyString(retired.targetId, `${path}.retirement.targetId`),
      };
    } else {
      fail(`${path}.retirement.reason`, 'deleted or merged');
    }
  }
  const retirementFields = retirement === undefined ? {} : { retirement };

  if (data.kind === undefined) {
    const parts = splitPersonName(name);
    return {
      id, name, nameLower, alternateNames: [], sortName: parts.familyName,
      kind: 'person', ...parts, ...retirementFields,
    };
  }

  const kindValue = string(data.kind, `${path}.kind`);
  if (kindValue !== 'person' && kindValue !== 'entity' && kindValue !== 'placeholder') {
    fail(`${path}.kind`, 'person, entity, or placeholder');
  }
  const kind: AuthorKind = kindValue;
  if (kind === 'person') {
    const familyName = nonEmptyString(data.familyName, `${path}.familyName`);
    const givenName = data.givenName === undefined
      ? undefined
      : string(data.givenName, `${path}.givenName`);
    if (joinPersonName({ givenName: givenName ?? '', familyName }) !== name) {
      fail(path, 'a person name matching its explicit name parts');
    }
    return {
      id,
      name,
      nameLower,
      alternateNames: [],
      sortName: familyName,
      kind,
      familyName,
      ...(givenName ? { givenName } : {}),
      ...retirementFields,
    };
  }
  if (data.givenName !== undefined || data.familyName !== undefined) {
    fail(path, 'a non-person author without person name parts');
  }
  return { id, name, nameLower, alternateNames: [], sortName: name, kind, ...retirementFields };
}

export function decodeCatalogAuthor(id: string, value: unknown, path: string): Author {
  const data = record(value, path);
  const name = nonEmptyString(data.canonicalName, `${path}.canonicalName`);
  const alternateNames = strings(data.alternateNames, `${path}.alternateNames`);
  const sortName = nonEmptyString(data.sortName, `${path}.sortName`);
  strings(data.nameKeys, `${path}.nameKeys`);
  strings(data.mergedFrom, `${path}.mergedFrom`);
  const kindValue = string(data.kind, `${path}.kind`);
  if (kindValue !== 'person' && kindValue !== 'entity' && kindValue !== 'placeholder') {
    fail(`${path}.kind`, 'person, entity, or placeholder');
  }
  const status = string(data.status, `${path}.status`);
  let retirement: AuthorRetirement | undefined;
  if (status === 'merged') {
    retirement = {
      reason: 'merged',
      targetId: nonEmptyString(data.mergedInto, `${path}.mergedInto`),
    };
  } else if (status !== 'active') {
    fail(`${path}.status`, 'active or merged');
  }
  const base = {
    id,
    name,
    nameLower: name.toLowerCase(),
    alternateNames,
    sortName,
    ...(retirement === undefined ? {} : {retirement}),
  };
  if (kindValue === 'person') {
    const parts = splitPersonName(name);
    return {
      ...base,
      kind: kindValue,
      familyName: sortName,
      ...(parts.givenName === '' ? {} : {givenName: parts.givenName}),
    };
  }
  return {...base, kind: kindValue};
}

function profileLink(value: unknown, context: string): ProfileLink {
  const data = record(value, context);
  exactKeys(data, ['type', 'value', 'label'], context);
  const type = string(data.type, `${context}.type`);
  const supportedType = PROFILE_LINK_TYPES.find((candidate) => candidate === type);
  if (supportedType === undefined) fail(`${context}.type`, 'a supported profile link type');
  const label = data.label === undefined ? undefined : string(data.label, `${context}.label`);
  return {
    type: supportedType,
    value: string(data.value, `${context}.value`),
    ...(label === undefined ? {} : { label }),
  };
}

function profileStats(value: unknown, context: string): ProfileStats {
  const data = record(value, context);
  const keys = [
    'totalBooks', 'finishedBooks', 'readingBooks', 'totalTimeReadHours',
    'totalPagesRead', 'booksPerYear', 'avgTimePerBook', 'authors',
  ] as const;
  exactKeys(data, keys, context);
  return {
    totalBooks: number(data.totalBooks, `${context}.totalBooks`),
    finishedBooks: number(data.finishedBooks, `${context}.finishedBooks`),
    readingBooks: number(data.readingBooks, `${context}.readingBooks`),
    totalTimeReadHours: number(data.totalTimeReadHours, `${context}.totalTimeReadHours`),
    totalPagesRead: number(data.totalPagesRead, `${context}.totalPagesRead`),
    booksPerYear: number(data.booksPerYear, `${context}.booksPerYear`),
    avgTimePerBook: number(data.avgTimePerBook, `${context}.avgTimePerBook`),
    authors: number(data.authors, `${context}.authors`),
  };
}

function profileYear(value: unknown, context: string): ProfileYear {
  const data = record(value, context);
  exactKeys(data, ['year', 'count', 'hours', 'pages'], context);
  return {
    year: integer(data.year, `${context}.year`),
    count: number(data.count, `${context}.count`),
    hours: number(data.hours, `${context}.hours`),
    pages: number(data.pages, `${context}.pages`),
  };
}

function profileDay(value: unknown, context: string): ProfileDay {
  const data = record(value, context);
  exactKeys(data, ['day', 'pagesRead', 'timeRead', 'sessions'], context);
  return {
    day: string(data.day, `${context}.day`),
    pagesRead: number(data.pagesRead, `${context}.pagesRead`),
    timeRead: number(data.timeRead, `${context}.timeRead`),
    sessions: number(data.sessions, `${context}.sessions`),
  };
}

function momentum(value: unknown, context: string): Momentum | null {
  if (value === null) return null;
  const data = record(value, context);
  exactKeys(data, ['recentPagesPerDay', 'lifetimePagesPerDay', 'ratio'], context);
  return {
    recentPagesPerDay: number(data.recentPagesPerDay, `${context}.recentPagesPerDay`),
    lifetimePagesPerDay: number(data.lifetimePagesPerDay, `${context}.lifetimePagesPerDay`),
    ratio: data.ratio === null ? null : number(data.ratio, `${context}.ratio`),
  };
}

function superlatives(value: unknown, context: string): PublishedSuperlatives {
  const data = record(value, context);
  exactKeys(data, ['biggestDay', 'longestSession', 'medianSessionMinutes', 'fastestFinish'], context);

  const biggestDay = data.biggestDay === null
    ? null
    : (() => {
        const row = record(data.biggestDay, `${context}.biggestDay`);
        exactKeys(row, ['day', 'pages'], `${context}.biggestDay`);
        return {
          day: string(row.day, `${context}.biggestDay.day`),
          pages: number(row.pages, `${context}.biggestDay.pages`),
        };
      })();
  const longestSession = data.longestSession === null
    ? null
    : (() => {
        const row = record(data.longestSession, `${context}.longestSession`);
        exactKeys(row, ['minutes'], `${context}.longestSession`);
        return { minutes: number(row.minutes, `${context}.longestSession.minutes`) };
      })();
  const fastestFinish = data.fastestFinish === null
    ? null
    : (() => {
        const row = record(data.fastestFinish, `${context}.fastestFinish`);
        exactKeys(row, ['days', 'pageCount'], `${context}.fastestFinish`);
        return {
          days: number(row.days, `${context}.fastestFinish.days`),
          pageCount: number(row.pageCount, `${context}.fastestFinish.pageCount`),
        };
      })();
  return {
    biggestDay,
    longestSession,
    medianSessionMinutes: number(data.medianSessionMinutes, `${context}.medianSessionMinutes`),
    fastestFinish,
  };
}

function profileRecords(value: unknown, context: string): ProfileRecords | null {
  if (value === null) return null;
  const data = record(value, context);
  exactKeys(data, ['momentum', 'superlatives'], context);
  return {
    momentum: momentum(data.momentum, `${context}.momentum`),
    superlatives: superlatives(data.superlatives, `${context}.superlatives`),
  };
}

export function decodeProfile(username: string, value: unknown, path: string): Profile {
  const data = record(value, path);
  exactKeys(
    data,
    ['uid', 'public', 'givenName', 'familyName', 'links', 'stats', 'records', 'years', 'days', 'updatedAt'],
    path,
  );
  if (!Array.isArray(data.links)) fail(`${path}.links`, 'an array');
  if (!Array.isArray(data.years)) fail(`${path}.years`, 'an array');
  if (!Array.isArray(data.days)) fail(`${path}.days`, 'an array');
  return {
    username,
    uid: nonEmptyString(data.uid, `${path}.uid`),
    public: boolean(data.public, `${path}.public`),
    givenName: string(data.givenName, `${path}.givenName`),
    familyName: string(data.familyName, `${path}.familyName`),
    links: data.links.map((entry, index) => profileLink(entry, `${path}.links[${index}]`)),
    stats: profileStats(data.stats, `${path}.stats`),
    records: profileRecords(data.records, `${path}.records`),
    years: data.years.map((entry, index) => profileYear(entry, `${path}.years[${index}]`)),
    days: data.days.map((entry, index) => profileDay(entry, `${path}.days[${index}]`)),
    updatedAt: timestamp(data.updatedAt, `${path}.updatedAt`),
  };
}

// The /profiles/<username>.json projection served by the publicweb
// function. Same field decoders as the Firestore document, but no uid (the
// endpoint never sends one) and an ISO updatedAt.
export function decodeProfileView(value: unknown, path: string): ProfileView {
  const data = record(value, path);
  exactKeys(
    data,
    ['username', 'givenName', 'familyName', 'links', 'stats', 'records', 'years', 'days', 'updatedAt'],
    path,
  );
  if (!Array.isArray(data.links)) fail(`${path}.links`, 'an array');
  if (!Array.isArray(data.years)) fail(`${path}.years`, 'an array');
  if (!Array.isArray(data.days)) fail(`${path}.days`, 'an array');
  return {
    username: nonEmptyString(data.username, `${path}.username`),
    public: true,
    givenName: string(data.givenName, `${path}.givenName`),
    familyName: string(data.familyName, `${path}.familyName`),
    links: data.links.map((entry, index) => profileLink(entry, `${path}.links[${index}]`)),
    stats: profileStats(data.stats, `${path}.stats`),
    records: profileRecords(data.records, `${path}.records`),
    years: data.years.map((entry, index) => profileYear(entry, `${path}.years[${index}]`)),
    days: data.days.map((entry, index) => profileDay(entry, `${path}.days[${index}]`)),
    updatedAt: isoTimestamp(data.updatedAt, `${path}.updatedAt`),
  };
}

export function profileView(profile: Profile): ProfileView {
  return {
    username: profile.username,
    public: profile.public,
    givenName: profile.givenName,
    familyName: profile.familyName,
    links: profile.links,
    stats: profile.stats,
    records: profile.records,
    years: profile.years,
    days: profile.days,
    updatedAt: profile.updatedAt.toDate().toISOString(),
  };
}

export function decodeProfileDiscovery(value: unknown, path: string): ProfileDiscovery {
  const data = record(value, path);
  exactKeys(data, ['uid', 'createdAt'], path);
  return {
    uid: nonEmptyString(data.uid, `${path}.uid`),
    createdAt: timestamp(data.createdAt, `${path}.createdAt`),
  };
}

export function decodeUser(value: unknown, path: string): UserDocument {
  const data = record(value, path);
  const togglValue = data.toggl;
  if (togglValue === undefined) {
    return {
      uid: nonEmptyString(data.uid, `${path}.uid`),
      email: nonEmptyString(data.email, `${path}.email`),
    };
  }
  const toggl = record(togglValue, `${path}.toggl`);
  return {
    uid: nonEmptyString(data.uid, `${path}.uid`),
    email: nonEmptyString(data.email, `${path}.email`),
    toggl: {
      workspaceId: integer(toggl.workspaceId, `${path}.toggl.workspaceId`),
      projectId: integer(toggl.projectId, `${path}.toggl.projectId`),
      connectedAt: timestamp(toggl.connectedAt, `${path}.toggl.connectedAt`),
    },
  };
}

export function decodeBookUpdate(id: string, value: unknown, path: string): BookUpdate {
  const data = record(value, path);
  const type = string(data.type, `${path}.type`);
  const createdAt = timestamp(data.createdAt, `${path}.createdAt`);
  const shared = {
    id,
    owner: reference(data.owner, `${path}.owner`),
    book: reference(data.book, `${path}.book`),
    fromPage: number(data.fromPage, `${path}.fromPage`),
    toPage: number(data.toPage, `${path}.toPage`),
    pagesRead: number(data.pagesRead, `${path}.pagesRead`),
    createdAt,
    updatedAt: data.updatedAt === undefined
      ? createdAt
      : timestamp(data.updatedAt, `${path}.updatedAt`),
  };
  if (shared.pagesRead !== shared.toPage - shared.fromPage) {
    fail(`${path}.pagesRead`, 'toPage - fromPage');
  }
  if (type === 'reading') {
    return { ...shared, type, timeRead: number(data.timeRead, `${path}.timeRead`) };
  }
  if (type === 'update') return { ...shared, type };
  return fail(`${path}.type`, 'reading or update');
}

export function decodeReadingSession(id: string, value: unknown, path: string): ReadingSession {
  const decoded = decodeBookUpdate(id, value, path);
  if (decoded.type !== 'reading') fail(path, 'a reading session');
  return decoded;
}

export function decodeQueueSweepItem(
  id: string,
  value: unknown,
  path: string,
): QueueSweepItem {
  const data = record(value, path);
  const type = data.type;
  if (type !== 'create' && type !== 'stop') fail(`${path}.type`, 'create or stop');
  const status = data.status;
  if (status !== 'pending' && status !== 'processing' && status !== 'error' && status !== 'outcome-unknown') {
    fail(`${path}.status`, 'pending, processing, error, or outcome-unknown');
  }
  exactKeys(
    data,
    [
      'type', 'bookTitle', 'start', 'stop', 'status', 'createdAt',
      'bookId',
      'timerClaimVersion',
      'attempts', 'claimedAt', 'expiresAt', 'retryRequestedAt', 'error',
      'deferredUntil', 'deferrals',
      ...(type === 'stop' ? ['entryId'] : []),
    ],
    path,
  );
  const attempts = data.attempts === undefined ? 0 : integer(data.attempts, `${path}.attempts`);
  if (attempts < 0) fail(`${path}.attempts`, 'a non-negative integer');
  const claimedAt = data.claimedAt === undefined ? null : timestamp(data.claimedAt, `${path}.claimedAt`);
  if (data.expiresAt !== undefined) timestamp(data.expiresAt, `${path}.expiresAt`);
  // Older Functions builds stored unsliced response bodies. They are
  // immutable to the client and disappear on the next successful claim.
  const error = data.error === undefined
    ? null
    : string(data.error, `${path}.error`).slice(0, 1000);
  const retryRequestedAt = data.retryRequestedAt === undefined
    ? null
    : timestamp(data.retryRequestedAt, `${path}.retryRequestedAt`);
  const deferredUntil = data.deferredUntil === undefined
    ? null
    : timestamp(data.deferredUntil, `${path}.deferredUntil`);
  if (deferredUntil !== null && status !== 'pending') {
    fail(path, 'a deferral only on a pending queue item');
  }
  const deferrals = data.deferrals === undefined ? 0 : integer(data.deferrals, `${path}.deferrals`);
  if (deferrals < 0) fail(`${path}.deferrals`, 'a non-negative integer');
  const bookId = data.bookId === undefined
    ? undefined
    : boundedString(data.bookId, `${path}.bookId`, 500);
  if (bookId === '.' || bookId === '..' || bookId?.includes('/')) {
    fail(`${path}.bookId`, 'one Firestore document id');
  }
  if (data.timerClaimVersion !== undefined && data.timerClaimVersion !== 1) {
    fail(`${path}.timerClaimVersion`, '1 or absent');
  }
  const shared: Omit<QueueBase, 'status'> = {
    id,
    ...(bookId === undefined ? {} : { bookId }),
    ...(data.timerClaimVersion === undefined ? {} : { timerClaimVersion: 1 as const }),
    bookTitle: boundedString(data.bookTitle, `${path}.bookTitle`, 500),
    start: isoTimestamp(data.start, `${path}.start`),
    stop: isoTimestamp(data.stop, `${path}.stop`),
    createdAt: timestamp(data.createdAt, `${path}.createdAt`),
    attempts,
    claimedAt,
    error,
    retryRequestedAt,
    deferredUntil,
    deferrals,
  };
  if (status === 'pending') {
    if (attempts === 0 && (
      data.attempts !== undefined || claimedAt !== null || error !== null
    )) {
      fail(path, 'an initial pending queue item without claim metadata');
    }
    if (attempts > 0 && claimedAt === null) {
      fail(path, 'a retried pending queue item with claim metadata');
    }
    // Legacy clients requeued by changing only status, so pending rows with
    // claim metadata may legitimately predate retryRequestedAt.
  } else {
    if (attempts === 0 || claimedAt === null) {
      fail(path, `${status} with claim metadata`);
    }
    if (retryRequestedAt !== null) fail(path, `${status} without retryRequestedAt`);
    // Old claims did not delete a prior error. A stale processing row can
    // therefore retain one until this sweep requeues it.
    if ((status === 'error' || status === 'outcome-unknown') && error === null) {
      fail(path, `${status} with an error`);
    }
  }
  if (type === 'create') {
    return { ...shared, type, status };
  }
  if (status === 'outcome-unknown') return fail(path, 'outcome-unknown only for a create operation');
  const entryId = integer(data.entryId, `${path}.entryId`);
  if (entryId <= 0) fail(`${path}.entryId`, 'a positive integer');
  return { ...shared, type, entryId, status };
}

export interface QueueSweepCandidate {
  id: string;
  value: unknown;
  path: string;
}

export function decodeQueueSweepBatch(candidates: readonly QueueSweepCandidate[]): {
  items: QueueSweepItem[];
  invalidIds: string[];
} {
  const items: QueueSweepItem[] = [];
  const invalidIds: string[] = [];
  for (const candidate of candidates) {
    try {
      items.push(decodeQueueSweepItem(candidate.id, candidate.value, candidate.path));
    } catch (error) {
      if (!(error instanceof DataDecodeError)) throw error;
      invalidIds.push(candidate.id);
    }
  }
  return { items, invalidIds };
}

export function decodeLiveQueueSweepItem(
  id: string,
  value: unknown,
  path: string,
): QueueSweepItem | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const status = (value as Data).status;
  if (status !== 'pending' && status !== 'processing' &&
      status !== 'error' && status !== 'outcome-unknown') return null;
  return decodeQueueSweepBatch([{ id, value, path }]).items[0] ?? null;
}
