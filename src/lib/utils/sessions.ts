import type {
  AuthorLeaderboardRow,
  BookTimeline,
  HourBucket,
  MonthlyAggregate,
  Superlatives,
  WeekdayBucket,
} from '../interfaces/analytics.ts';
import type { AuthorSummary } from '../interfaces/author.ts';
import type { TimestampLike } from '../interfaces/common.ts';
import type { Momentum } from '../interfaces/profile.ts';
import type {
  BookUpdateView,
  ReadingUpdateView,
} from '../interfaces/reading.ts';
import { dayKeyOf, shiftedDay } from './stats.ts';

export const SPEED_MIN_SESSION_MINUTES = 5;
export const SPEED_MAX_PAGES_PER_HOUR = 150;
export const BOOK_SPEED_MIN_MINUTES = 60;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface FinishedBookView {
  id: string;
  finished: boolean;
}

export interface SuperlativeBookView extends FinishedBookView {
  title: string;
  pageCount: number;
}

export interface DustyBookView extends FinishedBookView {
  title: string;
  currentPage: number;
  pageCount: number;
  updatedAt: TimestampLike;
}

export interface ProjectionBookView extends FinishedBookView {
  title: string;
  currentPage: number;
  pageCount: number;
  pagesRead: number;
  timeRead: number;
}

export interface LeaderboardBookView extends FinishedBookView {
  authorIds: readonly string[];
  pagesRead: number;
  timeRead: number;
}

export interface DustyShelfRow {
  title: string;
  lastActivityAt: Date;
  daysSince: number;
  percentComplete: number;
}

export interface FinishProjection {
  title: string;
  remainingPages: number;
  percentComplete: number;
  projectedDate: Date | null;
}

function sessionDate(session: BookUpdateView): Date {
  return session.createdAt.toDate();
}

function isReading(session: BookUpdateView): session is ReadingUpdateView {
  return session.type === 'reading';
}

export function qualifiesForSpeed(session: BookUpdateView): boolean {
  if (!isReading(session)) return false;
  const minutes = session.timeRead;
  const pages = session.pagesRead;
  if (minutes < SPEED_MIN_SESSION_MINUTES || pages < 0) return false;
  return pages / (minutes / 60) <= SPEED_MAX_PAGES_PER_HOUR;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) throw new Error('Median index is outside the sorted values.');
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1];
  if (lower === undefined) throw new Error('Median lower index is outside the sorted values.');
  return (lower + upper) / 2;
}

function calendarDaySpan(firstAt: Date, lastAt: Date): number {
  const first = shiftedDay(firstAt);
  const last = shiftedDay(lastAt);
  const firstMidnight = new Date(first.getFullYear(), first.getMonth(), first.getDate());
  const lastMidnight = new Date(last.getFullYear(), last.getMonth(), last.getDate());
  return Math.round((lastMidnight.getTime() - firstMidnight.getTime()) / MS_PER_DAY) + 1;
}

interface TimelineAccumulator {
  firstAt: Date;
  lastAt: Date;
  activeDayKeys: Set<string>;
  totalMinutes: number;
  totalPages: number;
  sessionCount: number;
}

export function buildBookTimelines(
  sessions: readonly BookUpdateView[],
): Map<string, BookTimeline> {
  const accumulators = new Map<string, TimelineAccumulator>();

  for (const session of sessions) {
    const date = sessionDate(session);
    const bookId = session.book.id;

    let timeline = accumulators.get(bookId);
    if (timeline === undefined) {
      timeline = {
        firstAt: date,
        lastAt: date,
        activeDayKeys: new Set<string>(),
        totalMinutes: 0,
        totalPages: 0,
        sessionCount: 0,
      };
      accumulators.set(bookId, timeline);
    }
    if (date.getTime() < timeline.firstAt.getTime()) timeline.firstAt = date;
    if (date.getTime() > timeline.lastAt.getTime()) timeline.lastAt = date;
    timeline.activeDayKeys.add(dayKeyOf(shiftedDay(date)));
    timeline.totalMinutes += session.type === 'reading' ? session.timeRead : 0;
    timeline.totalPages += session.pagesRead;
    timeline.sessionCount += 1;
  }

  return new Map(
    [...accumulators].map(([bookId, timeline]) => [bookId, {
      firstAt: timeline.firstAt,
      lastAt: timeline.lastAt,
      activeDays: timeline.activeDayKeys.size,
      totalMinutes: timeline.totalMinutes,
      totalPages: timeline.totalPages,
      sessionCount: timeline.sessionCount,
    }]),
  );
}

