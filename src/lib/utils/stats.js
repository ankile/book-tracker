// Statistics derived from the full book list. Extracted from the Me page so
// the public-profile payload is computed by the same code the Me page
// displays — the shared /profiles/<username> link can never disagree with
// what the owner sees on their own screen.

// finishedAtByBookId (optional Map<bookId, Date>, see computeBooksByYear)
// upgrades finish dates from the createdAt fallback to session-derived.
export function computeStats(allBooks, finishedAtByBookId) {
  const finishedBooks = allBooks.filter(b => b.finished);
  const readingBooks = allBooks.filter(b => !b.finished);
  const totalTimeRead = allBooks.reduce((sum, book) => sum + (book.timeRead || 0), 0);
  const totalPagesRead = allBooks.reduce((sum, book) => sum + (book.pagesRead || 0), 0);

  // First/last finish dates, for the stat-card range subtexts and the
  // books-per-year denominator.
  const finishedDates = finishedBooks
    .map(b => finishedAtByBookId?.get(b.id) ?? b.createdAt?.toDate?.())
    .filter(Boolean)
    .sort((a, b) => a - b);
  const addedDates = allBooks
    .map(b => b.createdAt?.toDate?.())
    .filter(Boolean)
    .sort((a, b) => a - b);

  // Calculate books per year (from first finish date). Quantized to whole
  // days and floored at a month: this value is published to the profile
  // doc and compared by profilePayloadEqual, so it must be identical
  // across recomputes within a day — a continuously moving "now" would
  // make every listener echo look dirty and loop the profile sync. The
  // floor keeps a brand-new library from reporting thousands of books
  // per year off a minutes-old denominator.
  let booksPerYear = 0;
  if (finishedDates.length > 0) {
    const firstBook = finishedDates[0];
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yearsSinceFirst = Math.max(
      (today - firstBook) / (1000 * 60 * 60 * 24 * 365),
      1 / 12
    );
    booksPerYear = (finishedBooks.length / yearsSinceFirst).toFixed(1);
  }

  // Average time per finished book
  const avgTimePerBook = finishedBooks.length > 0
    ? Math.round(finishedBooks.reduce((sum, b) => sum + (b.timeRead || 0), 0) / finishedBooks.length)
    : 0;

  // Round total time read to nearest hour
  const totalTimeReadHours = Math.round(totalTimeRead / 60);

  return {
    totalBooks: allBooks.length,
    finishedBooks: finishedBooks.length,
    readingBooks: readingBooks.length,
    totalTimeRead,
    totalTimeReadHours,
    totalPagesRead,
    booksPerYear,
    avgTimePerBook,
    firstFinishedAt: finishedDates[0] ?? null,
    lastFinishedAt: finishedDates.at(-1) ?? null,
    firstBookAddedAt: addedDates[0] ?? null,
  };
}

// finishedAtByBookId is an optional Map<bookId, Date> of session-derived
// finish dates; without it a book's finish year falls back to createdAt
// (the pre-session-analytics behavior, still used by callers that have no
// session data at hand).
export function computeBooksByYear(allBooks, finishedAtByBookId) {
  const finishedBooks = allBooks.filter(b => b.finished);
  const yearData = {};

  finishedBooks.forEach(book => {
    const date = finishedAtByBookId?.get(book.id) ?? book.createdAt?.toDate?.();
    if (date) {
      const year = date.getFullYear();
      if (!yearData[year]) {
        yearData[year] = {
          count: 0,
          totalTimeRead: 0,
          totalPages: 0,
          longestBook: null,
          shortestBook: null,
          authorIds: new Set(),
        };
      }

      yearData[year].count += 1;
      yearData[year].totalTimeRead += book.timeRead || 0;
      yearData[year].totalPages += book.pagesRead || 0;
      (book.authorIds ?? []).forEach(id => yearData[year].authorIds.add(id));

      // Track longest and shortest books
      if (!yearData[year].longestBook || book.pageCount > yearData[year].longestBook.pageCount) {
        yearData[year].longestBook = book;
      }
      if (!yearData[year].shortestBook || book.pageCount < yearData[year].shortestBook.pageCount) {
        yearData[year].shortestBook = book;
      }
    }
  });

  // Authors first read in a given year, walked oldest-first so "new" means
  // never seen in any earlier year.
  const seenAuthors = new Set();
  const newAuthorsByYear = {};
  Object.keys(yearData)
    .sort((a, b) => a - b)
    .forEach((year) => {
      let newAuthors = 0;
      yearData[year].authorIds.forEach((id) => {
        if (!seenAuthors.has(id)) {
          seenAuthors.add(id);
          newAuthors += 1;
        }
      });
      newAuthorsByYear[year] = newAuthors;
    });

  return Object.entries(yearData)
    .sort(([a], [b]) => b - a)
    .map(([year, data]) => ({
      year,
      count: data.count,
      totalTimeRead: data.totalTimeRead,
      totalPages: data.totalPages,
      longestBook: data.longestBook,
      shortestBook: data.shortestBook,
      uniqueAuthors: data.authorIds.size,
      newAuthors: newAuthorsByYear[year],
    }));
}

