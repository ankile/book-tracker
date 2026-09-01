// The allowlists and byte caps of firestore.rules (validBookShape,
// validBookTitle, validProfileOwnerRecord, and the key set and list caps of
// validProfile), mirrored for the read-only audit so a
// stored document that the rules would reject on its next client edit is
// visible in the drift report before a user hits the denial. The mirror is
// agreement-tested against the emulator in tests/firestore-rules.test.ts:
// every fixture the rules deny yields a violation here and every fixture
// they admit yields none. When a cap moves in the rules it moves here.
//
// Values are classified structurally, not with instanceof: the same
// predicate judges Admin-SDK reads (db-audit.ts) and client-SDK fixtures
// (the agreement test), whose Timestamp and DocumentReference classes are
// different types. String sizes are UTF-16 code units, which is what the
// rules' size() counts.

export const BOOK_FIELDS = [
  'activeTimer', 'authorIds', 'coverUrl', 'createdAt',
  'currentPage', 'currentPageUpdateId', 'fiction', 'finished', 'finishedAt', 'isbn',
  'workId', 'editionId', 'matchMethod', 'linkedAt',
  'owner', 'pageCount', 'pagesRead', 'timeRead', 'publishedDate',
  'publisher', 'subjects', 'title', 'updatedAt',
] as const;

export const PROFILE_FIELDS = [
  'uid', 'public', 'givenName', 'familyName', 'links', 'stats', 'records', 'years', 'days', 'updatedAt',
] as const;

export const PROFILE_STAT_KEYS = [
  'totalBooks', 'finishedBooks', 'readingBooks', 'totalTimeReadHours',
  'totalPagesRead', 'booksPerYear', 'avgTimePerBook', 'authors',
] as const;

export const USERNAME_PATTERN = /^[a-z0-9-]{3,30}$/;

function isTimestamp(value: unknown): boolean {
  return typeof value === 'object' && value !== null
    && typeof (value as { seconds?: unknown }).seconds === 'number'
    && typeof (value as { nanoseconds?: unknown }).nanoseconds === 'number'
    && typeof (value as { toMillis?: unknown }).toMillis === 'function';
}

function isDocumentReference(value: unknown): value is { path: string } {
  return typeof value === 'object' && value !== null
    && typeof (value as { path?: unknown }).path === 'string'
    && typeof (value as { withConverter?: unknown }).withConverter === 'function';
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && !isTimestamp(value) && !isDocumentReference(value);
}

// The rules bound string lists with list.join('').size(): strings
// concatenate, numbers are stringified, and any other element type makes
// join() throw, which the rules turn into a denial.
function stringListViolations(
  field: string,
  value: unknown,
  maxItems: number,
  maxJoined: number,
): string[] {
  if (!Array.isArray(value)) return [`${field}.not-list`];
  const violations: string[] = [];
  if (value.length > maxItems) violations.push(`${field}.count>${maxItems}`);
  let joined = 0;
  for (const element of value) {
    if (typeof element === 'string') joined += element.length;
    else if (typeof element === 'number') joined += String(element).length;
    else violations.push(`${field}.element-type`);
  }
  if (joined > maxJoined) violations.push(`${field}.bytes>${maxJoined}`);
  return violations;
}

function cappedString(field: string, value: unknown, max: number): string[] {
  if (typeof value !== 'string') return [`${field}.not-string`];
  return value.length > max ? [`${field}.size>${max}`] : [];
}

function unknownKeys(data: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(data).filter((key) => !allowed.includes(key)).map((key) => `unknown-field:${key}`);
}

