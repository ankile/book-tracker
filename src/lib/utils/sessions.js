// Session-level analytics for the Me page: everything here is a pure
// function over the live listeners' plain arrays (sessions across all
// books, the book list, the author list), so it is unit-testable with
// Timestamp stand-ins and shared by nothing that writes.
//
// Sessions are the users/{uid}/books/{id}/updates docs. type 'reading'
// carries timeRead; type 'update' is a page-only correction with no time.
// Page-only updates count toward book timelines and finish dates (an
// update can be what finishes a book) but never toward time or speed.

import { dayKeyOf, shiftedDay } from './stats.js';

// Speed-math guards: a sub-5-minute entry or an implausible pages/hour is
// a data-entry artifact, not a reading pace. Excluded sessions still count
// fully in time and page totals — only ratio statistics skip them.
export const SPEED_MIN_SESSION_MINUTES = 5;
export const SPEED_MAX_PAGES_PER_HOUR = 150;
// A book's own pace is only meaningful with at least an hour on the clock.
export const BOOK_SPEED_MIN_MINUTES = 60;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const sessionDate = (session) => session.createdAt?.toDate?.() ?? null;

const isReading = (session) => session.type === 'reading';

export function qualifiesForSpeed(session) {
  if (!isReading(session)) return false;
  const minutes = session.timeRead || 0;
  if (minutes < SPEED_MIN_SESSION_MINUTES) return false;
  return (session.pagesRead || 0) / (minutes / 60) <= SPEED_MAX_PAGES_PER_HOUR;
}

const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Inclusive calendar-day span: a book started and finished on the same
// (3 AM-shifted) day reads as 1 day.
const calendarDaySpan = (firstAt, lastAt) => {
  const first = shiftedDay(firstAt);
  const last = shiftedDay(lastAt);
  const firstMidnight = new Date(first.getFullYear(), first.getMonth(), first.getDate());
  const lastMidnight = new Date(last.getFullYear(), last.getMonth(), last.getDate());
  return Math.round((lastMidnight - firstMidnight) / MS_PER_DAY) + 1;
};

// Per-book activity spans from every update type: Map<bookId,
// {firstAt, lastAt, activeDays, totalMinutes, totalPages, sessionCount}>.
// The backbone for finish dates, days-to-finish, the dusty shelf, and
// finish projections.
export function buildBookTimelines(sessions) {
  const timelines = new Map();

  sessions.forEach((session) => {
    const date = sessionDate(session);
    const bookId = session.book?.id;
    if (!date || !bookId) return;

    if (!timelines.has(bookId)) {
      timelines.set(bookId, {
        firstAt: date,
        lastAt: date,
        activeDayKeys: new Set(),
        totalMinutes: 0,
        totalPages: 0,
        sessionCount: 0,
      });
    }
    const timeline = timelines.get(bookId);
    if (date < timeline.firstAt) timeline.firstAt = date;
    if (date > timeline.lastAt) timeline.lastAt = date;
    timeline.activeDayKeys.add(dayKeyOf(shiftedDay(date)));
    timeline.totalMinutes += session.timeRead || 0;
    timeline.totalPages += session.pagesRead || 0;
    timeline.sessionCount += 1;
  });

  timelines.forEach((timeline) => {
    timeline.activeDays = timeline.activeDayKeys.size;
    delete timeline.activeDayKeys;
  });

  return timelines;
}

// Session-derived finish dates for finished books: the last update of any
// type. Books with no update docs are absent — callers fall back to
// createdAt (computeBooksByYear's default).
export function finishedAtByBook(allBooks, timelines) {
  const finishedAt = new Map();
  allBooks.forEach((book) => {
    const timeline = timelines.get(book.id);
    if (book.finished && timeline) finishedAt.set(book.id, timeline.lastAt);
  });
  return finishedAt;
}