// Day boundary offset: sessions before 3 AM count as the previous day.
// Extracted from ReadingHeatmap so the published per-day aggregates bucket
// sessions exactly the way the owner's own heatmap does.
export const DAY_BOUNDARY_OFFSET_HOURS = 3;

export const dayKeyOf = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

// A copy of the date shifted so the pre-3-AM hours belong to the previous
// day — every per-day bucketing (heatmap, streaks, session analytics)
// must go through this to agree on what "a day" is.
export const shiftedDay = (date) => {
  const shifted = new Date(date);
  shifted.setHours(shifted.getHours() - DAY_BOUNDARY_OFFSET_HOURS);
  return shifted;
};

// Collapse reading sessions into one entry per active day, ascending by
// day. This is both the heatmap's input and the `days` list published to
// the profile doc — per-day totals only, nothing per-session or per-book.
// Filters to type 'reading' itself: the sessions listener also carries
// page-only 'update' corrections (for finish dates), and those must never
// inflate the heatmap or the published day totals.
export function aggregateSessionsByDay(sessions) {
  const dayMap = new Map();

  sessions.forEach((session) => {
    if (session.type !== 'reading') return;
    const timestamp = session.createdAt?.toDate?.();
    if (!timestamp) return;

    const day = dayKeyOf(shiftedDay(timestamp));

    if (!dayMap.has(day)) {
      dayMap.set(day, { day, pagesRead: 0, timeRead: 0, sessions: 0 });
    }
    const entry = dayMap.get(day);
    entry.pagesRead += session.pagesRead || 0;
    entry.timeRead += session.timeRead || 0;
    entry.sessions += 1;
  });

  return [...dayMap.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

// Usernames are Firestore doc ids on a public collection, so the charset is
// locked down here and again in firestore.rules (same pattern, both places).
export const USERNAME_PATTERN = /^[a-z0-9-]{3,30}$/;

// The exact document body published to profiles/<username>: aggregate
// numbers only. Deliberately no book titles and no per-session data — the
// page is anonymous-readable, and opting in shares your stats, not your
// library. sessionDays is the aggregateSessionsByDay output feeding the
// public heatmap: per-day totals, clamped to the most recent entries so
// the doc respects the rules' list cap (and the 1 MiB doc limit) forever.
// booksPerYear is normalized to a number (computeStats returns the toFixed
// display string) so the stored field has one type for the rules and for
// the equality check below.
export const PROFILE_MAX_DAYS = 4000;

export function buildProfilePayload(allBooks, sessionDays = [], finishedAtByBookId) {
  const stats = computeStats(allBooks, finishedAtByBookId);
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
    },
    years: computeBooksByYear(allBooks, finishedAtByBookId).map(({ year, count, totalTimeRead, totalPages }) => ({
      year: Number(year),
      count,
      hours: Math.round(totalTimeRead / 60),
      pages: totalPages,
    })),
  };
}

// Field-by-field comparison of a published profile doc against a freshly
// built payload, used by the Me page to decide whether to rewrite the doc.
// updatedAt is deliberately excluded: it changes on every write, so
// including it would make the listener echo of our own write look dirty and
// loop forever.
export function profilePayloadEqual(published, payload) {
  if (!published || !Array.isArray(published.years) || !Array.isArray(published.days)) return false;
  const statKeys = Object.keys(payload.stats);
  return statKeys.every((key) => published.stats?.[key] === payload.stats[key])
    && published.years.length === payload.years.length
    && payload.years.every((year, i) =>
      ['year', 'count', 'hours', 'pages'].every((key) => published.years[i]?.[key] === year[key]))
    && published.days.length === payload.days.length
    && payload.days.every((day, i) =>
      ['day', 'pagesRead', 'timeRead', 'sessions'].every((key) => published.days[i]?.[key] === day[key]));
}
