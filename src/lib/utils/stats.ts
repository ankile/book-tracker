import type { LibraryStats } from '../interfaces/analytics.ts';
import type { TimestampLike } from '../interfaces/common.ts';
import type {
  ProfileDay,
  ProfilePayload,
  ProfileRecords,
} from '../interfaces/profile.ts';
import type { BookUpdateView } from '../interfaces/reading.ts';
import { finishedDateOf } from './finished.ts';

export interface StatsBookView {
  id?: string;
  finished: boolean;
  finishedAt: TimestampLike | null;
  timeRead: number;
  pagesRead: number;
  createdAt: TimestampLike;
}

export interface YearBookView extends StatsBookView {
  pageCount: number;
  authorIds: readonly string[];
}

export interface BooksByYearRow<T extends YearBookView = YearBookView> {
  year: string;
  count: number;
  totalTimeRead: number;
  totalPages: number;
  longestBook: T;
  shortestBook: T;
  uniqueAuthors: number;
  newAuthors: number;
}

export function computeStats(allBooks: readonly StatsBookView[]): LibraryStats {
  const finishedBooks = allBooks.filter((book) => book.finished);
  const readingBooks = allBooks.filter((book) => !book.finished);
  const totalTimeRead = allBooks.reduce((sum, book) => sum + book.timeRead, 0);
  const totalPagesRead = allBooks.reduce((sum, book) => sum + book.pagesRead, 0);

  const finishedDates = finishedBooks
    .map(finishedDateOf)
    .sort((a, b) => a.getTime() - b.getTime());
  const addedDates = allBooks
    .map((book) => book.createdAt.toDate())
    .sort((a, b) => a.getTime() - b.getTime());

  let booksPerYear: number | string = 0;
  const firstFinished = finishedDates[0];
  if (firstFinished !== undefined) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yearsSinceFirst = Math.max(
      (today.getTime() - firstFinished.getTime()) / (1000 * 60 * 60 * 24 * 365),
      1 / 12,
    );
    booksPerYear = (finishedBooks.length / yearsSinceFirst).toFixed(1);
  }

  const avgTimePerBook = finishedBooks.length > 0
    ? Math.round(
        finishedBooks.reduce((sum, book) => sum + book.timeRead, 0)
          / finishedBooks.length,
      )
    : 0;

  return {
    totalBooks: allBooks.length,
    finishedBooks: finishedBooks.length,
    readingBooks: readingBooks.length,
    totalTimeRead,
    totalTimeReadHours: Math.round(totalTimeRead / 60),
    totalPagesRead,
    booksPerYear,
    avgTimePerBook,
    firstFinishedAt: firstFinished ?? null,
    lastFinishedAt: finishedDates.at(-1) ?? null,
    firstBookAddedAt: addedDates[0] ?? null,
  };
}

interface YearAccumulator<T extends YearBookView> {
  count: number;
  totalTimeRead: number;
  totalPages: number;
  longestBook: T;
  shortestBook: T;
  authorIds: Set<string>;
}

export function computeBooksByYear<T extends YearBookView>(
  allBooks: readonly T[],
): BooksByYearRow<T>[] {
  const yearData = new Map<number, YearAccumulator<T>>();

  for (const book of allBooks.filter((candidate) => candidate.finished)) {
    const year = finishedDateOf(book).getFullYear();
    let data = yearData.get(year);
    if (data === undefined) {
      data = {
        count: 0,
        totalTimeRead: 0,
        totalPages: 0,
        longestBook: book,
        shortestBook: book,
        authorIds: new Set<string>(),
      };
      yearData.set(year, data);
    }

    data.count += 1;
    data.totalTimeRead += book.timeRead;
    data.totalPages += book.pagesRead;
    for (const id of book.authorIds) data.authorIds.add(id);
    if (book.pageCount > data.longestBook.pageCount) data.longestBook = book;
    if (book.pageCount < data.shortestBook.pageCount) data.shortestBook = book;
  }

  const seenAuthors = new Set<string>();
  const newAuthorsByYear = new Map<number, number>();
  for (const year of [...yearData.keys()].sort((a, b) => a - b)) {
    const data = yearData.get(year);
    if (data === undefined) throw new Error(`Missing accumulator for year ${year}.`);
    let newAuthors = 0;
    for (const id of data.authorIds) {
      if (seenAuthors.has(id)) continue;
      seenAuthors.add(id);
      newAuthors += 1;
    }
    newAuthorsByYear.set(year, newAuthors);
  }

  return [...yearData.entries()]
    .sort(([a], [b]) => b - a)
    .map(([year, data]) => ({
      year: String(year),
      count: data.count,
      totalTimeRead: data.totalTimeRead,
      totalPages: data.totalPages,
      longestBook: data.longestBook,
      shortestBook: data.shortestBook,
      uniqueAuthors: data.authorIds.size,
      newAuthors: newAuthorsByYear.get(year) ?? 0,
    }));
}