// validBookShape + validBookTitle: what a metadata edit (any update that
// is not a pure progress/timer update) must satisfy. Page-state
// invariants (currentPage/pageCount/finished) are audited separately.
export function bookShapeViolations(book: Record<string, unknown>, ownerPath: string): string[] {
  const v: string[] = unknownKeys(book, BOOK_FIELDS);
  if ('updatedAt' in book && !isTimestamp(book.updatedAt)) v.push('updatedAt.not-timestamp');
  // finished <=> finishedAt is a timestamp (validBookFinishedAt).
  if (book.finished === true) {
    if (!isTimestamp(book.finishedAt)) v.push('finishedAt.missing');
  } else if ('finishedAt' in book && book.finishedAt !== null) {
    v.push('finishedAt.unfinished');
  }
  if ('authorIds' in book) {
    // validBookShape caps the stored list at 50, not at the six a fresh
    // authorship write may carry (validBookAuthors): a book the migration
    // left with 7-50 ids can still have its title or page count corrected,
    // so the audit must not report it. When that cap moves in the rules it
    // moves here.
    v.push(...stringListViolations('authorIds', book.authorIds, 50, 5000));
    if (Array.isArray(book.authorIds) &&
        book.authorIds.some((authorId) => typeof authorId !== 'string')) {
      v.push('authorIds.not-strings');
    }
    if (Array.isArray(book.authorIds) &&
        new Set(book.authorIds).size !== book.authorIds.length) {
      v.push('authorIds.duplicates');
    }
  }
  if ('coverUrl' in book) v.push(...cappedString('coverUrl', book.coverUrl, 2048));
  if ('publisher' in book) v.push(...cappedString('publisher', book.publisher, 500));
  if ('publishedDate' in book) v.push(...cappedString('publishedDate', book.publishedDate, 64));
  if ('subjects' in book) v.push(...stringListViolations('subjects', book.subjects, 25, 2500));
  if ('fiction' in book && book.fiction !== null && typeof book.fiction !== 'boolean') v.push('fiction.not-bool');
  if ('isbn' in book) v.push(...cappedString('isbn', book.isbn, 32));
  if ('workId' in book && book.workId !== null) {
    v.push(...cappedString('workId', book.workId, 100));
    if (typeof book.workId === 'string' && (book.workId.length === 0 || book.workId.includes('/'))) {
      v.push('workId.not-document-id');
    }
  }
  if ('editionId' in book && book.editionId !== null) {
    v.push(...cappedString('editionId', book.editionId, 100));
    if (typeof book.editionId === 'string' && (book.editionId.length === 0 || book.editionId.includes('/'))) {
      v.push('editionId.not-document-id');
    }
  }
  if ('matchMethod' in book && book.matchMethod !== null
      && !['isbn', 'external-id', 'catalog-choice', 'migration', 'admin'].includes(book.matchMethod as string)) {
    v.push('matchMethod.unknown');
  }
  if ('linkedAt' in book && book.linkedAt !== null && !isTimestamp(book.linkedAt)) {
    v.push('linkedAt.not-timestamp');
  }
  if (!('owner' in book) && book.workId !== undefined && book.workId !== null) v.push('owner.missing-for-link');
  else if ('owner' in book && !(isDocumentReference(book.owner) && book.owner.path === ownerPath)) v.push('owner.not-self');
  if ('createdAt' in book && !isTimestamp(book.createdAt)) v.push('createdAt.not-timestamp');
  if ('pagesRead' in book && !(typeof book.pagesRead === 'number' && book.pagesRead >= 0)) v.push('pagesRead.not-nonnegative-number');
  if ('timeRead' in book && !(typeof book.timeRead === 'number' && book.timeRead >= 0)) v.push('timeRead.not-nonnegative-number');
  if ('currentPageUpdateId' in book && book.currentPageUpdateId !== null) {
    v.push(...cappedString('currentPageUpdateId', book.currentPageUpdateId, 100));
  }
  if (typeof book.title !== 'string' || book.title.length === 0) v.push('title.not-string');
  else if (book.title.length > 500) v.push('title.size>500');
  return v;
}

// validProfileOwnerRecord.
export function profileOwnerRecordViolations(record: Record<string, unknown>): string[] {
  const v: string[] = unknownKeys(record, ['username']);
  if (typeof record.username !== 'string' || !USERNAME_PATTERN.test(record.username)) v.push('username.invalid');
  return v;
}

// validProfile's key set, identity, and caps. The nested records/momentum/
// superlatives shapes are pinned by validProfileRecords in the rules and
// by the client's stats builder; they are not mirrored here.
export function profileShapeViolations(profile: Record<string, unknown>, uid: string): string[] {
  const v: string[] = unknownKeys(profile, PROFILE_FIELDS);
  for (const key of PROFILE_FIELDS) if (!(key in profile)) v.push(`missing-field:${key}`);
  if (profile.uid !== uid) v.push('uid.not-self');
  if (typeof profile.public !== 'boolean') v.push('public.not-bool');
  v.push(...cappedString('givenName', profile.givenName, 50));
  v.push(...cappedString('familyName', profile.familyName, 50));
  if (!Array.isArray(profile.links)) v.push('links.not-list');
  else if (profile.links.length > 10) v.push('links.count>10');
  if (!isMap(profile.stats)) v.push('stats.not-map');
  else {
    v.push(...unknownKeys(profile.stats, PROFILE_STAT_KEYS).map((k) => `stats.${k}`));
    for (const key of PROFILE_STAT_KEYS) {
      if (typeof profile.stats[key] !== 'number') v.push(`stats.${key}.not-number`);
    }
  }
  if (!Array.isArray(profile.years)) v.push('years.not-list');
  else if (profile.years.length > 200) v.push('years.count>200');
  if (!Array.isArray(profile.days)) v.push('days.not-list');
  else if (profile.days.length > 4000) v.push('days.count>4000');
  if (!isTimestamp(profile.updatedAt)) v.push('updatedAt.not-timestamp');
  return v;
}