// Contiguous calendar months from the first session to the last, each with
// page/time totals, distinct books touched, and aggregate speed over the
// qualifying sessions. Zero-activity months are present (pages 0, speed
// null) so charts show gaps honestly instead of splicing them out.
// Months with under an hour of qualifying time also get pagesPerHour null:
// a lone short session makes a jittery, meaningless ratio.
export function monthlyAggregates(sessions) {
  const byMonth = new Map();

  sessions.filter(isReading).forEach((session) => {
    const date = sessionDate(session);
    if (!date) return;
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (!byMonth.has(month)) {
      byMonth.set(month, {
        month,
        pages: 0,
        minutes: 0,
        sessions: 0,
        bookIds: new Set(),
        speedPages: 0,
        speedMinutes: 0,
      });
    }
    const entry = byMonth.get(month);
    entry.pages += session.pagesRead || 0;
    entry.minutes += session.timeRead || 0;
    entry.sessions += 1;
    if (session.book?.id) entry.bookIds.add(session.book.id);
    if (qualifiesForSpeed(session)) {
      entry.speedPages += session.pagesRead || 0;
      entry.speedMinutes += session.timeRead || 0;
    }
  });

  if (byMonth.size === 0) return [];

  const monthKeys = [...byMonth.keys()].sort();
  const [firstYear, firstMonth] = monthKeys[0].split('-').map(Number);
  const [lastYear, lastMonth] = monthKeys.at(-1).split('-').map(Number);

  const months = [];
  for (let year = firstYear, month = firstMonth; year < lastYear || (year === lastYear && month <= lastMonth); ) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const entry = byMonth.get(key);
    months.push({
      month: key,
      label: new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
      year,
      pages: entry?.pages ?? 0,
      minutes: entry?.minutes ?? 0,
      sessions: entry?.sessions ?? 0,
      books: entry?.bookIds.size ?? 0,
      pagesPerHour:
        entry && entry.speedMinutes >= 60
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

// Lifetime aggregate speed over qualifying sessions, for the trend chart's
// reference line. Null with under an hour of qualifying time.
export function lifetimePagesPerHour(sessions) {
  let pages = 0;
  let minutes = 0;
  sessions.filter(qualifiesForSpeed).forEach((session) => {
    pages += session.pagesRead || 0;
    minutes += session.timeRead || 0;
  });
  return minutes >= 60 ? pages / (minutes / 60) : null;
}

// Minutes read by raw local start hour (0–23). Raw, not 3 AM-shifted: a
// 1 AM session belongs at 1 AM on the clock.
export function minutesByHour(sessions) {
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    minutes: 0,
    sessions: 0,
    speedPages: 0,
    speedMinutes: 0,
  }));

  sessions.filter(isReading).forEach((session) => {
    const date = sessionDate(session);
    if (!date) return;
    const entry = hours[date.getHours()];
    entry.minutes += session.timeRead || 0;
    entry.sessions += 1;
    if (qualifiesForSpeed(session)) {
      entry.speedPages += session.pagesRead || 0;
      entry.speedMinutes += session.timeRead || 0;
    }
  });

  return hours.map(({ hour, minutes, sessions: count, speedPages, speedMinutes }) => ({
    hour,
    minutes,
    sessions: count,
    pagesPerHour: speedMinutes >= 60 ? speedPages / (speedMinutes / 60) : null,
  }));
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Minutes read by weekday, Monday-first, on 3 AM-shifted days so a
// Friday-midnight session counts as Friday like it does on the heatmap.
export function minutesByWeekday(sessions) {
  const weekdays = WEEKDAY_LABELS.map((label) => ({
    label,
    minutes: 0,
    sessions: 0,
    speedPages: 0,
    speedMinutes: 0,
  }));

  sessions.filter(isReading).forEach((session) => {
    const date = sessionDate(session);
    if (!date) return;
    const entry = weekdays[(shiftedDay(date).getDay() + 6) % 7];
    entry.minutes += session.timeRead || 0;
    entry.sessions += 1;
    if (qualifiesForSpeed(session)) {
      entry.speedPages += session.pagesRead || 0;
      entry.speedMinutes += session.timeRead || 0;
    }
  });

  return weekdays.map(({ label, minutes, sessions: count, speedPages, speedMinutes }) => ({
    label,
    minutes,
    sessions: count,
    pagesPerHour: speedMinutes >= 60 ? speedPages / (speedMinutes / 60) : null,
  }));
}

// Last-30-days pages/day against the lifetime average (pages over days
// since the first session). `now` is passed in, never read from the clock,
// so tests pin it.
export function computeMomentum(sessions, now) {
  const reading = sessions.filter(isReading).filter(sessionDate);
  if (reading.length === 0) return null;

  const firstAt = reading.reduce(
    (earliest, s) => (sessionDate(s) < earliest ? sessionDate(s) : earliest),
    sessionDate(reading[0])
  );
  const lifetimeDays = Math.max(1, (now - firstAt) / MS_PER_DAY);
  const lifetimePages = reading.reduce((sum, s) => sum + (s.pagesRead || 0), 0);

  const windowStart = new Date(now - 30 * MS_PER_DAY);
  const recentPages = reading
    .filter((s) => sessionDate(s) >= windowStart)
    .reduce((sum, s) => sum + (s.pagesRead || 0), 0);

  const lifetimePagesPerDay = lifetimePages / lifetimeDays;
  const recentPagesPerDay = recentPages / 30;
  return {
    recentPagesPerDay,
    lifetimePagesPerDay,
    ratio: lifetimePagesPerDay > 0 ? recentPagesPerDay / lifetimePagesPerDay : null,
  };
}

// One-off records: the biggest day, the longest single sitting, the median
// session, and the fastest cover-to-cover finish.
export function computeSuperlatives(sessions, allBooks, timelines) {
  const reading = sessions.filter(isReading).filter(sessionDate);
  if (reading.length === 0) return null;

  const pagesByDay = new Map();
  reading.forEach((session) => {
    const day = dayKeyOf(shiftedDay(sessionDate(session)));
    pagesByDay.set(day, (pagesByDay.get(day) || 0) + (session.pagesRead || 0));
  });
  let biggestDay = null;
  pagesByDay.forEach((pages, day) => {
    if (!biggestDay || pages > biggestDay.pages) biggestDay = { day, pages };
  });

  const titleById = new Map(allBooks.map((book) => [book.id, book.title]));
  let longestSession = null;
  reading.forEach((session) => {
    const minutes = session.timeRead || 0;
    if (!longestSession || minutes > longestSession.minutes) {
      longestSession = {
        minutes,
        title: titleById.get(session.book?.id) ?? null,
        date: sessionDate(session),
      };
    }
  });

  const medianSessionMinutes = median(reading.map((s) => s.timeRead || 0));

  let fastestFinish = null;
  allBooks.filter((book) => book.finished).forEach((book) => {
    const timeline = timelines.get(book.id);
    if (!timeline || timeline.sessionCount < 2) return;
    const days = calendarDaySpan(timeline.firstAt, timeline.lastAt);
    if (!fastestFinish || days < fastestFinish.days) {
      fastestFinish = { title: book.title, days, pageCount: book.pageCount };
    }
  });

  return { biggestDay, longestSession, medianSessionMinutes, fastestFinish };
}

// "Median finish: N calendar days, active on M of them" over finished
// books with at least two sessions.
export function daysToFinishSummary(allBooks, timelines) {
  const spans = [];
  const activeDays = [];
  allBooks.filter((book) => book.finished).forEach((book) => {
    const timeline = timelines.get(book.id);
    if (!timeline || timeline.sessionCount < 2) return;
    spans.push(calendarDaySpan(timeline.firstAt, timeline.lastAt));
    activeDays.push(timeline.activeDays);
  });
  if (spans.length === 0) return null;
  return {
    count: spans.length,
    medianDays: median(spans),
    medianActiveDays: median(activeDays),
  };
}

// Unfinished books by staleness, dustiest first. Books with no update docs
// fall back to updatedAt so a freshly added book doesn't look ancient.
export function dustyShelf(allBooks, timelines, now) {
  return allBooks
    .filter((book) => !book.finished)
    .map((book) => {
      const lastActivityAt =
        timelines.get(book.id)?.lastAt ?? book.updatedAt?.toDate?.() ?? null;
      return {
        title: book.title,
        lastActivityAt,
        daysSince: lastActivityAt ? Math.floor((now - lastActivityAt) / MS_PER_DAY) : null,
        percentComplete: book.pageCount > 0 ? Math.round((book.currentPage / book.pageCount) * 100) : 0,
      };
    })
    .sort((a, b) => (b.daysSince ?? -1) - (a.daysSince ?? -1));
}

// Share of started books (any update ever) that ended up finished.
export function completionRate(allBooks, timelines) {
  const started = allBooks.filter((book) => timelines.has(book.id));
  if (started.length === 0) return null;
  return started.filter((book) => book.finished).length / started.length;
}

// Projected finish dates for in-progress books: the book's own pace
// (pagesRead/timeRead, the AddReadingModal projection formula) times your
// recent reading time per day (all books, last 30 days). Books idle for
// over 60 days get projectedDate null — a projection from a dormant pace
// is fiction. Sorted soonest first, dormant books last (staleness order).
export function projectedFinishes(allBooks, timelines, sessions, now) {
  const windowStart = new Date(now - 30 * MS_PER_DAY);
  const recentMinutes = sessions
    .filter(isReading)
    .filter((s) => sessionDate(s) && sessionDate(s) >= windowStart)
    .reduce((sum, s) => sum + (s.timeRead || 0), 0);
  const minutesPerDay = recentMinutes / 30;

  const projections = allBooks
    .filter((book) => !book.finished)
    .map((book) => {
      const timeline = timelines.get(book.id);
      const remainingPages = Math.max(0, book.pageCount - book.currentPage);
      const active = timeline && (now - timeline.lastAt) / MS_PER_DAY <= 60;
      const pagesPerMinute =
        (book.timeRead || 0) > 0 ? (book.pagesRead || 0) / book.timeRead : 0;
      const projectable = active && minutesPerDay > 0 && pagesPerMinute > 0;
      return {
        title: book.title,
        remainingPages,
        percentComplete: book.pageCount > 0 ? Math.round((book.currentPage / book.pageCount) * 100) : 0,
        projectedDate: projectable
          ? new Date(now.getTime() + (remainingPages / (pagesPerMinute * minutesPerDay)) * MS_PER_DAY)
          : null,
      };
    });

  return projections.sort((a, b) => {
    if (a.projectedDate && b.projectedDate) return a.projectedDate - b.projectedDate;
    if (a.projectedDate) return -1;
    if (b.projectedDate) return 1;
    return 0;
  });
}

// Authors ranked by total hours across their books (book aggregates, so
// page-only updates and unfinished progress count). A multi-author book
// credits each listed author fully.
export function authorLeaderboard(allBooks, authors) {
  const nameById = new Map(authors.map((author) => [author.id, author.name]));
  const rows = new Map();

  allBooks.forEach((book) => {
    (book.authorIds ?? []).forEach((authorId) => {
      if (!rows.has(authorId)) {
        rows.set(authorId, {
          name: nameById.get(authorId) ?? authorId,
          books: 0,
          finishedBooks: 0,
          pages: 0,
          minutes: 0,
        });
      }
      const row = rows.get(authorId);
      row.books += 1;
      if (book.finished) row.finishedBooks += 1;
      row.pages += book.pagesRead || 0;
      row.minutes += book.timeRead || 0;
    });
  });

  return [...rows.values()].sort((a, b) => b.minutes - a.minutes);
}