export const DAY_BOUNDARY_OFFSET_HOURS = 3;

export function dayKeyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function shiftedDay(date: Date): Date {
  const shifted = new Date(date);
  shifted.setHours(shifted.getHours() - DAY_BOUNDARY_OFFSET_HOURS);
  return shifted;
}

export function aggregateSessionsByDay(
  sessions: readonly BookUpdateView[],
): ProfileDay[] {
  const dayMap = new Map<string, ProfileDay>();

  for (const session of sessions) {
    if (session.type !== 'reading') continue;
    const timestamp = session.createdAt.toDate();
    const day = dayKeyOf(shiftedDay(timestamp));
    let entry = dayMap.get(day);
    if (entry === undefined) {
      entry = { day, pagesRead: 0, timeRead: 0, sessions: 0 };
      dayMap.set(day, entry);
    }
    entry.pagesRead += session.pagesRead;
    entry.timeRead += session.timeRead;
    entry.sessions += 1;
  }

  return [...dayMap.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

export const USERNAME_PATTERN = /^[a-z0-9-]{3,30}$/;
export const PROFILE_MAX_DAYS = 4000;

export function buildProfilePayload<T extends YearBookView>(
  allBooks: readonly T[],
  sessionDays: readonly ProfileDay[] = [],
  records: ProfileRecords | null = null,
): ProfilePayload {
  const stats = computeStats(allBooks);
  const authors = new Set(allBooks.flatMap((book) => [...book.authorIds])).size;
  return {
    days: sessionDays.slice(-PROFILE_MAX_DAYS),
    stats: {
      totalBooks: stats.totalBooks,
      finishedBooks: stats.finishedBooks,
      readingBooks: stats.readingBooks,
      totalTimeReadHours: stats.totalTimeReadHours,
      totalPagesRead: stats.totalPagesRead,
      booksPerYear: Number(stats.booksPerYear),
      avgTimePerBook: stats.avgTimePerBook,
      authors,
    },
    records,
    years: computeBooksByYear(allBooks).map(
      ({ year, count, totalTimeRead, totalPages }) => ({
        year: Number(year),
        count,
        hours: Math.round(totalTimeRead / 60),
        pages: totalPages,
      }),
    ),
  };
}

export function profilePayloadEqual(
  published: unknown,
  payload: ProfilePayload,
): boolean {
  if (!isRecord(published)) return false;
  const stats = published.stats;
  const years = published.years;
  const days = published.days;
  if (!isRecord(stats) || !Array.isArray(years) || !Array.isArray(days)) return false;

  const expectedStats = payload.stats;
  if (
    stats.totalBooks !== expectedStats.totalBooks
    || stats.finishedBooks !== expectedStats.finishedBooks
    || stats.readingBooks !== expectedStats.readingBooks
    || stats.totalTimeReadHours !== expectedStats.totalTimeReadHours
    || stats.totalPagesRead !== expectedStats.totalPagesRead
    || stats.booksPerYear !== expectedStats.booksPerYear
    || stats.avgTimePerBook !== expectedStats.avgTimePerBook
    || stats.authors !== expectedStats.authors
    || JSON.stringify(published.records ?? null) !== JSON.stringify(payload.records)
    || years.length !== payload.years.length
    || days.length !== payload.days.length
  ) {
    return false;
  }

  const yearsEqual = payload.years.every((expected, index) => {
    const actual = years[index];
    return isRecord(actual)
      && actual.year === expected.year
      && actual.count === expected.count
      && actual.hours === expected.hours
      && actual.pages === expected.pages;
  });
  if (!yearsEqual) return false;

  return payload.days.every((expected, index) => {
    const actual = days[index];
    return isRecord(actual)
      && actual.day === expected.day
      && actual.pagesRead === expected.pagesRead
      && actual.timeRead === expected.timeRead
      && actual.sessions === expected.sessions;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
