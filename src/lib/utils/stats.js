// Statistics derived from the full book list. Extracted from the Me page so
// the public-profile payload is computed by the same code the Me page
// displays — the shared /profiles/<username> link can never disagree with
// what the owner sees on their own screen.

export function computeStats(allBooks) {
  const finishedBooks = allBooks.filter(b => b.finished);
  const readingBooks = allBooks.filter(b => !b.finished);
  const totalTimeRead = allBooks.reduce((sum, book) => sum + (book.timeRead || 0), 0);
  const totalPagesRead = allBooks.reduce((sum, book) => sum + (book.pagesRead || 0), 0);

  // Calculate books per year (from first book created date)
  let booksPerYear = 0;
  if (finishedBooks.length > 0) {
    const dates = finishedBooks
      .map(b => b.createdAt?.toDate?.() || new Date())
      .sort((a, b) => a - b);
    const firstBook = dates[0];
    const yearsSinceFirst = (new Date() - firstBook) / (1000 * 60 * 60 * 24 * 365);
    booksPerYear = yearsSinceFirst > 0 ? (finishedBooks.length / yearsSinceFirst).toFixed(1) : 0;
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
  };
}

export function computeBooksByYear(allBooks) {
  const finishedBooks = allBooks.filter(b => b.finished);
  const yearData = {};

  finishedBooks.forEach(book => {
    const date = book.createdAt?.toDate?.();
    if (date) {
      const year = date.getFullYear();
      if (!yearData[year]) {
        yearData[year] = {
          count: 0,
          totalTimeRead: 0,
          totalPages: 0,
          longestBook: null,
        };
      }

      yearData[year].count += 1;
      yearData[year].totalTimeRead += book.timeRead || 0;
      yearData[year].totalPages += book.pagesRead || 0;

      // Track longest book
      if (!yearData[year].longestBook || book.pageCount > yearData[year].longestBook.pageCount) {
        yearData[year].longestBook = book;
      }
    }
  });

  return Object.entries(yearData)
    .sort(([a], [b]) => b - a)
    .map(([year, data]) => ({
      year,
      count: data.count,
      totalTimeRead: data.totalTimeRead,
      totalPages: data.totalPages,
      longestBook: data.longestBook,
    }));
}

// Usernames are Firestore doc ids on a public collection, so the charset is
// locked down here and again in firestore.rules (same pattern, both places).
export const USERNAME_PATTERN = /^[a-z0-9-]{3,30}$/;

// The exact document body published to profiles/<username>: aggregate
// numbers only. Deliberately no book titles and no per-session data — the
// page is anonymous-readable, and opting in shares your stats, not your
// library. booksPerYear is normalized to a number (computeStats returns the
// toFixed display string) so the stored field has one type for the rules
// and for the equality check below.
export function buildProfilePayload(allBooks) {
  const stats = computeStats(allBooks);
  return {
    stats: {
      totalBooks: stats.totalBooks,
      finishedBooks: stats.finishedBooks,
      readingBooks: stats.readingBooks,
      totalTimeReadHours: stats.totalTimeReadHours,
      totalPagesRead: stats.totalPagesRead,
      booksPerYear: Number(stats.booksPerYear),
      avgTimePerBook: stats.avgTimePerBook,
    },
    years: computeBooksByYear(allBooks).map(({ year, count, totalTimeRead, totalPages }) => ({
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
  if (!published || !Array.isArray(published.years)) return false;
  const statKeys = Object.keys(payload.stats);
  return statKeys.every((key) => published.stats?.[key] === payload.stats[key])
    && published.years.length === payload.years.length
    && payload.years.every((year, i) =>
      ['year', 'count', 'hours', 'pages'].every((key) => published.years[i]?.[key] === year[key]));
}
