// The allowlists and byte caps of firestore.rules (validBookShape,
// validBookTitle, validAuthorShape, validProfileOwnerRecord, and the key
// set and list caps of validProfile), mirrored for the read-only audit so a
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
  'currentPage', 'currentPageUpdateId', 'fiction', 'finished', 'isbn',
  'owner', 'pageCount', 'pagesRead', 'timeRead', 'publishedDate',
  'publisher', 'subjects', 'title', 'updatedAt',
] as const;

export const AUTHOR_FIELDS = [
  'name', 'nameLower', 'kind', 'givenName', 'familyName', 'retirement', 'updatedAt',
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
  if ('authorIds' in book) v.push(...stringListViolations('authorIds', book.authorIds, 50, 5000));
  if ('coverUrl' in book) v.push(...cappedString('coverUrl', book.coverUrl, 2048));
  if ('publisher' in book) v.push(...cappedString('publisher', book.publisher, 500));
  if ('publishedDate' in book) v.push(...cappedString('publishedDate', book.publishedDate, 64));
  if ('subjects' in book) v.push(...stringListViolations('subjects', book.subjects, 25, 2500));
  if ('fiction' in book && book.fiction !== null && typeof book.fiction !== 'boolean') v.push('fiction.not-bool');
  if ('isbn' in book) v.push(...cappedString('isbn', book.isbn, 32));
  if ('owner' in book && !(isDocumentReference(book.owner) && book.owner.path === ownerPath)) v.push('owner.not-self');
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

// validAuthorShape.
export function authorShapeViolations(author: Record<string, unknown>): string[] {
  const v: string[] = unknownKeys(author, AUTHOR_FIELDS);
  if (typeof author.name !== 'string' || author.name.length === 0) v.push('name.not-string');
  else if (author.name.length > 200) v.push('name.size>200');
  if ('nameLower' in author) v.push(...cappedString('nameLower', author.nameLower, 200));
  if ('kind' in author && !['person', 'entity', 'placeholder'].includes(author.kind as string)) v.push('kind.unknown');
  if ('givenName' in author) v.push(...cappedString('givenName', author.givenName, 100));
  if ('familyName' in author) v.push(...cappedString('familyName', author.familyName, 100));
  if ('updatedAt' in author && !isTimestamp(author.updatedAt)) v.push('updatedAt.not-timestamp');
  if ('retirement' in author) {
    const retirement = author.retirement;
    if (!isMap(retirement)) v.push('retirement.not-map');
    else {
      v.push(...unknownKeys(retirement, ['reason', 'targetId']).map((k) => `retirement.${k}`));
      if (!['deleted', 'merged'].includes(retirement.reason as string)) v.push('retirement.reason.unknown');
      if ('targetId' in retirement) v.push(...cappedString('retirement.targetId', retirement.targetId, 100));
    }
  }
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