export function finishedAtByBook(
  allBooks: readonly FinishedBookView[],
  timelines: ReadonlyMap<string, BookTimeline>,
): Map<string, Date> {
  const finishedAt = new Map<string, Date>();
  for (const book of allBooks) {
    const timeline = timelines.get(book.id);
    if (book.finished && timeline !== undefined) finishedAt.set(book.id, timeline.lastAt);
  }
  return finishedAt;
}

interface MonthlyAccumulator {
  month: string;
  pages: number;
  minutes: number;
  sessions: number;
  bookIds: Set<string>;
  speedPages: number;
  speedMinutes: number;
}

export function monthlyAggregates(
  sessions: readonly BookUpdateView[],
): MonthlyAggregate[] {
  const byMonth = new Map<string, MonthlyAccumulator>();

  for (const session of sessions.filter(isReading)) {
    const date = session.createdAt.toDate();
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    let entry = byMonth.get(monthKey);
    if (entry === undefined) {
      entry = {
        month: monthKey,
        pages: 0,
        minutes: 0,
        sessions: 0,
        bookIds: new Set<string>(),
        speedPages: 0,
        speedMinutes: 0,
      };
      byMonth.set(monthKey, entry);
    }
    entry.pages += session.pagesRead;
    entry.minutes += session.timeRead;
    entry.sessions += 1;
    entry.bookIds.add(session.book.id);
    if (qualifiesForSpeed(session)) {
      entry.speedPages += session.pagesRead;
      entry.speedMinutes += session.timeRead;
    }
  }

  const monthKeys = [...byMonth.keys()].sort();
  const firstKey = monthKeys[0];
  const lastKey = monthKeys.at(-1);
  if (firstKey === undefined || lastKey === undefined) return [];
  const firstYear = Number(firstKey.slice(0, 4));
  const firstMonth = Number(firstKey.slice(5));
  const lastYear = Number(lastKey.slice(0, 4));
  const lastMonth = Number(lastKey.slice(5));

  const months: MonthlyAggregate[] = [];
  for (
    let year = firstYear, month = firstMonth;
    year < lastYear || (year === lastYear && month <= lastMonth);
  ) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const entry = byMonth.get(key);
    months.push({
      month: key,
      label: new Date(year, month - 1, 1).toLocaleDateString('en-US', {
        month: 'short',
        year: 'numeric',
      }),
      year,
      pages: entry?.pages ?? 0,
      minutes: entry?.minutes ?? 0,
      sessions: entry?.sessions ?? 0,
      books: entry?.bookIds.size ?? 0,
      pagesPerHour:
        entry !== undefined && entry.speedMinutes >= 60
          ? entry.speedPages / (entry.speedMinutes / 60)
          : null,
    });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

export function lifetimePagesPerHour(sessions: readonly BookUpdateView[]): number | null {
  let pages = 0;
  let minutes = 0;
  for (const session of sessions.filter(qualifiesForSpeed)) {
    pages += session.pagesRead;
    minutes += session.type === 'reading' ? session.timeRead : 0;
  }
  return minutes >= 60 ? pages / (minutes / 60) : null;
}

interface SpeedBucketAccumulator {
  minutes: number;
  sessions: number;
  speedPages: number;
  speedMinutes: number;
}

export function minutesByHour(sessions: readonly BookUpdateView[]): HourBucket[] {
  const hours: (SpeedBucketAccumulator & { hour: number })[] = Array.from(
    { length: 24 },
    (_, hour) => ({ hour, minutes: 0, sessions: 0, speedPages: 0, speedMinutes: 0 }),
  );

  for (const session of sessions.filter(isReading)) {
    const entry = hours[session.createdAt.toDate().getHours()];
    if (entry === undefined) throw new Error('Session hour is outside 0..23.');
    entry.minutes += session.timeRead;
    entry.sessions += 1;
    if (qualifiesForSpeed(session)) {
      entry.speedPages += session.pagesRead;
      entry.speedMinutes += session.timeRead;
    }
  }

  return hours.map(({ hour, minutes, sessions: count, speedPages, speedMinutes }) => ({
    hour,
    minutes,
    sessions: count,
    pagesPerHour: speedMinutes >= 60 ? speedPages / (speedMinutes / 60) : null,
  }));
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export function minutesByWeekday(sessions: readonly BookUpdateView[]): WeekdayBucket[] {
  const weekdays: (SpeedBucketAccumulator & { label: string })[] = WEEKDAY_LABELS.map(
    (label) => ({ label, minutes: 0, sessions: 0, speedPages: 0, speedMinutes: 0 }),
  );

  for (const session of sessions.filter(isReading)) {
    const index = (shiftedDay(session.createdAt.toDate()).getDay() + 6) % 7;
    const entry = weekdays[index];
    if (entry === undefined) throw new Error('Shifted weekday is outside 0..6.');
    entry.minutes += session.timeRead;
    entry.sessions += 1;
    if (qualifiesForSpeed(session)) {
      entry.speedPages += session.pagesRead;
      entry.speedMinutes += session.timeRead;
    }
  }

  return weekdays.map(({ label, minutes, sessions: count, speedPages, speedMinutes }) => ({
    label,
    minutes,
    sessions: count,
    pagesPerHour: speedMinutes >= 60 ? speedPages / (speedMinutes / 60) : null,
  }));
}

export function computeMomentum(
  sessions: readonly BookUpdateView[],
  now: Date,
): Momentum | null {
  const reading = sessions.filter(isReading);
  if (reading.length === 0) return null;
  const first = reading[0];
  if (first === undefined) throw new Error('A nonempty reading list lost its first item.');

  const firstAt = reading.reduce(
    (earliest, session) => {
      const date = session.createdAt.toDate();
      return date.getTime() < earliest.getTime() ? date : earliest;
    },
    first.createdAt.toDate(),
  );
  const lifetimeDays = Math.max(1, (now.getTime() - firstAt.getTime()) / MS_PER_DAY);
  const lifetimePages = reading.reduce((sum, session) => sum + session.pagesRead, 0);

  const windowStart = new Date(now.getTime() - 30 * MS_PER_DAY);
  const recentPages = reading
    .filter((session) => session.createdAt.toDate().getTime() >= windowStart.getTime())
    .reduce((sum, session) => sum + session.pagesRead, 0);

  const lifetimePagesPerDay = lifetimePages / lifetimeDays;
  const recentPagesPerDay = recentPages / Math.min(30, lifetimeDays);
  return {
    recentPagesPerDay,
    lifetimePagesPerDay,
    ratio: lifetimePagesPerDay > 0 ? recentPagesPerDay / lifetimePagesPerDay : null,
  };
}

export function computeSuperlatives(
  sessions: readonly BookUpdateView[],
  allBooks: readonly SuperlativeBookView[],
  timelines: ReadonlyMap<string, BookTimeline>,
): Superlatives | null {
  const reading = sessions.filter(isReading);
  if (reading.length === 0) return null;

  const pagesByDay = new Map<string, number>();
  for (const session of reading) {
    const day = dayKeyOf(shiftedDay(session.createdAt.toDate()));
    pagesByDay.set(day, (pagesByDay.get(day) ?? 0) + session.pagesRead);
  }
  let biggestDay: Superlatives['biggestDay'] = null;
  for (const [day, pages] of pagesByDay) {
    if (biggestDay === null || pages > biggestDay.pages) biggestDay = { day, pages };
  }

  const titleById = new Map(allBooks.map((book) => [book.id, book.title]));
  let longestSession: Superlatives['longestSession'] = null;
  for (const session of reading) {
    const minutes = session.timeRead;
    if (longestSession === null || minutes > longestSession.minutes) {
      longestSession = {
        minutes,
        title: titleById.get(session.book.id) ?? null,
        date: session.createdAt.toDate(),
      };
    }
  }

  const medianSessionMinutes = median(reading.map((session) => session.timeRead));
  let fastestFinish: Superlatives['fastestFinish'] = null;
  for (const book of allBooks.filter((candidate) => candidate.finished)) {
    const timeline = timelines.get(book.id);
    if (timeline === undefined || timeline.sessionCount < 2) continue;
    const days = calendarDaySpan(timeline.firstAt, timeline.lastAt);
    if (fastestFinish === null || days < fastestFinish.days) {
      fastestFinish = { title: book.title, days, pageCount: book.pageCount };
    }
  }

  return { biggestDay, longestSession, medianSessionMinutes, fastestFinish };
}

export function daysToFinishSummary(
  allBooks: readonly FinishedBookView[],
  timelines: ReadonlyMap<string, BookTimeline>,
): { count: number; medianDays: number; medianActiveDays: number } | null {
  const spans: number[] = [];
  const activeDays: number[] = [];
  for (const book of allBooks.filter((candidate) => candidate.finished)) {
    const timeline = timelines.get(book.id);
    if (timeline === undefined || timeline.sessionCount < 2) continue;
    spans.push(calendarDaySpan(timeline.firstAt, timeline.lastAt));
    activeDays.push(timeline.activeDays);
  }
  if (spans.length === 0) return null;
  return {
    count: spans.length,
    medianDays: median(spans),
    medianActiveDays: median(activeDays),
  };
}

export function dustyShelf(
  allBooks: readonly DustyBookView[],
  timelines: ReadonlyMap<string, BookTimeline>,
  now: Date,
): DustyShelfRow[] {
  return allBooks
    .filter((book) => !book.finished)
    .map((book) => {
      const lastActivityAt = timelines.get(book.id)?.lastAt ?? book.updatedAt.toDate();
      return {
        title: book.title,
        lastActivityAt,
        daysSince: Math.floor((now.getTime() - lastActivityAt.getTime()) / MS_PER_DAY),
        percentComplete:
          book.pageCount > 0 ? Math.round((book.currentPage / book.pageCount) * 100) : 0,
      };
    })
    .sort((a, b) => b.daysSince - a.daysSince);
}

export function completionRate(
  allBooks: readonly FinishedBookView[],
  timelines: ReadonlyMap<string, BookTimeline>,
): number | null {
  const started = allBooks.filter((book) => timelines.has(book.id));
  if (started.length === 0) return null;
  return started.filter((book) => book.finished).length / started.length;
}

export function projectedFinishes(
  allBooks: readonly ProjectionBookView[],
  timelines: ReadonlyMap<string, BookTimeline>,
  sessions: readonly BookUpdateView[],
  now: Date,
): FinishProjection[] {
  const windowStart = new Date(now.getTime() - 30 * MS_PER_DAY);
  const recentMinutes = sessions
    .filter(isReading)
    .filter((session) => session.createdAt.toDate().getTime() >= windowStart.getTime())
    .reduce((sum, session) => sum + session.timeRead, 0);
  const minutesPerDay = recentMinutes / 30;

  const projections = allBooks
    .filter((book) => !book.finished)
    .map((book): FinishProjection => {
      const timeline = timelines.get(book.id);
      const remainingPages = Math.max(0, book.pageCount - book.currentPage);
      const active = timeline !== undefined
        && (now.getTime() - timeline.lastAt.getTime()) / MS_PER_DAY <= 60;
      const pagesRead = book.pagesRead;
      const timeRead = book.timeRead;
      const pagesPerMinute = timeRead > 0 ? pagesRead / timeRead : 0;
      const projectable = active && minutesPerDay > 0 && pagesPerMinute > 0;
      return {
        title: book.title,
        remainingPages,
        percentComplete:
          book.pageCount > 0 ? Math.round((book.currentPage / book.pageCount) * 100) : 0,
        projectedDate: projectable
          ? new Date(
              now.getTime()
                + (remainingPages / (pagesPerMinute * minutesPerDay)) * MS_PER_DAY,
            )
          : null,
      };
    });

  return projections.sort((a, b) => {
    if (a.projectedDate !== null && b.projectedDate !== null) {
      return a.projectedDate.getTime() - b.projectedDate.getTime();
    }
    if (a.projectedDate !== null) return -1;
    if (b.projectedDate !== null) return 1;
    return 0;
  });
}

export function authorLeaderboard(
  allBooks: readonly LeaderboardBookView[],
  authors: readonly AuthorSummary[],
): AuthorLeaderboardRow[] {
  const nameById = new Map(authors.map((author) => [author.id, author.name]));
  const rows = new Map<string, AuthorLeaderboardRow>();

  for (const book of allBooks) {
    for (const authorId of book.authorIds) {
      const name = nameById.get(authorId);
      // Books and authors use independent listeners. On a cold load the
      // books snapshot can arrive first, so unresolved ids are loading,
      // not corrupt data. The next authors snapshot recomputes the rows.
      if (name === undefined) continue;
      let row = rows.get(authorId);
      if (row === undefined) {
        row = { name, books: 0, finishedBooks: 0, pages: 0, minutes: 0 };
        rows.set(authorId, row);
      }
      row.books += 1;
      if (book.finished) row.finishedBooks += 1;
      row.pages += book.pagesRead;
      row.minutes += book.timeRead;
    }
  }

  return [...rows.values()].sort((a, b) => b.minutes - a.minutes);
}
